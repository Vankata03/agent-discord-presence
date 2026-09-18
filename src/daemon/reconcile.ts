/**
 * Reconcile tick: one pass of the daemon, as a function of its inputs.
 *
 * Each tick takes the session store's aggregated state, enriches it, renders
 * the active theme, pushes the payload to the presence sink, records daemon
 * status, and returns a verdict: `active` (a session is live), `idle-continue`
 * (nothing live, still inside the idle grace) or `idle-exit` (grace elapsed,
 * the daemon should shut down).
 *
 * Every dependency is injected so the policy is tested without a daemon, a
 * Discord client or a home directory. The Discord client is one presence-sink
 * adapter; the test suite's recording sink is the other. Idle tracking is the
 * only state the tick owns across calls, so a tick is created once per daemon
 * run.
 */
import type { DaemonStatus } from '../core/daemon-state';
import { renderPresence } from '../core/presence';
import type { SessionStore } from '../core/session-store';
import type { AggregatedState, PresencePayload, Theme } from '../types';

/** Where a rendered presence payload goes. */
export interface PresenceSink {
  readonly isConnected: boolean;
  setActivity(payload: PresencePayload): Promise<void>;
  clearActivity(): Promise<void>;
}

/** Facts filled in from the transcript when the provider did not supply them. */
export type Enrichment = Pick<AggregatedState, 'model' | 'branch' | 'tokens'>;

export interface ReconcileDeps {
  store: Pick<SessionStore, 'snapshot'>;
  /** Re-read every tick so a saved theme change hot-reloads. */
  loadConfig: () => { theme: Theme };
  enrich: (state: AggregatedState) => Enrichment;
  sink: PresenceSink;
  writeStatus: (status: DaemonStatus) => void;
  pid: number;
}

export interface ReconcileOptions {
  /** How long with zero live sessions before the tick asks the daemon to exit. */
  idleGraceMs?: number;
}

export type TickVerdict = 'active' | 'idle-continue' | 'idle-exit';

export type ReconcileTick = (now: number) => Promise<TickVerdict>;

/** Default idle grace: one minute with no live session, then exit. */
export const IDLE_GRACE_MS = 60 * 1000;

export function createReconcileTick(
  deps: ReconcileDeps,
  options: ReconcileOptions = {},
): ReconcileTick {
  const idleGraceMs = options.idleGraceMs ?? IDLE_GRACE_MS;
  let idleSince: number | null = null;

  return async (now) => {
    const snapshot = deps.store.snapshot(now);

    if (snapshot) {
      idleSince = null;
      // Provider-supplied facts win; enrichment only fills the gaps.
      const meta = deps.enrich(snapshot);
      const state: AggregatedState = {
        ...snapshot,
        model: snapshot.model ?? meta.model,
        branch: snapshot.branch ?? meta.branch,
        tokens: snapshot.tokens ?? meta.tokens,
      };
      const { theme } = deps.loadConfig();
      await deps.sink.setActivity(renderPresence(theme, state, now));
      deps.writeStatus({
        pid: deps.pid,
        connected: deps.sink.isConnected,
        sessionCount: state.sessionCount,
        activity: state.activity,
        updatedAt: now,
      });
      return 'active';
    }

    if (idleSince === null) idleSince = now;
    await deps.sink.clearActivity();
    deps.writeStatus({
      pid: deps.pid,
      connected: deps.sink.isConnected,
      sessionCount: 0,
      updatedAt: now,
    });
    return now - idleSince >= idleGraceMs ? 'idle-exit' : 'idle-continue';
  };
}
