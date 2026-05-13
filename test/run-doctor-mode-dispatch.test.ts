/**
 * Pins the `run_doctor` MCP op dispatcher contract:
 *   - default mode = deep → calls doctorReportRemote (full check set)
 *   - mode: 'fast'        → calls doctorReportFast (FS-only, no DB)
 *
 * The fast branch is the v0.33.x addition for thin-clients that need a
 * cheap liveness probe (e.g. after WAL recovery while PGLite is still
 * settling). Asserts the returned DoctorReport shape distinguishes the
 * two modes by presence of DB-only checks (`schema_version`, `brain_score`,
 * `queue_health`) — those exist in deep mode and are absent in fast.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { DoctorReport } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function unpack(result: { content: { text: string }[] }): DoctorReport {
  return JSON.parse(result.content[0].text) as DoctorReport;
}

describe('run_doctor mode dispatch', () => {
  test('default (no mode) → deep report with DB-touching checks', async () => {
    const r = await dispatchToolCall(engine, 'run_doctor', {}, {
      remote: false,
      sourceId: 'default',
    });
    const report = unpack(r);
    const names = report.checks.map(c => c.name);
    expect(names).toContain('connection');
    expect(names).toContain('schema_version');
    expect(names).toContain('brain_score');
  });

  test('mode: "deep" explicit → same as default', async () => {
    const r = await dispatchToolCall(engine, 'run_doctor', { mode: 'deep' }, {
      remote: false,
      sourceId: 'default',
    });
    const report = unpack(r);
    const names = report.checks.map(c => c.name);
    expect(names).toContain('schema_version');
  });

  test('mode: "fast" → FS-only report, no DB-touching checks', async () => {
    const r = await dispatchToolCall(engine, 'run_doctor', { mode: 'fast' }, {
      remote: false,
      sourceId: 'default',
    });
    const report = unpack(r);
    expect(report.schema_version).toBe(2);

    const names = report.checks.map(c => c.name);
    // Fast mode MUST NOT include DB-touching checks.
    expect(names).not.toContain('connection');
    expect(names).not.toContain('schema_version');
    expect(names).not.toContain('brain_score');
    expect(names).not.toContain('queue_health');

    // resolver_health is always emitted (warn if no skills dir found in the
    // test environment, ok if one is detected). Either way it's present.
    expect(names).toContain('resolver_health');
  });
});
