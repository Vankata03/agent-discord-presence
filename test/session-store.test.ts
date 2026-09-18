import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, aggregate } from '../src/core/session-store';
import type { ProviderKey, SessionIdentity, SessionMarker, SessionMarkerPatch } from '../src/types';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-store-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function identity(sessionId: string, provider: ProviderKey = 'claude-code'): SessionIdentity {
  return { provider, sessionId };
}

function markerFile(id: string, provider: ProviderKey = 'claude-code'): string {
  const digest = createHash('sha256').update(id).digest('hex');
  return join(root, 'sessions', provider, `${digest}.json`);
}

function readMarker(id: string): SessionMarker {
  return JSON.parse(readFileSync(markerFile(id), 'utf8')) as SessionMarker;
}

function record(
  store: SessionStore,
  id: string,
  patch: SessionMarkerPatch,
  now: number,
  activityChanged = true,
): void {
  store.record(identity(id), patch, now, activityChanged);
}

test('record creates a marker under <root>/sessions with start and heartbeat at now', () => {
  const store = new SessionStore(root);
  record(store, 's1', { project: 'app', state: 'editing', activity: 'Editing a.ts' }, NOW);
  assert.deepEqual(readMarker('s1'), {
    provider: 'claude-code',
    sessionId: 's1',
    startedAt: NOW,
    project: 'app',
    state: 'editing',
    activity: 'Editing a.ts',
    heartbeat: NOW,
    lastActivityAt: NOW,
  });
});

test('record merges a patch into an existing marker and refreshes the heartbeat only', () => {
  const store = new SessionStore(root);
  record(store, 's1', { project: 'app', state: 'editing' }, NOW);
  record(store, 's1', { state: 'running', activity: 'Running a command' }, NOW + MIN);
  const m = readMarker('s1');
  assert.equal(m.startedAt, NOW);
  assert.equal(m.heartbeat, NOW + MIN);
  assert.equal(m.project, 'app');
  assert.equal(m.state, 'running');
  assert.equal(m.activity, 'Running a command');
});

test('a patch may reset startedAt (a genuine session restart)', () => {
  const store = new SessionStore(root);
  record(store, 's1', {}, NOW);
  record(store, 's1', { startedAt: NOW + 5 * MIN }, NOW + 5 * MIN);
  assert.equal(readMarker('s1').startedAt, NOW + 5 * MIN);
});

test('record for two ids keeps two independent markers', () => {
  const store = new SessionStore(root);
  record(store, 'a', { project: 'one' }, NOW);
  record(store, 'b', { project: 'two' }, NOW + 1);
  assert.equal(readdirSync(join(root, 'sessions', 'claude-code')).length, 2);
  assert.equal(readMarker('a').project, 'one');
  assert.equal(readMarker('b').project, 'two');
});

test('end removes the marker and is a no-op when it is already gone', () => {
  const store = new SessionStore(root);
  record(store, 's1', {}, NOW);
  store.end(identity('s1'));
  assert.ok(!existsSync(markerFile('s1')));
  assert.doesNotThrow(() => store.end(identity('s1')));
  assert.doesNotThrow(() => store.end(identity('never-existed')));
});

test('snapshot is null when nothing was ever recorded', () => {
  assert.equal(new SessionStore(root).snapshot(NOW), null);
});

test('snapshot aggregates live sessions: count, selected start, and selected session facts', () => {
  const store = new SessionStore(root);
  record(
    store,
    'old',
    { startedAt: NOW - 30 * MIN, project: 'old-proj', activity: 'Idle' },
    NOW - MIN,
  );
  record(store, 'new', { project: 'new-proj', activity: 'Editing x.ts', state: 'editing' }, NOW);
  const s = store.snapshot(NOW);
  assert.deepEqual(s, {
    sessionCount: 2,
    provider: 'claude-code',
    sessionId: 'new',
    startedAt: NOW,
    cwd: undefined,
    enrichmentRef: undefined,
    project: 'new-proj',
    branch: undefined,
    model: undefined,
    state: 'editing',
    activity: 'Editing x.ts',
    file: undefined,
    tokens: undefined,
    cost: undefined,
  });
});

test('stale sessions are excluded from the snapshot but their markers stay on disk', () => {
  const store = new SessionStore(root, { staleAfterMs: 2 * MIN, pruneAfterMs: 10 * MIN });
  record(store, 'stale', { project: 'stale' }, NOW);
  record(store, 'live', { project: 'live' }, NOW + 3 * MIN);
  const s = store.snapshot(NOW + 3 * MIN);
  assert.equal(s?.sessionCount, 1);
  assert.equal(s?.project, 'live');
  assert.ok(existsSync(markerFile('stale')));
});

test('snapshot prunes abandoned markers and keeps stale-but-not-abandoned ones', () => {
  const store = new SessionStore(root, { staleAfterMs: 2 * MIN, pruneAfterMs: 10 * MIN });
  record(store, 'abandoned', {}, NOW);
  record(store, 'stale', {}, NOW + 8 * MIN);
  record(store, 'live', {}, NOW + 11 * MIN);
  const s = store.snapshot(NOW + 11 * MIN);
  assert.equal(s?.sessionCount, 1);
  assert.ok(!existsSync(markerFile('abandoned')), 'abandoned marker pruned');
  assert.ok(existsSync(markerFile('stale')), 'stale marker kept');
  assert.ok(existsSync(markerFile('live')));
});

test('default thresholds: stale after 20 min, pruned after 60 min', () => {
  const store = new SessionStore(root);
  record(store, 's', {}, NOW);
  assert.equal(store.snapshot(NOW + 20 * MIN)?.sessionCount, 1);
  assert.equal(store.snapshot(NOW + 20 * MIN + 1), null);
  assert.ok(existsSync(markerFile('s')));
  assert.equal(store.snapshot(NOW + 60 * MIN), null);
  assert.ok(existsSync(markerFile('s')), 'exactly at the prune threshold is kept');
  store.snapshot(NOW + 60 * MIN + 1);
  assert.ok(!existsSync(markerFile('s')), 'past the prune threshold is deleted');
});

test('a corrupt or half-written marker is skipped and the rest are served', () => {
  const store = new SessionStore(root);
  record(store, 'good', { project: 'good' }, NOW);
  writeFileSync(markerFile('bad'), '{"id":"bad","startedAt":');
  writeFileSync(join(root, 'sessions', 'good.json.12345.tmp'), '{');
  const s = store.snapshot(NOW);
  assert.equal(s?.sessionCount, 1);
  assert.equal(s?.project, 'good');
});

test('a BOM-prefixed marker still counts', () => {
  const store = new SessionStore(root);
  mkdirSync(join(root, 'sessions', 'claude-code'), { recursive: true });
  const body = JSON.stringify({
    provider: 'claude-code',
    sessionId: 'bom',
    startedAt: NOW,
    heartbeat: NOW,
    lastActivityAt: NOW,
  });
  writeFileSync(markerFile('bom'), String.fromCharCode(0xfeff) + body);
  assert.equal(store.snapshot(NOW)?.sessionCount, 1);
});

test('the store starts empty on a root that does not exist yet', () => {
  const store = new SessionStore(join(root, 'nope'));
  assert.equal(store.snapshot(NOW), null);
  record(store, 's', {}, NOW);
  assert.equal(store.snapshot(NOW)?.sessionCount, 1);
});

// The aggregation rule is a pure internal seam: it is the piece the
// multi-tool work extends, so it gets its own tests.
test('aggregate: current session has the freshest visible activity and supplies its own start', () => {
  const markers: SessionMarker[] = [
    {
      ...identity('a'),
      startedAt: NOW - 10 * MIN,
      heartbeat: NOW,
      lastActivityAt: NOW - 5 * MIN,
      project: 'a',
      model: 'Opus',
    },
    {
      ...identity('b', 'codex'),
      startedAt: NOW - 3 * MIN,
      heartbeat: NOW - MIN,
      lastActivityAt: NOW,
      project: 'b',
    },
    {
      ...identity('dead'),
      startedAt: NOW - 90 * MIN,
      heartbeat: NOW - 30 * MIN,
      lastActivityAt: NOW - 30 * MIN,
      project: 'dead',
    },
  ];
  const s = aggregate(markers, NOW, 20 * MIN);
  assert.equal(s?.sessionCount, 2);
  assert.equal(s?.startedAt, NOW - 3 * MIN);
  assert.equal(s?.provider, 'codex');
  assert.equal(s?.sessionId, 'b');
  assert.equal(s?.project, 'b');
  assert.equal(s?.model, undefined, 'facts come from the current session only');
});

test('aggregate: null when every marker is stale', () => {
  const stale: SessionMarker = {
    ...identity('a'),
    startedAt: NOW,
    heartbeat: NOW - 21 * MIN,
    lastActivityAt: NOW,
  };
  assert.equal(aggregate([stale], NOW, 20 * MIN), null);
});

// Review follow-ups (PR #8): ids reach the filesystem, markers come from
// disk, and the two thresholds are independent options.
test('record and end reject an id that could escape the sessions directory', () => {
  const store = new SessionStore(root);
  const backslash = String.fromCharCode(92);
  const nul = String.fromCharCode(0);
  for (const id of ['../config', 'a/b', `a${backslash}b`, `a${nul}b`, '.', '..', '']) {
    assert.throws(
      () => store.record(identity(id), {}, NOW, true),
      /session id/,
      JSON.stringify(id),
    );
    assert.throws(() => store.end(identity(id)), /session id/, JSON.stringify(id));
  }
  assert.ok(!existsSync(join(root, 'config.json')));
  assert.ok(!existsSync(join(root, 'sessions', 'a')));
});

test('a marker whose id does not match its filename is ignored', () => {
  const store = new SessionStore(root);
  record(store, 'real', {}, NOW);
  writeFileSync(
    markerFile('imposter'),
    JSON.stringify({
      ...identity('other'),
      startedAt: NOW,
      heartbeat: NOW,
      lastActivityAt: NOW,
    }),
  );
  assert.equal(store.snapshot(NOW)?.sessionCount, 1);
});

test('a marker without numeric store-owned timestamps is ignored', () => {
  const store = new SessionStore(root);
  mkdirSync(join(root, 'sessions', 'claude-code'), { recursive: true });
  writeFileSync(
    markerFile('no-heartbeat'),
    JSON.stringify({ ...identity('no-heartbeat'), startedAt: NOW, lastActivityAt: NOW }),
  );
  writeFileSync(
    markerFile('no-start'),
    JSON.stringify({ ...identity('no-start'), heartbeat: NOW, lastActivityAt: NOW }),
  );
  writeFileSync(
    markerFile('no-activity'),
    JSON.stringify({ ...identity('no-activity'), startedAt: NOW, heartbeat: NOW }),
  );
  writeFileSync(
    markerFile('strings'),
    JSON.stringify({
      ...identity('strings'),
      startedAt: 'x',
      heartbeat: 'y',
      lastActivityAt: 'z',
    }),
  );
  writeFileSync(markerFile('not-object'), '42');
  assert.equal(store.snapshot(NOW), null);
});

test('a marker pruned in this snapshot is not reported as live', () => {
  const store = new SessionStore(root, { staleAfterMs: 10 * MIN, pruneAfterMs: 2 * MIN });
  record(store, 'gone', {}, NOW);
  assert.equal(store.snapshot(NOW + 3 * MIN), null);
  assert.ok(!existsSync(markerFile('gone')));
});
