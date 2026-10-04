/**
 * A synchronous cross-process lock, for read-modify-write of files that several
 * hook processes update at once.
 *
 * Atomic replacement (temp file + rename) only stops readers from seeing a
 * half-written file. Two writers that both read the old value still lose one
 * update, so a provider ledger needs the whole read, change and write held
 * under this lock.
 *
 * The lock is a file created exclusively (`wx`) that holds the owner's pid and
 * a random token. A waiter takes it over when the owner process is gone or has
 * held it past `staleAfterMs`, so a hook killed by its coding tool's timeout
 * never blocks the next one. Waiting is bounded: past `timeoutMs` the call
 * throws, and the hook runner's fail-open path drops that one update.
 *
 * Synchronous on purpose: hooks are short-lived processes that must finish
 * fast, and the waits are a few milliseconds.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isProcessAlive } from './daemon-state';
import { readJson } from './json-file';

export interface FileLockOptions {
  /** Give up and throw after waiting this long. */
  timeoutMs?: number;
  /** Take over a lock held longer than this, even by a live process. */
  staleAfterMs?: number;
  /** Clock and liveness probe, injectable for tests. */
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

interface LockOwner {
  pid: number;
  token: string;
  at: number;
}

/** Hooks run under a three-second timeout, so nothing legitimate holds it longer. */
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_STALE_AFTER_MS = 2000;

const pause = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(pause, 0, 0, ms);
}

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`timed out waiting for lock ${path}`);
    this.name = 'LockTimeoutError';
  }
}

/** Run `fn` while holding the lock at `path`, releasing it afterwards. */
export function withFileLock<T>(path: string, fn: () => T, options: FileLockOptions = {}): T {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? isProcessAlive;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const owner: LockOwner = { pid: process.pid, token: randomBytes(8).toString('hex'), at: now() };

  mkdirSync(dirname(path), { recursive: true });
  const deadline = owner.at + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ ...owner, at: now() }), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = readJson<LockOwner>(path);
    const abandoned =
      held !== null &&
      (!isAlive(held.pid) || !Number.isFinite(held.at) || now() - held.at > staleAfterMs);
    if (abandoned) {
      takeOver(path, held);
      continue;
    }
    if (now() >= deadline) throw new LockTimeoutError(path);
    sleep(Math.min(2 + attempt, 20));
  }

  try {
    return fn();
  } finally {
    release(path, owner.token);
  }
}

/**
 * Remove an abandoned lock. The file is moved aside first and checked, so a
 * waiter that lost the race to a fresh owner puts the fresh lock back instead
 * of deleting it.
 */
function takeOver(path: string, abandoned: LockOwner): void {
  const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return; // someone else moved it first
  }
  const moved = readJson<LockOwner>(aside);
  if (moved && moved.token !== abandoned.token) {
    try {
      renameSync(aside, path); // a fresh owner's lock: restore it
      return;
    } catch {
      // the fresh owner already finished or another waiter recreated it
    }
  }
  rmSync(aside, { force: true });
}

function release(path: string, token: string): void {
  const held = readJson<LockOwner>(path);
  if (held?.token === token) rmSync(path, { force: true });
}
