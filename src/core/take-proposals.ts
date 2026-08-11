/**
 * Reviewed take-proposal queue helpers.
 *
 * Proposals are not canonical takes. The queue records model output and its
 * provenance; only the local CLI may promote one after it has updated the
 * source Markdown fence. Remote callers get a source- and holder-scoped,
 * read-only review surface.
 */

import { createHash } from 'node:crypto';
import { clampSearchLimit, type BrainEngine, type TakeKind } from './engine.ts';
import { stripFactsFence } from './facts-fence.ts';
import { stripTakesFence } from './takes-fence.ts';

export const TAKE_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'superseded'] as const;
export type TakeProposalStatus = typeof TAKE_PROPOSAL_STATUSES[number];

const EVIDENCE_EXCERPT_LIMIT = 600;

export interface TakeProposalEvidence {
  /** Whether the source page is missing, changed since proposal, or current in the DB. */
  status: 'missing' | 'stale' | 'current';
  page_present: boolean;
  current_content_hash: string | null;
  /** A bounded inspection aid, not a claim-level quotation guarantee. */
  excerpt: string | null;
  excerpt_truncated: boolean;
}

export interface TakeProposal {
  id: number;
  source_id: string;
  page_slug: string;
  content_hash: string;
  prompt_version: string;
  wave_version: string;
  proposed_at: string;
  proposal_run_id: string;
  status: TakeProposalStatus;
  claim_text: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  domain: string | null;
  dedup_against_fence_rows: unknown;
  model_id: string;
  acted_at: string | null;
  acted_by: string | null;
  promoted_row_num: number | null;
  page_id: number | null;
  evidence: TakeProposalEvidence;
}

export interface TakeProposalListOpts {
  proposalId?: number;
  status?: TakeProposalStatus;
  /** Exact lookups need audit history; normal list calls default to pending. */
  allStatuses?: boolean;
  limit?: number;
  offset?: number;
  sourceId?: string;
  sourceIds?: string[];
  /** Mirrors the takes-holder grant on the remote MCP boundary. */
  takesHoldersAllowList?: string[];
  /** Remote review excerpts obey the same takes/facts fence redaction as get_page. */
  redactPrivateEvidence?: boolean;
}

interface ProposalRow {
  id: number | string;
  source_id: string;
  page_slug: string;
  content_hash: string;
  prompt_version: string;
  wave_version: string | null;
  proposed_at: string | Date;
  proposal_run_id: string;
  status: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number | string;
  domain: string | null;
  dedup_against_fence_rows: unknown;
  model_id: string;
  acted_at: string | Date | null;
  acted_by: string | null;
  promoted_row_num: number | string | null;
  page_id: number | string | null;
  page_body: string | null;
}

interface ProposalActionRow {
  status: TakeProposalStatus;
  promoted_row_num: number | string | null;
}

export class TakeProposalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TakeProposalActionError';
  }
}

export function takeProposalContentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function isTakeProposalStatus(value: unknown): value is TakeProposalStatus {
  return typeof value === 'string' && (TAKE_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

function timestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function excerpt(body: string | null, redactPrivateEvidence: boolean): {
  excerpt: string | null;
  truncated: boolean;
} {
  if (body === null) return { excerpt: null, truncated: false };
  const visible = redactPrivateEvidence
    ? stripFactsFence(stripTakesFence(body), { keepVisibility: ['world'] })
    : body;
  const compact = visible.trim();
  if (compact.length <= EVIDENCE_EXCERPT_LIMIT) return { excerpt: compact || null, truncated: false };
  return { excerpt: `${compact.slice(0, EVIDENCE_EXCERPT_LIMIT)}…`, truncated: true };
}

function rowToProposal(row: ProposalRow, redactPrivateEvidence: boolean): TakeProposal {
  const currentContentHash = row.page_body === null ? null : takeProposalContentHash(row.page_body);
  const evidenceExcerpt = excerpt(row.page_body, redactPrivateEvidence);
  const evidenceStatus = row.page_id === null
    ? 'missing'
    : currentContentHash === row.content_hash
      ? 'current'
      : 'stale';
  if (!isTakeProposalStatus(row.status)) {
    throw new Error(`take_proposals row ${row.id} has an unknown status`);
  }
  return {
    id: Number(row.id),
    source_id: row.source_id,
    page_slug: row.page_slug,
    content_hash: row.content_hash,
    prompt_version: row.prompt_version,
    wave_version: row.wave_version ?? 'unknown',
    proposed_at: timestamp(row.proposed_at) ?? '',
    proposal_run_id: row.proposal_run_id,
    status: row.status,
    claim_text: row.claim_text,
    kind: row.kind,
    holder: row.holder,
    weight: Number(row.weight),
    domain: row.domain,
    dedup_against_fence_rows: parseJson(row.dedup_against_fence_rows),
    model_id: row.model_id,
    acted_at: timestamp(row.acted_at),
    acted_by: row.acted_by,
    promoted_row_num: row.promoted_row_num === null ? null : Number(row.promoted_row_num),
    page_id: row.page_id === null ? null : Number(row.page_id),
    evidence: {
      status: evidenceStatus,
      page_present: row.page_id !== null,
      current_content_hash: currentContentHash,
      excerpt: evidenceExcerpt.excerpt,
      excerpt_truncated: evidenceExcerpt.truncated,
    },
  };
}

/**
 * Lists proposal records joined to their current source page. The join is on
 * `(source_id, slug)` so same-slug rows in neighboring sources never become
 * review evidence for one another.
 */
export async function listTakeProposals(
  engine: BrainEngine,
  opts: TakeProposalListOpts = {},
): Promise<TakeProposal[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const status = opts.allStatuses ? undefined : (opts.status ?? 'pending');
  if (opts.proposalId !== undefined) {
    params.push(opts.proposalId);
    where.push(`tp.id = $${params.length}`);
  }
  if (status !== undefined) {
    params.push(status);
    where.push(`tp.status = $${params.length}`);
  }
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    where.push(`tp.source_id = ANY($${params.length}::text[])`);
  } else if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`tp.source_id = $${params.length}`);
  }
  if (opts.takesHoldersAllowList !== undefined) {
    params.push(opts.takesHoldersAllowList);
    where.push(`tp.holder = ANY($${params.length}::text[])`);
  }
  const limit = clampSearchLimit(opts.limit, 100, 500);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  params.push(limit, offset);
  const rows = await engine.executeRaw<ProposalRow>(
    `SELECT tp.id, tp.source_id, tp.page_slug, tp.content_hash, tp.prompt_version,
            tp.wave_version, tp.proposed_at, tp.proposal_run_id, tp.status,
            tp.claim_text, tp.kind, tp.holder, tp.weight, tp.domain,
            tp.dedup_against_fence_rows, tp.model_id, tp.acted_at, tp.acted_by,
            tp.promoted_row_num, p.id AS page_id, p.compiled_truth AS page_body
       FROM take_proposals tp
       LEFT JOIN pages p
         ON p.source_id = tp.source_id
        AND p.slug = tp.page_slug
        AND p.deleted_at IS NULL
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY tp.proposed_at DESC, tp.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(row => rowToProposal(row, opts.redactPrivateEvidence === true));
}

export async function getTakeProposal(
  engine: BrainEngine,
  proposalId: number,
  sourceId: string,
): Promise<TakeProposal | null> {
  const rows = await listTakeProposals(engine, {
    proposalId,
    sourceId,
    allStatuses: true,
    limit: 1,
  });
  return rows[0] ?? null;
}

async function actionState(
  engine: BrainEngine,
  proposalId: number,
  sourceId: string,
): Promise<ProposalActionRow | null> {
  const rows = await engine.executeRaw<ProposalActionRow>(
    `SELECT status, promoted_row_num
       FROM take_proposals
      WHERE id = $1 AND source_id = $2`,
    [proposalId, sourceId],
  );
  return rows[0] ?? null;
}

function actionFailure(proposalId: number, sourceId: string, current: ProposalActionRow | null): never {
  if (!current) {
    throw new TakeProposalActionError(`Proposal #${proposalId} was not found in source '${sourceId}'.`);
  }
  throw new TakeProposalActionError(
    `Proposal #${proposalId} is already ${current.status}; a pending proposal is required for this action.`,
  );
}

export interface AcceptTakeProposalInput {
  proposal: TakeProposal;
  actedBy: string;
  promotedRowNum: number;
  /** The source pointer written into the canonical Markdown and derived index. */
  takeSource: string;
}

export interface TakeProposalActionResult {
  state: 'accepted' | 'rejected' | 'already_accepted' | 'already_rejected';
  promoted_row_num: number | null;
}

/**
 * Atomically marks a pending proposal accepted and writes its derived take
 * index row. The caller must update canonical Markdown first; if this DB
 * transaction fails, the Markdown remains the recoverable source of truth.
 */
export async function acceptTakeProposal(
  engine: BrainEngine,
  input: AcceptTakeProposalInput,
): Promise<TakeProposalActionResult> {
  const { proposal } = input;
  const pageId = proposal.page_id;
  if (pageId === null) {
    throw new TakeProposalActionError(`Proposal #${proposal.id} has no current source page.`);
  }
  return engine.transaction(async tx => {
    const changed = await tx.executeRaw<{ id: number }>(
      `UPDATE take_proposals
          SET status = 'accepted', acted_at = now(), acted_by = $3,
              promoted_row_num = $4
        WHERE id = $1 AND source_id = $2 AND status = 'pending'
      RETURNING id`,
      [proposal.id, proposal.source_id, input.actedBy, input.promotedRowNum],
    );
    if (changed.length === 0) {
      const current = await actionState(tx, proposal.id, proposal.source_id);
      if (current?.status === 'accepted') {
        return {
          state: 'already_accepted',
          promoted_row_num: current.promoted_row_num === null ? null : Number(current.promoted_row_num),
        };
      }
      return actionFailure(proposal.id, proposal.source_id, current);
    }
    await tx.addTakesBatch([{
      page_id: pageId,
      row_num: input.promotedRowNum,
      claim: proposal.claim_text,
      kind: proposal.kind,
      holder: proposal.holder,
      weight: proposal.weight,
      source: input.takeSource,
      active: true,
      superseded_by: null,
    }]);
    return { state: 'accepted', promoted_row_num: input.promotedRowNum };
  });
}

/** Records an explicit rejection; a repeat rejection is a no-op. */
export async function rejectTakeProposal(
  engine: BrainEngine,
  opts: { proposalId: number; sourceId: string; actedBy: string },
): Promise<TakeProposalActionResult> {
  const changed = await engine.executeRaw<{ id: number }>(
    `UPDATE take_proposals
        SET status = 'rejected', acted_at = now(), acted_by = $3
      WHERE id = $1 AND source_id = $2 AND status = 'pending'
    RETURNING id`,
    [opts.proposalId, opts.sourceId, opts.actedBy],
  );
  if (changed.length > 0) return { state: 'rejected', promoted_row_num: null };
  const current = await actionState(engine, opts.proposalId, opts.sourceId);
  if (current?.status === 'rejected') return { state: 'already_rejected', promoted_row_num: null };
  return actionFailure(opts.proposalId, opts.sourceId, current);
}

/**
 * Kinds a take PROPOSAL may carry. Mirrors the propose_takes cycle enum
 * ('prediction' | 'judgment' | 'bet'); the fence parser reads the union of
 * these and the fence seed kinds (see takes-fence.ts KIND_VALUES).
 */
export const TAKE_PROPOSAL_KINDS = ['prediction', 'judgment', 'bet'] as const;
export type TakeProposalKind = typeof TAKE_PROPOSAL_KINDS[number];

export function isTakeProposalKind(value: unknown): value is TakeProposalKind {
  return typeof value === 'string' && (TAKE_PROPOSAL_KINDS as readonly string[]).includes(value);
}

export interface CreateTakeProposalInput {
  sourceId: string;
  pageSlug: string;
  claimText: string;
  kind: string;
  holder: string;
  weight: number;
  domain?: string | null;
  promptVersion?: string;
  proposalRunId?: string;
  modelId?: string;
}

export interface CreateTakeProposalResult {
  /** null when an identical proposal already exists for the current page content. */
  id: number | null;
  deduped: boolean;
  page_slug: string;
  content_hash: string;
}

/**
 * Insert one reviewed-queue proposal against the CURRENT indexed content of
 * a page. The content hash is computed server-side from the page's
 * `compiled_truth`, so a fresh proposal always starts with evidence
 * `current`; callers cannot fabricate a hash. Idempotent on
 * (source_id, page_slug, content_hash, prompt_version, md5(claim_text)).
 * Writes ONLY to the review queue — never to canonical takes or Markdown.
 */
export async function createTakeProposal(
  engine: BrainEngine,
  input: CreateTakeProposalInput,
): Promise<CreateTakeProposalResult> {
  if (!isTakeProposalKind(input.kind)) {
    throw new TakeProposalActionError(
      `Invalid proposal kind '${input.kind}'. Expected ${TAKE_PROPOSAL_KINDS.join(', ')}.`,
    );
  }
  const claim = input.claimText.trim();
  if (claim.length < 10 || claim.length > 500) {
    throw new TakeProposalActionError('Proposal claim_text must be between 10 and 500 characters.');
  }
  const holder = input.holder.trim();
  if (holder.length === 0 || holder.length > 120) {
    throw new TakeProposalActionError('Proposal holder is required (max 120 characters).');
  }
  if (!Number.isFinite(input.weight) || input.weight <= 0 || input.weight > 1) {
    throw new TakeProposalActionError('Proposal weight must be in (0, 1].');
  }
  const pages = await engine.executeRaw<{ id: number; compiled_truth: string }>(
    `SELECT id, compiled_truth FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [input.sourceId, input.pageSlug],
  );
  if (pages.length === 0) {
    throw new TakeProposalActionError(
      `Page '${input.pageSlug}' was not found in source '${input.sourceId}'.`,
    );
  }
  const contentHash = takeProposalContentHash(pages[0].compiled_truth ?? '');
  const inserted = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, $11)
     ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING
     RETURNING id`,
    [
      input.sourceId,
      input.pageSlug,
      contentHash,
      input.promptVersion ?? 'operator-claude-v1',
      input.proposalRunId ?? `operator-${new Date().toISOString().slice(0, 10)}`,
      claim,
      input.kind,
      holder,
      input.weight,
      input.domain ?? null,
      input.modelId ?? 'claude-operator',
    ],
  );
  const id = inserted.length > 0 ? Number(inserted[0].id) : null;
  return { id, deduped: id === null, page_slug: input.pageSlug, content_hash: contentHash };
}
