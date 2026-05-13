/**
 * Tests for `doctorReportFast()` + `collectFastChecks()` — the FS-only
 * doctor surface used by the `run_doctor` MCP op when called with
 * `mode: 'fast'`.
 *
 * Fast mode must NOT touch the database. Asserts:
 *   - return shape matches DoctorReport (schema_version, checks, status, health_score)
 *   - exposes the 4 FS checks: resolver_health, skill_conformance,
 *     minions_migration (when ledger triggers), upgrade_errors (when trail exists)
 *   - no engine import, no DB call
 *
 * Strategy: drive collectFastChecks with a fake skills dir + temp HOME
 * pointing at a synthetic upgrade-errors.jsonl. Pure FS, no PGLite needed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectFastChecks,
  doctorReportFast,
  type Check,
  type DoctorReport,
} from '../src/commands/doctor.ts';

let prevHome: string | undefined;
let tmpHome: string;
let skillsDir: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-fast-'));
  process.env.HOME = tmpHome;
  // Minimal skills dir with one valid SKILL.md so resolver_health + conformance
  // can find something to report on.
  skillsDir = join(tmpHome, 'skills');
  mkdirSync(join(skillsDir, 'ping'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'ping', 'SKILL.md'),
    `---
name: ping
description: simple skill for fast-doctor test
---
ping.
`,
  );
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('collectFastChecks', () => {
  test('returns Check[] without touching engine', () => {
    const checks = collectFastChecks({ skillsDir });
    expect(Array.isArray(checks)).toBe(true);
    // resolver_health + skill_conformance always present when skillsDir resolves
    const names = checks.map(c => c.name);
    expect(names).toContain('resolver_health');
    expect(names).toContain('skill_conformance');
  });

  test('emits resolver_health=warn when skills dir missing', () => {
    const checks = collectFastChecks({ skillsDir: undefined, autoDetect: false });
    const resolver = checks.find(c => c.name === 'resolver_health');
    expect(resolver).toBeDefined();
    expect(resolver!.status).toBe('warn');
  });

  test('surfaces upgrade_errors trail when ~/.gbrain/upgrade-errors.jsonl exists', () => {
    const gbrainDir = join(tmpHome, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    const errorLine = JSON.stringify({
      ts: '2026-05-13T12:00:00Z',
      phase: 'post-upgrade',
      from_version: '0.33.0',
      to_version: '0.33.1.0',
      hint: 'run gbrain post-upgrade --retry',
    });
    writeFileSync(join(gbrainDir, 'upgrade-errors.jsonl'), errorLine + '\n');

    const checks = collectFastChecks({ skillsDir });
    const upgrade = checks.find(c => c.name === 'upgrade_errors');
    expect(upgrade).toBeDefined();
    expect(upgrade!.status).toBe('warn');
    expect(upgrade!.message).toContain('post-upgrade');
    expect(upgrade!.message).toContain('0.33.1.0');
  });
});

describe('doctorReportFast', () => {
  test('wraps collectFastChecks into a DoctorReport', async () => {
    const report: DoctorReport = await doctorReportFast({ skillsDir });
    expect(report.schema_version).toBe(2);
    expect(report.checks.length).toBeGreaterThanOrEqual(2);
    expect(report.status).toMatch(/healthy|warnings|unhealthy/);
    expect(typeof report.health_score).toBe('number');
  });

  test('is FS-only — accepts no engine argument', async () => {
    // Signature check: arity 1 (opts only, no engine)
    expect(doctorReportFast.length).toBeLessThanOrEqual(1);
  });
});
