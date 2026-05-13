/**
 * PGLite File Lock — prevents concurrent process access to the same data directory.
 *
 * PGLite uses embedded Postgres (WASM) which only supports one connection at a time.
 * When `gbrain embed` (which can take minutes) is running and another process tries
 * to connect, PGLite throws `Aborted()` because it can't handle concurrent access.
 *
 * This module implements a simple advisory lock using a lock file next to the data
 * directory. It uses atomic `mkdir` (which is POSIX-atomic) combined with PID tracking
 * for stale lock detection.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
}

interface LockDiagnostics {
  lockPath: string;
  pid: string;
  command: string;
  age: string;
  processAlive: string;
  metadata: string;
}

function getLockDir(dataDir: string | undefined): string {
  // Use the parent of the data dir for the lock, or a temp location for in-memory
  if (!dataDir) {
    // In-memory PGLite — no concurrent access possible since it's process-scoped
    // Return a sentinel that we skip
    return '';
  }
  return join(dataDir, LOCK_DIR_NAME);
}

function normalizePid(value: unknown): number | null {
  const pid = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : NaN;

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks existence without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but this user cannot signal it.
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value)) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) return asNumber;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatAge(acquiredAt: number | null): string {
  if (acquiredAt === null) return 'unknown';

  const ageMs = Math.max(0, Date.now() - acquiredAt);
  if (ageMs < 1000) return `${ageMs}ms`;

  const totalSeconds = Math.floor(ageMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s (${ageMs}ms)`;
  if (minutes > 0) return `${minutes}m ${seconds}s (${ageMs}ms)`;
  return `${seconds}s (${ageMs}ms)`;
}

function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readLockDiagnostics(lockDir: string): LockDiagnostics {
  const lockPath = join(lockDir, LOCK_FILE);
  let pid: number | null = null;
  let command = 'unknown';
  let acquiredAt: number | null = null;
  let metadata = 'read';

  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      pid?: unknown;
      command?: unknown;
      acquired_at?: unknown;
    };

    pid = normalizePid(lockData.pid);
    command = typeof lockData.command === 'string' && lockData.command.trim()
      ? lockData.command
      : 'unknown';
    acquiredAt = normalizeTimestamp(lockData.acquired_at);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    metadata = `unavailable (${reason})`;
  }

  if (acquiredAt === null) {
    const fallbackMtime = statMtime(lockPath) ?? statMtime(lockDir);
    if (fallbackMtime !== null) {
      acquiredAt = fallbackMtime;
      metadata = metadata === 'read' ? 'read (age from filesystem mtime)' : `${metadata}; age from filesystem mtime`;
    }
  }

  return {
    lockPath,
    pid: pid === null ? 'unknown' : String(pid),
    command,
    age: formatAge(acquiredAt),
    processAlive: pid === null ? 'unknown' : String(isProcessAlive(pid)),
    metadata,
  };
}

function buildLockTimeoutError(lockDir: string): Error {
  const d = readLockDiagnostics(lockDir);
  const suggestion = [
    'Do not delete a live lock.',
    'If process_alive=true, wait for the owner or restart/stop that gbrain process cleanly.',
    `If process_alive=false, the next retry should auto-clean the stale lock; if it persists, inspect permissions and remove ${lockDir} only after confirming the owner is dead.`,
    `If process_alive=unknown, inspect ${d.lockPath} and running gbrain processes before removing anything.`,
  ].join(' ');

  return new Error([
    'GBrain: Timed out waiting for PGLite lock.',
    `lock_path: ${d.lockPath}`,
    `pid: ${d.pid}`,
    `command: ${d.command}`,
    `age: ${d.age}`,
    `process_alive: ${d.processAlive}`,
    `metadata: ${d.metadata}`,
    `safe_suggestion: ${suggestion}`,
  ].join('\n'));
}

async function waitBeforeRetry(startTime: number, timeoutMs: number, delayMs: number): Promise<void> {
  const remainingMs = timeoutMs - (Date.now() - startTime);
  if (remainingMs <= 0) return;
  await new Promise(r => setTimeout(r, Math.min(delayMs, remainingMs)));
}

/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 * Returns { acquired: true } if the lock was obtained, { acquired: false } otherwise.
 * Stale locks (from dead processes) are automatically cleaned up.
 */
export async function acquireLock(dataDir: string | undefined, opts?: { timeoutMs?: number }): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

  // In-memory PGLite — no lock needed (process-scoped, can't be shared)
  if (!lockDir) {
    return { lockDir: '', acquired: true };
  }

  // `lockDir` being set implies `dataDir` is set (see getLockDir), but TS
  // can't derive that across helper boundaries.
  mkdirSync(dataDir as string, { recursive: true });

  const timeoutMs = opts?.timeoutMs ?? 30_000; // 30 second default timeout
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check for stale lock first
    if (existsSync(lockDir)) {
      const lockPath = join(lockDir, LOCK_FILE);
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        const lockPid = normalizePid(lockData.pid);
        // Is the locking process still alive?
        if (lockPid === null || !isProcessAlive(lockPid)) {
          // Stale lock — only clean it up when the owning process is gone.
          // A live process can legitimately hold PGLite for long imports,
          // syncs, or an HTTP server lifetime; stealing that lock risks
          // concurrent embedded-DB access and WAL corruption.
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition, try again */ }
        } else {
          // Lock is held by a live process — wait and retry. Do not treat
          // age alone as stale; operators should stop the owner cleanly if
          // it is truly hung.
          await waitBeforeRetry(startTime, timeoutMs, 1000);
          continue;
        }
      } catch {
        // Corrupt lock file — remove it
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition */ }
      }
    }

    // Try to acquire lock (atomic mkdir)
    try {
      mkdirSync(lockDir, { recursive: false });
      // We got the lock — write our PID
      const lockPath = join(lockDir, LOCK_FILE);
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        acquired_at: Date.now(),
        command: process.argv.slice(1).join(' '),
      }), { mode: 0o644 });

      return { lockDir, acquired: true };
    } catch (e: unknown) {
      // mkdir failed — someone else grabbed it between our check and mkdir
      // This is fine, we'll retry
      if (Date.now() - startTime >= timeoutMs) {
        throw buildLockTimeoutError(lockDir);
      }
      // Brief wait before retry
      await waitBeforeRetry(startTime, timeoutMs, 500);
    }
  }

  throw buildLockTimeoutError(lockDir);
}

/**
 * Release a previously acquired lock.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (!lock.lockDir || !lock.acquired) return;

  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // Lock file already removed (e.g., by stale cleanup) — that's fine
  }
}
