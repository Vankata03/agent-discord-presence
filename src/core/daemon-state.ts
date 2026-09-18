/**
 * Daemon liveness primitives: the singleton lockfile and a small status file,
 * both under the presence directory the DaemonState is rooted at.
 *
 * Kept separate from the daemon itself (and free of the Discord dependency) so
 * `vdp status` and the hook path can read daemon health without pulling in the
 * RPC library.
 *
 * The lock holds the daemon's pid. Acquisition is atomic via exclusive create
 * (`wx`); if the existing lock points at a dead pid it's treated as stale and
 * taken over — this is how we recover after a crash where the lock outlived the
 * process. The pid and the liveness probe are injectable so lock takeover is
 * testable without spawning processes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, writeJsonAtomic } from './json-file';
import { entryPath } from './paths';

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export interface DaemonStatus {
  pid: number;
  connected: boolean;
  sessionCount: number;
  activity?: string;
  updatedAt: number;
}

/** A daemon status older than this is treated as stale (daemon likely gone). */
export const DAEMON_STATUS_STALE_MS = 60 * 1000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface DaemonStateOptions {
  /** The pid that owns locks acquired through this instance. */
  pid?: number;
  /** Liveness probe for pids found in the lock. */
  isAlive?: (pid: number) => boolean;
}

export class DaemonState {
  readonly lockPath: string;
  readonly statusPath: string;
  private readonly root: string;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;

  /** `root` is the presence directory, shared with the store and the config. */
  constructor(root: string, options: DaemonStateOptions = {}) {
    this.root = root;
    this.lockPath = join(root, 'daemon.lock');
    this.statusPath = join(root, 'state.json');
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? isProcessAlive;
  }

  readLock(): LockInfo | null {
    return readJson<LockInfo>(this.lockPath);
  }

  /**
   * Try to become the one daemon. Returns true on success. Fails (returns false)
   * only when another live daemon already holds the lock.
   */
  acquireLock(now: number): boolean {
    mkdirSync(this.root, { recursive: true });
    const payload = JSON.stringify({ pid: this.pid, startedAt: now } satisfies LockInfo);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Exclusive create is the atomic step, so this write bypasses the
        // temp-then-rename recipe on purpose.
        writeFileSync(this.lockPath, payload, { flag: 'wx' });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
        const existing = this.readLock();
        if (existing && existing.pid !== this.pid && this.isAlive(existing.pid)) {
          return false; // another live daemon owns it
        }
        // Stale (or ours) — clear it and retry the exclusive create.
        try {
          rmSync(this.lockPath);
        } catch {
          // someone else may have just cleared it; the retry settles the race
        }
      }
    }
    return false;
  }

  /** Release the lock, but only if we still own it. */
  releaseLock(): void {
    const existing = this.readLock();
    if (existing && existing.pid === this.pid) {
      try {
        rmSync(this.lockPath);
      } catch {
        // already gone — fine
      }
    }
  }

  writeStatus(status: DaemonStatus): void {
    try {
      writeJsonAtomic(this.statusPath, status);
    } catch {
      // status file is best-effort telemetry; never fatal
    }
  }

  readStatus(): DaemonStatus | null {
    return readJson<DaemonStatus>(this.statusPath);
  }

  clearStatus(): void {
    try {
      rmSync(this.statusPath);
    } catch {
      // already gone — fine
    }
  }

  /**
   * Stop the running daemon, if any. Sends SIGTERM (graceful on POSIX — the
   * daemon clears its presence and releases its lock; on Windows this
   * terminates it, and Discord clears the presence when the socket closes).
   * Waits for it to exit so a follow-up spawn/delete can't race a still-living
   * daemon. Returns the stopped pid, or null if none was running.
   */
  async stop(timeoutMs = 2000): Promise<number | null> {
    const lock = this.readLock();
    if (!lock || !this.isAlive(lock.pid)) return null;
    try {
      process.kill(lock.pid, 'SIGTERM');
    } catch {
      return null; // already gone, or not ours to signal
    }
    await this.waitForExit(lock.pid, timeoutMs);
    return lock.pid;
  }

  /** Resolve after the pid is gone, or after `timeoutMs`. Returns true if it died. */
  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const step = 100;
    for (let waited = 0; waited < timeoutMs; waited += step) {
      if (!this.isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, step));
    }
    return !this.isAlive(pid);
  }
}

/** Spawn a detached daemon from the built entry. Best-effort, never throws. */
export function spawnDaemon(): void {
  try {
    const child = spawn(process.execPath, [entryPath(), 'daemon'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true, // don't flash a console window on Windows
    });
    child.unref();
  } catch {
    // spawn is best-effort
  }
}
