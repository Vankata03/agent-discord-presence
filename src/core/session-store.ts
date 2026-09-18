/**
 * Session store: the contract between hook providers and the daemon.
 *
 * Each hook process writes ONLY its own per-session marker under
 * sessions/<provider>/<session-id-digest>.json, so concurrent sessions never
 * race on a shared file. The daemon is the single reader. Writes are
 * synchronous (hooks must be fast) and atomic, so a reader never sees a
 * half-written file.
 *
 * Liveness is inferred from the heartbeat alone: a marker whose heartbeat is
 * stale is excluded from the presence (the session may have crashed without a
 * session-end, or be briefly idle); one whose heartbeat is far older is
 * abandoned and pruned from disk so orphans never accumulate.
 *
 * The store is constructed with an explicit root so tests exercise the real
 * marker format in a temporary directory.
 */
import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file';
import { PROVIDER_KEYS } from '../types';
import type { AggregatedState, SessionIdentity, SessionMarker, SessionMarkerPatch } from '../types';

const PROVIDERS = new Set<string>(PROVIDER_KEYS);

/** A session is considered stale (excluded from the presence) past this. */
export const STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * Past this, a marker is definitively abandoned (no session-end ever fired) and
 * is deleted from disk. Well beyond STALE_AFTER_MS so a briefly-idle-but-live
 * session is never pruned out from under itself.
 */
export const PRUNE_AFTER_MS = 60 * 60 * 1000;

export interface SessionStoreOptions {
  /** Heartbeat age past which a session no longer counts as live. */
  staleAfterMs?: number;
  /** Heartbeat age past which a marker is deleted from disk. */
  pruneAfterMs?: number;
}

/**
 * Merge the live markers (fresh heartbeat) into the single view the daemon
 * renders from. Visible activity chooses the current session; heartbeat breaks
 * activity ties and controls liveness. A stable identity tie-breaker keeps the
 * result independent of filesystem enumeration order.
 *
 * Pure on purpose: this is the rule the multi-tool work extends.
 */
export function aggregate(
  markers: SessionMarker[],
  now: number,
  staleAfterMs = STALE_AFTER_MS,
): AggregatedState | null {
  const live = markers.filter(
    (marker) =>
      isValidIdentity(marker) &&
      Number.isFinite(marker.startedAt) &&
      Number.isFinite(marker.heartbeat) &&
      Number.isFinite(marker.lastActivityAt) &&
      now - marker.heartbeat <= staleAfterMs,
  );
  if (live.length === 0) return null;

  const current = [...live].sort(
    (a, b) =>
      b.lastActivityAt - a.lastActivityAt || b.heartbeat - a.heartbeat || compareIdentity(a, b),
  )[0]!;

  return {
    sessionCount: live.length,
    provider: current.provider,
    sessionId: current.sessionId,
    startedAt: current.startedAt,
    cwd: current.cwd,
    enrichmentRef: current.enrichmentRef,
    project: current.project,
    branch: current.branch,
    model: current.model,
    state: current.state,
    activity: current.activity,
    file: current.file,
    tokens: current.tokens,
    cost: current.cost,
  };
}

export class SessionStore {
  private readonly dir: string;
  private readonly staleAfterMs: number;
  private readonly pruneAfterMs: number;

  /** `root` is the presence directory; markers live in its `sessions/` folder. */
  constructor(root: string, options: SessionStoreOptions = {}) {
    this.dir = join(root, 'sessions');
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
    this.pruneAfterMs = options.pruneAfterMs ?? PRUNE_AFTER_MS;
  }

  /**
   * Provider keys are allowlisted. Raw session ids are validated, then hashed
   * so they never become filesystem names.
   */
  private markerPath(identity: SessionIdentity): string {
    validateIdentity(identity);
    return join(this.dir, identity.provider, markerFileName(identity.sessionId));
  }

  /**
   * Create or update a session's marker, always refreshing its heartbeat. A
   * new marker starts at `now` unless the patch says otherwise. Visible
   * activity advances its selection clock; housekeeping only advances the
   * heartbeat. Throws on an invalid identity (the hook runner swallows it).
   */
  record(
    identity: SessionIdentity,
    patch: SessionMarkerPatch,
    now: number,
    activityChanged: boolean,
  ): void {
    const path = this.markerPath(identity);
    const existing = parseMarker(readJson<unknown>(path), identity);
    const merged: SessionMarker = {
      startedAt: existing?.startedAt ?? now,
      ...existing,
      ...patch,
      provider: identity.provider,
      sessionId: identity.sessionId,
      heartbeat: now,
      lastActivityAt: !existing || activityChanged ? now : existing.lastActivityAt,
    };
    writeJsonAtomic(path, merged);
  }

  /** Remove a session's marker. Idempotent: a marker already gone is fine. */
  end(identity: SessionIdentity): void {
    const path = this.markerPath(identity);
    try {
      rmSync(path);
    } catch {
      // already gone — fine
    }
  }

  /**
   * The aggregated state of the live sessions at `now`, or null when none is
   * live. Also prunes abandoned markers, so the daemon never has to know the
   * prune threshold; a marker pruned here is never reported as live.
   */
  snapshot(now: number): AggregatedState | null {
    const kept: SessionMarker[] = [];
    for (const m of this.readAll()) {
      if (now - m.heartbeat > this.pruneAfterMs) this.end(m);
      else kept.push(m);
    }
    return aggregate(kept, now, this.staleAfterMs);
  }

  /**
   * Every valid namespaced marker on disk. Legacy flat markers, malformed
   * files, and files whose stored identity disagrees with their path are
   * skipped, never served.
   */
  private readAll(): SessionMarker[] {
    const out: SessionMarker[] = [];
    for (const provider of PROVIDER_KEYS) {
      let files: string[];
      try {
        files = readdirSync(join(this.dir, provider));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        const value = readJson<unknown>(join(this.dir, provider, file));
        if (typeof value !== 'object' || value === null) continue;
        const sessionId = (value as Partial<SessionMarker>).sessionId;
        if (typeof sessionId !== 'string') continue;
        const identity = { provider, sessionId };
        try {
          validateIdentity(identity);
        } catch {
          continue;
        }
        if (markerFileName(sessionId) !== file) continue;
        const marker = parseMarker(value, identity);
        if (marker) out.push(marker);
      }
    }
    return out;
  }
}

function validateIdentity(identity: SessionIdentity): void {
  if (!PROVIDERS.has(identity.provider)) {
    throw new Error(`invalid provider: ${JSON.stringify(identity.provider)}`);
  }
  const id = identity.sessionId;
  if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) {
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  }
}

function isValidIdentity(identity: SessionIdentity): boolean {
  try {
    validateIdentity(identity);
    return true;
  } catch {
    return false;
  }
}

function compareIdentity(a: SessionIdentity, b: SessionIdentity): number {
  const aKey = `${a.provider}\0${a.sessionId}`;
  const bKey = `${b.provider}\0${b.sessionId}`;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function markerFileName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`;
}

/** Parse one marker value, or null unless it belongs to `identity`. */
function parseMarker(value: unknown, identity: SessionIdentity): SessionMarker | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Partial<SessionMarker>;
  if (m.provider !== identity.provider || m.sessionId !== identity.sessionId) return null;
  if (
    !Number.isFinite(m.startedAt) ||
    !Number.isFinite(m.heartbeat) ||
    !Number.isFinite(m.lastActivityAt)
  ) {
    return null;
  }
  return m as SessionMarker;
}
