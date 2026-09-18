/**
 * Session store: the contract between hook providers and the daemon.
 *
 * Each hook process writes ONLY its own per-session marker (sessions/<id>.json
 * under the store's root), so concurrent hook processes never race on a shared
 * file. The daemon is the single reader. Writes are synchronous (hooks must be
 * fast) and atomic, so a reader never sees a half-written file.
 *
 * Liveness is inferred from the heartbeat alone: a marker whose heartbeat is
 * stale is excluded from the presence (the session may have crashed without a
 * session-end, or be briefly idle); one whose heartbeat is far older is
 * abandoned and pruned from disk so orphans never accumulate.
 *
 * The store is constructed with an explicit root so tests exercise the real
 * marker format in a temporary directory.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file';
import type { AggregatedState, SessionMarker } from '../types';

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
 * renders from. The current session is the one with the most recent heartbeat:
 * its facts drive the presence. Returns null when no session is live.
 *
 * Pure on purpose: this is the rule the multi-tool work extends.
 */
export function aggregate(
  markers: SessionMarker[],
  now: number,
  staleAfterMs = STALE_AFTER_MS,
): AggregatedState | null {
  const live = markers.filter((m) => now - m.heartbeat <= staleAfterMs);
  if (live.length === 0) return null;

  const current = live.reduce((a, b) => (b.heartbeat > a.heartbeat ? b : a));
  const startedAt = live.reduce((min, m) => Math.min(min, m.startedAt), Infinity);

  return {
    sessionCount: live.length,
    startedAt,
    transcriptPath: current.transcriptPath,
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

  private markerPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Create or update a session's marker, always refreshing its heartbeat. A
   * new marker starts at `now` unless the patch says otherwise.
   */
  record(id: string, patch: Partial<SessionMarker>, now: number): void {
    const existing = readJson<SessionMarker>(this.markerPath(id));
    const merged: SessionMarker = {
      id,
      startedAt: existing?.startedAt ?? now,
      ...existing,
      ...patch,
      heartbeat: now,
    };
    writeJsonAtomic(this.markerPath(id), merged);
  }

  /** Remove a session's marker. Idempotent: a marker already gone is fine. */
  end(id: string): void {
    try {
      rmSync(this.markerPath(id));
    } catch {
      // already gone — fine
    }
  }

  /**
   * The aggregated state of the live sessions at `now`, or null when none is
   * live. Also prunes abandoned markers, so the daemon never has to know the
   * prune threshold.
   */
  snapshot(now: number): AggregatedState | null {
    const markers = this.readAll();
    for (const m of markers) {
      if (now - m.heartbeat > this.pruneAfterMs) this.end(m.id);
    }
    return aggregate(markers, now, this.staleAfterMs);
  }

  /** Every readable marker on disk; corrupt or half-written ones are skipped. */
  private readAll(): SessionMarker[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: SessionMarker[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const m = readJson<SessionMarker>(this.markerPath(f.slice(0, -5)));
      if (m) out.push(m);
    }
    return out;
  }
}
