/**
 * The short-lived hook process every provider shares: read the payload from
 * stdin, translate it, apply the result to the session store, and make sure a
 * daemon is running. Providers own only their translation and environment.
 *
 * A provider that tracks overlapping work (tools, subagents, permission waits)
 * uses `runLedgerHook` instead: its translation reads the session's previous
 * ledger and returns the next one, and the read, the translation, the ledger
 * write and the marker write all happen under the session's cross-process
 * lock, so concurrent hooks can neither lose an operation nor write markers
 * out of order.
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

/** The hook payload; an unreadable stdin is empty, so fallbacks decide. */
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

/** A store that also serializes a session's provider-owned ledger. */
export interface LedgerHookStore extends HookStore {
  withLock<T>(identity: SessionIdentity, fn: () => T): T;
  readLedger(identity: SessionIdentity): unknown;
  writeLedger(identity: SessionIdentity, ledger: unknown): void;
}

/** Runtime boundary for a short-lived provider hook process. */
export interface HookRuntime<Store extends HookStore = HookStore> {
  readInput: () => string;
  now: () => number;
  environment: () => TranslateEnv;
  root: () => string;
  createStore: (root: string) => Store;
  ensureDaemon: (root: string) => void;
}

/** The real process runtime, given the provider's environment fallbacks. */
export function defaultHookRuntime(environment: () => TranslateEnv): HookRuntime<SessionStore> {
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

/** Run one stateless provider hook: translate stdin, apply it, ensure the daemon. */
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
    apply(runtime.createStore(root), result, now);
    if (result.kind === 'update') runtime.ensureDaemon(root);
  } catch {
    // A broken presence tool must never break the coding tool.
  }
}

/** Write one translation to the store: record an update, or end the session. */
function apply(store: HookStore, result: NonNullable<Translation>, now: number): void {
  if (result.kind === 'end') store.end(result.identity);
  else store.record(result.identity, result.patch, now, result.activityChanged);
}

/** One event's outcome for a ledger-backed provider. */
export interface LedgerStep {
  translation: Translation;
  /** The session's ledger after this event; null removes it. */
  ledger: unknown;
}

/**
 * Parse one event from raw stdin. Returns the session it belongs to and the
 * step to run against that session's previous ledger (null when there is
 * none or it is unreadable), or null to ignore the event.
 */
export type LedgerTranslator = (
  event: string,
  raw: string,
  now: number,
  env: TranslateEnv,
) => { identity: SessionIdentity; step: (ledger: unknown) => LedgerStep } | null;

/** Run one ledger-backed provider hook, with all session I/O under the session lock. */
export async function runLedgerHook(
  args: string[],
  translate: LedgerTranslator,
  runtime: HookRuntime<LedgerHookStore>,
): Promise<void> {
  try {
    const event = args[0] ?? 'unknown';
    const now = runtime.now();
    const pending = translate(event, runtime.readInput(), now, runtime.environment());
    if (!pending) return;

    const root = runtime.root();
    const store = runtime.createStore(root);
    const result = store.withLock(pending.identity, () => {
      const { translation, ledger } = pending.step(store.readLedger(pending.identity));
      if (!translation) return null;
      // An end removes the ledger with the marker.
      if (translation.kind === 'update') store.writeLedger(pending.identity, ledger);
      apply(store, translation, now);
      return translation;
    });
    // The daemon starts outside the lock so a slow spawn never holds up the
    // session's next hook; as above, an end never starts it.
    if (result?.kind === 'update') runtime.ensureDaemon(root);
  } catch {
    // A broken presence tool must never break the coding tool.
  }
}
