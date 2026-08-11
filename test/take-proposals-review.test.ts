import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const tempDirs: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeSourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-take-proposals-'));
  tempDirs.push(dir);
  return dir;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

async function addSource(id: string, localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path)
     VALUES ($1, $2, $3)`,
    [id, id, localPath],
  );
}

async function seedProposal(opts: {
  sourceId: string;
  sourceDir: string;
  slug: string;
  claim: string;
  holder?: string;
}): Promise<number> {
  const sourcePath = join(opts.sourceDir, `${opts.slug}.md`);
  const body = `# Review fixture\n\n${opts.claim}\n\nThis page is deliberately ordinary test evidence.\n`;
  const parent = join(opts.sourceDir, opts.slug.split('/').slice(0, -1).join('/'));
  if (parent !== opts.sourceDir) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(sourcePath, body, 'utf8');
  const page = await engine.putPage(opts.slug, {
    title: 'Review fixture',
    type: 'analysis',
    compiled_truth: body.trim(),
    frontmatter: {},
    timeline: '',
  }, { sourceId: opts.sourceId });
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (
       source_id, page_slug, content_hash, prompt_version, proposal_run_id,
       claim_text, kind, holder, weight, model_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      opts.sourceId,
      opts.slug,
      sha256(page.compiled_truth),
      'test-prompt-v1',
      'test-run-1',
      opts.claim,
      'take',
      opts.holder ?? 'brain',
      0.7,
      'test:model',
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('takes proposal review surface', () => {
  test('lists pending proposals through the CLI and source-scoped API with evidence and provenance', async () => {
    const reviewDir = makeSourceDir();
    const otherDir = makeSourceDir();
    await addSource('review-source', reviewDir);
    await addSource('other-source', otherDir);
    const proposalId = await seedProposal({
      sourceId: 'review-source', sourceDir: reviewDir, slug: 'notes/review', claim: 'The review flow needs an explicit human decision.',
    });
    await seedProposal({
      sourceId: 'review-source', sourceDir: reviewDir, slug: 'notes/private', claim: 'Private holder proposal.', holder: 'people/private' });
    await seedProposal({
      sourceId: 'other-source', sourceDir: otherDir, slug: 'notes/other', claim: 'Other source proposal.' });

    await withEnv({ GBRAIN_SOURCE: 'review-source' }, async () => {
      const cli = await captureStdout(() => runTakes(engine, ['proposals', '--json']));
      const listed = JSON.parse(cli) as Array<Record<string, unknown>>;
      expect(listed).toHaveLength(2);
      expect(listed.map(row => row.id)).toContain(proposalId);
      const proposal = listed.find(row => row.id === proposalId)!;
      expect(proposal.source_id).toBe('review-source');
      expect(proposal.page_slug).toBe('notes/review');
      expect(proposal.model_id).toBe('test:model');
      expect(proposal.evidence).toMatchObject({ status: 'current', page_present: true });
      expect((proposal.evidence as { excerpt?: string }).excerpt).toContain('explicit human decision');
    });

    const api = await dispatchToolCall(engine, 'takes_proposals_list', { status: 'pending' }, {
      remote: true,
      sourceId: 'review-source',
      takesHoldersAllowList: ['brain'],
    });
    expect(api.isError).toBeFalsy();
    const listed = JSON.parse(api.content[0]!.text) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(proposalId);
    expect(listed[0]!.source_id).toBe('review-source');
  });

  test('accept promotes one current, source-owned proposal and is idempotent', async () => {
    const sourceDir = makeSourceDir();
    await addSource('review-source', sourceDir);
    const proposalId = await seedProposal({
      sourceId: 'review-source', sourceDir, slug: 'notes/accept', claim: 'A reviewer accepted this proposal.',
    });

    await withEnv({ GBRAIN_SOURCE: 'review-source' }, async () => {
      await runTakes(engine, ['accept', String(proposalId), '--by', 'reviewer']);
      await runTakes(engine, ['accept', String(proposalId), '--by', 'reviewer']);
    });

    const proposalRows = await engine.executeRaw<{
      status: string;
      acted_by: string | null;
      acted_at: string | null;
      promoted_row_num: number | null;
    }>(
      `SELECT status, acted_by, acted_at, promoted_row_num
         FROM take_proposals WHERE id = $1`,
      [proposalId],
    );
    expect(proposalRows[0]).toMatchObject({ status: 'accepted', acted_by: 'reviewer', promoted_row_num: 1 });
    expect(proposalRows[0]!.acted_at).toBeTruthy();

    const takes = await engine.listTakes({ page_slug: 'notes/accept', sourceId: 'review-source' });
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ claim: 'A reviewer accepted this proposal.', row_num: 1, source: `proposal:${proposalId}` });
    expect(readFileSync(join(sourceDir, 'notes/accept.md'), 'utf8')).toContain(`proposal:${proposalId}`);
  });

  test('reject records the reviewer decision without promoting a canonical take', async () => {
    const sourceDir = makeSourceDir();
    await addSource('review-source', sourceDir);
    const proposalId = await seedProposal({
      sourceId: 'review-source', sourceDir, slug: 'notes/reject', claim: 'This proposal should not be promoted.',
    });

    await withEnv({ GBRAIN_SOURCE: 'review-source' }, async () => {
      await runTakes(engine, ['reject', String(proposalId), '--by', 'reviewer']);
      await runTakes(engine, ['reject', String(proposalId), '--by', 'reviewer']);
    });

    const rows = await engine.executeRaw<{ status: string; acted_by: string | null; promoted_row_num: number | null }>(
      `SELECT status, acted_by, promoted_row_num FROM take_proposals WHERE id = $1`,
      [proposalId],
    );
    expect(rows[0]).toEqual({ status: 'rejected', acted_by: 'reviewer', promoted_row_num: null });
    expect(await engine.listTakes({ page_slug: 'notes/reject', sourceId: 'review-source' })).toEqual([]);
  });

  test('keeps the bootstrap boundary disabled without invoking extraction work', async () => {
    const result = await extractTakesFromPages(engine, { bootstrapEnabled: false });
    expect(result).toEqual({
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: true,
      llm_unavailable: false,
    });
  });
});

// 2026-08-11: takes_proposal_create — the Claude-operator entry into the
// review queue. Hash is stamped server-side; identical claims dedupe.
describe('createTakeProposal', () => {
  test('creates a pending proposal with server-side content hash, dedupes repeats, validates kind', async () => {
    const { createTakeProposal } = await import('../src/core/take-proposals.ts');
    const dir = makeSourceDir();
    await addSource('cm-test', dir);
    const body = '# Fixture\n\nProse that grounds a gradeable claim about the future.';
    await engine.putPage('memory/fixture-page', {
      title: 'Fixture', type: 'analysis', compiled_truth: body, frontmatter: {}, timeline: '',
    }, { sourceId: 'cm-test' });

    const first = await createTakeProposal(engine, {
      sourceId: 'cm-test', pageSlug: 'memory/fixture-page',
      claimText: 'This fixture claim will resolve true within a year',
      kind: 'prediction', holder: 'brain', weight: 0.6,
    });
    expect(first.id).not.toBeNull();
    expect(first.deduped).toBe(false);
    expect(first.content_hash).toBe(sha256(body));

    const repeat = await createTakeProposal(engine, {
      sourceId: 'cm-test', pageSlug: 'memory/fixture-page',
      claimText: 'This fixture claim will resolve true within a year',
      kind: 'prediction', holder: 'brain', weight: 0.6,
    });
    expect(repeat.id).toBeNull();
    expect(repeat.deduped).toBe(true);

    await expect(createTakeProposal(engine, {
      sourceId: 'cm-test', pageSlug: 'memory/fixture-page',
      claimText: 'A claim with an unknown kind should be rejected loudly',
      kind: 'conjecture', holder: 'brain', weight: 0.6,
    })).rejects.toThrow(/Invalid proposal kind/);

    await expect(createTakeProposal(engine, {
      sourceId: 'cm-test', pageSlug: 'memory/absent-page',
      claimText: 'A claim against a page that does not exist in the source',
      kind: 'judgment', holder: 'brain', weight: 0.6,
    })).rejects.toThrow(/was not found in source/);

    const proposals = await (await import('../src/core/take-proposals.ts')).listTakeProposals(engine, {
      sourceId: 'cm-test', redactPrivateEvidence: false,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.evidence.status).toBe('current');
  });
});
