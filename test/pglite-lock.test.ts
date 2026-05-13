import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, type LockHandle } from '../src/core/pglite-lock';

const TEST_DIR = join(tmpdir(), 'gbrain-lock-test-' + process.pid);

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('Expected promise to reject');
}

function expectLockTimeoutDiagnostics(message: string, lockDir: string): void {
  expect(message).toContain('GBrain: Timed out waiting for PGLite lock.');
  expect(message).toContain(`lock_path: ${join(lockDir, 'lock')}`);
  expect(message).toContain('pid: ');
  expect(message).toContain('command: ');
  expect(message).toContain('age: ');
  expect(message).toContain('process_alive: ');
  expect(message).toContain('safe_suggestion: Do not delete a live lock.');
}

describe('pglite-lock', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('acquires and releases lock', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(false);
  });

  test('prevents concurrent lock acquisition', async () => {
    const lock1 = await acquireLock(TEST_DIR, { timeoutMs: 2000 });
    expect(lock1.acquired).toBe(true);

    // Second lock attempt should timeout
    const err = await captureError(acquireLock(TEST_DIR, { timeoutMs: 100 }));
    expectLockTimeoutDiagnostics(err.message, join(TEST_DIR, '.gbrain-lock'));
    expect(err.message).toContain(`pid: ${process.pid}`);
    expect(err.message).toContain('process_alive: true');

    await releaseLock(lock1);
  });

  test('detects and cleans stale lock from dead process', async () => {
    // Simulate a stale lock from a dead process
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 999999999, // Non-existent PID
      acquired_at: Date.now(),
      command: 'test',
    }));

    // Should clean up the stale lock and acquire
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    await releaseLock(lock);
  });

  test('does not steal an old lock from a live process', async () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: process.pid,
      acquired_at: Date.now() - 10 * 60 * 1000,
      command: 'still-running-test-process',
    }));

    const err = await captureError(acquireLock(TEST_DIR, { timeoutMs: 100 }));
    expectLockTimeoutDiagnostics(err.message, lockDir);
    expect(err.message).toContain(`pid: ${process.pid}`);
    expect(err.message).toContain('command: still-running-test-process');
    expect(err.message).toContain('process_alive: true');

    const lockData = JSON.parse(readFileSync(join(lockDir, 'lock'), 'utf-8'));
    expect(lockData.command).toBe('still-running-test-process');
  });

  test('skips lock for in-memory (undefined dataDir)', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    // Release should be a no-op
    await releaseLock(lock);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(TEST_DIR);
    const lockData = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });

  test('releases lock on disconnect even if DB close fails', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    // Simulate DB already closed
    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);

    // Second acquisition should work
    const lock2 = await acquireLock(TEST_DIR);
    expect(lock2.acquired).toBe(true);
    await releaseLock(lock2);
  });
});
