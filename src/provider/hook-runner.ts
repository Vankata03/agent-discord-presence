/**
 * The short-lived hook process every provider shares: read the payload from
 * stdin, translate it, apply the result to the session store, and make sure a
 * daemon is running. Providers own only their translation and environment.
 *
 * Hard rule: the hook path must NEVER throw or hang — it runs inside the
 * coding tool's hook execution. Everything is wrapped; errors are swallowed
 * and we still succeed, with no output.
 */
import { readFileSync } from 'node:fs';
import { DaemonState, isProcessAlive, spawnDaemon } from '../core/daemon-state';
import { presenceDir } from '../core/paths';
import { SessionStore } from '../core/session-store';
import type { SessionIdentity, SessionMarkerPatch } from '../types';
import type { TranslateEnv, Translation } from './types';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Parse a hook payload; a missing or malformed one is null (fallbacks decide). */
export function parsePayload<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed: unknown = JSON.parse(clean);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/**
 * Spawn the daemon detached unless a live one is already running. Best-effort,
 * never throws.
 *
 * The check is liveness-aware (not just "does the lock file exist"): a stale
 * lock left by a crashed daemon must NOT block a respawn. If the lock is stale
 * we still spawn — the daemon's own acquireLock takes the stale lock over
 * atomically, and if two hooks race here only one daemon wins the lock.
 */
function ensureDaemon(root: string): void {
  const lock = new DaemonState(root).readLock();
  if (lock && isProcessAlive(lock.pid)) return; // a live daemon already owns it
  spawnDaemon(); // no lock, or a stale one — the daemon's acquireLock settles races
}

export interface HookStore {
  record(
    identity: SessionIdentity,
    patch: SessionMarkerPatch,
    now: number,
    activityChanged: boolean,
  ): void;
  end(identity: SessionIdentity): void;
}

/** Runtime boundary for a short-lived provider hook process. */
export interface HookRuntime {
  readInput: () => string;
  now: () => number;
  environment: () => TranslateEnv;
  root: () => string;
  createStore: (root: string) => HookStore;
  ensureDaemon: (root: string) => void;
}

/** The real process runtime, given the provider's environment fallbacks. */
export function defaultHookRuntime(environment: () => TranslateEnv): HookRuntime {
  return {
    readInput: readStdin,
    now: Date.now,
    environment,
    root: presenceDir,
    createStore: (root) => new SessionStore(root),
    ensureDaemon,
  };
}

/** Translate one event from raw stdin and apply it. */
export type RawTranslator = (
  event: string,
  raw: string,
  now: number,
  env: TranslateEnv,
) => Translation;

export async function runProviderHook(
  args: string[],
  translate: RawTranslator,
  runtime: HookRuntime,
): Promise<void> {
  try {
    const event = args[0] ?? 'unknown';
    const now = runtime.now();
    const result = translate(event, runtime.readInput(), now, runtime.environment());
    if (!result) return;

    const root = runtime.root();
    const store = runtime.createStore(root);
    if (result.kind === 'end') {
      store.end(result.identity);
      return;
    }
    store.record(result.identity, result.patch, now, result.activityChanged);

    // Any non-end event means the session is active, so make sure a daemon is
    // up — this self-heals after idle, a mid-session install, or a daemon crash.
    // (end returned above, so we never resurrect a daemon for a dying session.)
    runtime.ensureDaemon(root);
  } catch {
    // A broken presence tool must never break the coding tool.
  }
}
