import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/core/session-store';
import type { DaemonStatus } from '../src/core/daemon-state';
import {
  createReconcileTick,
  type Enrichment,
  type PresenceSink,
  type ReconcileDeps,
} from '../src/daemon/reconcile';
import type { AggregatedState, PresencePayload, SessionMarkerPatch, Theme } from '../src/types';

const NOW = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;
const PID = 4242;

/** The second presence-sink adapter: records what the tick pushes. */
class RecordingSink implements PresenceSink {
  payloads: PresencePayload[] = [];
  clears = 0;
  isConnected = true;
  async setActivity(payload: PresencePayload): Promise<void> {
    this.payloads.push(payload);
  }
  async clearActivity(): Promise<void> {
    this.clears++;
  }
}

const THEME: Theme = {
  details: 'Working on {project} ({branch})',
  state: '{activity} · {model} · {tokens}',
  largeImage: { key: 'logo', text: '' },
  smallImage: { key: 'status-{state}', text: '{state}' },
  timer: true,
  buttons: [],
};

let root: string;
let store: SessionStore;
let sink: RecordingSink;
let statuses: DaemonStatus[];
let theme: Theme;
let enrichment: Enrichment;
let enrichedWith: AggregatedState[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-tick-'));
  store = new SessionStore(root);
  sink = new RecordingSink();
  statuses = [];
  theme = THEME;
  enrichment = {};
  enrichedWith = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function deps(): ReconcileDeps {
  return {
    store,
    loadConfig: () => ({ theme }),
    enrich: (state) => {
      enrichedWith.push(state);
      return enrichment;
    },
    sink,
    writeStatus: (s) => statuses.push(s),
    pid: PID,
  };
}

function record(id: string, patch: SessionMarkerPatch, now: number): void {
  store.record({ provider: 'claude-code', sessionId: id }, patch, now, true);
}

test('a live session renders the theme and pushes the payload to the sink', async () => {
  record('s1', { project: 'app', branch: 'main', state: 'editing', activity: 'Editing a.ts' }, NOW);
  const tick = createReconcileTick(deps());

  assert.equal(await tick(NOW), 'active');
  assert.deepEqual(sink.payloads, [
    {
      details: 'Working on app (main)',
      state: 'Editing a.ts',
      largeImageKey: 'logo',
      smallImageKey: 'status-editing',
      smallImageText: 'editing',
      startTimestamp: NOW,
    },
  ]);
  assert.equal(sink.clears, 0);
});

test('provider-supplied facts win over enriched values', async () => {
  record('s1', { project: 'app', model: 'Opus 4.8', activity: 'Thinking' }, NOW);
  enrichment = { model: 'Sonnet 4.5', branch: 'feat/x', tokens: 1500 };
  const tick = createReconcileTick(deps());

  await tick(NOW);
  assert.equal(sink.payloads[0]?.state, 'Thinking · Opus 4.8 · 1.5k');
  assert.equal(sink.payloads[0]?.details, 'Working on app (feat/x)');
});

test('enrichment fills model, branch and tokens the provider did not know', async () => {
  record('s1', { project: 'app', activity: 'Thinking', enrichmentRef: '/t.jsonl' }, NOW);
  enrichment = { model: 'Opus 4.8', branch: 'main', tokens: 2_000_000 };
  const tick = createReconcileTick(deps());

  await tick(NOW);
  assert.equal(sink.payloads[0]?.state, 'Thinking · Opus 4.8 · 2.0M');
  assert.equal(sink.payloads[0]?.details, 'Working on app (main)');
  assert.equal(enrichedWith[0]?.enrichmentRef, '/t.jsonl', 'enrichment sees the snapshot');
});

test('enrichment fills cost and the selected session supplies the timer', async () => {
  record('older', { activity: 'Idle', startedAt: NOW - 10 * MIN }, NOW - MIN);
  record('current', { activity: 'Thinking', startedAt: NOW - MIN }, NOW);
  enrichment = { cost: 2.5 };
  theme = { ...THEME, details: '{cost}' };
  const tick = createReconcileTick(deps());

  await tick(NOW);

  assert.equal(sink.payloads[0]?.details, '$2.50');
  assert.equal(sink.payloads[0]?.startTimestamp, NOW - MIN);
  assert.equal(enrichedWith[0]?.sessionId, 'current');
});

test('config is re-read every tick, so a saved theme change reaches the next payload', async () => {
  record('s1', { project: 'app', activity: 'Thinking' }, NOW);
  const tick = createReconcileTick(deps());

  await tick(NOW);
  theme = { ...THEME, details: 'Now on {project}' };
  await tick(NOW + 15 * SEC);

  assert.equal(sink.payloads[0]?.details, 'Working on app');
  assert.equal(sink.payloads[1]?.details, 'Now on app');
});

test('daemon status is written every tick from the sink and the snapshot', async () => {
  record('s1', { activity: 'Editing a.ts' }, NOW);
  record('s2', { activity: 'Idle' }, NOW - MIN);
  sink.isConnected = false;
  const tick = createReconcileTick(deps());

  await tick(NOW);
  assert.deepEqual(statuses, [
    { pid: PID, connected: false, sessionCount: 2, activity: 'Editing a.ts', updatedAt: NOW },
  ]);
});

test('no live session clears the sink, reports zero sessions and continues through the grace', async () => {
  const tick = createReconcileTick(deps(), { idleGraceMs: 60 * SEC });

  assert.equal(await tick(NOW), 'idle-continue');
  assert.equal(await tick(NOW + 45 * SEC), 'idle-continue');
  assert.equal(await tick(NOW + 60 * SEC), 'idle-exit');

  assert.equal(sink.payloads.length, 0);
  assert.equal(sink.clears, 3);
  assert.deepEqual(statuses[0], { pid: PID, connected: true, sessionCount: 0, updatedAt: NOW });
});

test('the idle grace restarts when a session comes back', async () => {
  const tick = createReconcileTick(deps(), { idleGraceMs: 60 * SEC });

  assert.equal(await tick(NOW), 'idle-continue');
  record('s1', { activity: 'Thinking' }, NOW + 30 * SEC);
  assert.equal(await tick(NOW + 30 * SEC), 'active');
  store.end({ provider: 'claude-code', sessionId: 's1' });
  assert.equal(await tick(NOW + 70 * SEC), 'idle-continue', 'grace counts from the new idle');
  assert.equal(await tick(NOW + 130 * SEC), 'idle-exit');
});

test('the default idle grace is 60 seconds', async () => {
  const tick = createReconcileTick(deps());
  await tick(NOW);
  assert.equal(await tick(NOW + 60 * SEC - 1), 'idle-continue');
  assert.equal(await tick(NOW + 60 * SEC), 'idle-exit');
});

test('a session that went stale is treated as idle', async () => {
  record('s1', { activity: 'Thinking' }, NOW);
  const tick = createReconcileTick(deps());

  assert.equal(await tick(NOW), 'active');
  assert.equal(await tick(NOW + 21 * MIN), 'idle-continue');
  assert.equal(sink.clears, 1);
});
