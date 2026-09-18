import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
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
import type { SessionMarker } from '../src/types';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-store-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function markerFile(id: string): string {
  return join(root, 'sessions', `${id}.json`);
}

function readMarker(id: string): SessionMarker {
  return JSON.parse(readFileSync(markerFile(id), 'utf8')) as SessionMarker;
}

test('record creates a marker under <root>/sessions with start and heartbeat at now', () => {
  const store = new SessionStore(root);
  store.record('s1', { project: 'app', state: 'editing', activity: 'Editing a.ts' }, NOW);
  assert.deepEqual(readMarker('s1'), {
    id: 's1',
    startedAt: NOW,
    project: 'app',
    state: 'editing',
    activity: 'Editing a.ts',
    heartbeat: NOW,
  });
});

test('record merges a patch into an existing marker and refreshes the heartbeat only', () => {
  const store = new SessionStore(root);
  store.record('s1', { project: 'app', state: 'editing' }, NOW);
  store.record('s1', { state: 'running', activity: 'Running a command' }, NOW + MIN);
  const m = readMarker('s1');
  assert.equal(m.startedAt, NOW);
  assert.equal(m.heartbeat, NOW + MIN);
  assert.equal(m.project, 'app');
  assert.equal(m.state, 'running');
  assert.equal(m.activity, 'Running a command');
});

test('a patch may reset startedAt (a genuine session restart)', () => {
  const store = new SessionStore(root);
  store.record('s1', {}, NOW);
  store.record('s1', { startedAt: NOW + 5 * MIN }, NOW + 5 * MIN);
  assert.equal(readMarker('s1').startedAt, NOW + 5 * MIN);
});

test('record for two ids keeps two independent markers', () => {
  const store = new SessionStore(root);
  store.record('a', { project: 'one' }, NOW);
  store.record('b', { project: 'two' }, NOW + 1);
  assert.deepEqual(readdirSync(join(root, 'sessions')).sort(), ['a.json', 'b.json']);
  assert.equal(readMarker('a').project, 'one');
  assert.equal(readMarker('b').project, 'two');
});

test('end removes the marker and is a no-op when it is already gone', () => {
  const store = new SessionStore(root);
  store.record('s1', {}, NOW);
  store.end('s1');
  assert.ok(!existsSync(markerFile('s1')));
  assert.doesNotThrow(() => store.end('s1'));
  assert.doesNotThrow(() => store.end('never-existed'));
});

test('snapshot is null when nothing was ever recorded', () => {
  assert.equal(new SessionStore(root).snapshot(NOW), null);
});

test('snapshot aggregates live sessions: count, earliest start, freshest session facts', () => {
  const store = new SessionStore(root);
  store.record(
    'old',
    { startedAt: NOW - 30 * MIN, project: 'old-proj', activity: 'Idle' },
    NOW - MIN,
  );
  store.record('new', { project: 'new-proj', activity: 'Editing x.ts', state: 'editing' }, NOW);
  const s = store.snapshot(NOW);
  assert.deepEqual(s, {
    sessionCount: 2,
    startedAt: NOW - 30 * MIN,
    transcriptPath: undefined,
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
  store.record('stale', { project: 'stale' }, NOW);
  store.record('live', { project: 'live' }, NOW + 3 * MIN);
  const s = store.snapshot(NOW + 3 * MIN);
  assert.equal(s?.sessionCount, 1);
  assert.equal(s?.project, 'live');
  assert.ok(existsSync(markerFile('stale')));
});

test('snapshot prunes abandoned markers and keeps stale-but-not-abandoned ones', () => {
  const store = new SessionStore(root, { staleAfterMs: 2 * MIN, pruneAfterMs: 10 * MIN });
  store.record('abandoned', {}, NOW);
  store.record('stale', {}, NOW + 8 * MIN);
  store.record('live', {}, NOW + 11 * MIN);
  const s = store.snapshot(NOW + 11 * MIN);
  assert.equal(s?.sessionCount, 1);
  assert.ok(!existsSync(markerFile('abandoned')), 'abandoned marker pruned');
  assert.ok(existsSync(markerFile('stale')), 'stale marker kept');
  assert.ok(existsSync(markerFile('live')));
});

test('default thresholds: stale after 20 min, pruned after 60 min', () => {
  const store = new SessionStore(root);
  store.record('s', {}, NOW);
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
  store.record('good', { project: 'good' }, NOW);
  writeFileSync(markerFile('bad'), '{"id":"bad","startedAt":');
  writeFileSync(join(root, 'sessions', 'good.json.12345.tmp'), '{');
  const s = store.snapshot(NOW);
  assert.equal(s?.sessionCount, 1);
  assert.equal(s?.project, 'good');
});

test('a BOM-prefixed marker still counts', () => {
  const store = new SessionStore(root);
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const body = JSON.stringify({ id: 'bom', startedAt: NOW, heartbeat: NOW });
  writeFileSync(markerFile('bom'), String.fromCharCode(0xfeff) + body);
  assert.equal(store.snapshot(NOW)?.sessionCount, 1);
});

test('the store starts empty on a root that does not exist yet', () => {
  const store = new SessionStore(join(root, 'nope'));
  assert.equal(store.snapshot(NOW), null);
  store.record('s', {}, NOW);
  assert.equal(store.snapshot(NOW)?.sessionCount, 1);
});

// The aggregation rule is a pure internal seam: it is the piece the
// multi-tool work extends, so it gets its own tests.
test('aggregate: current session is the freshest heartbeat, start is the earliest live start', () => {
  const markers: SessionMarker[] = [
    { id: 'a', startedAt: NOW - 10 * MIN, heartbeat: NOW - 5 * MIN, project: 'a', model: 'Opus' },
    { id: 'b', startedAt: NOW - 3 * MIN, heartbeat: NOW, project: 'b' },
    { id: 'dead', startedAt: NOW - 90 * MIN, heartbeat: NOW - 30 * MIN, project: 'dead' },
  ];
  const s = aggregate(markers, NOW, 20 * MIN);
  assert.equal(s?.sessionCount, 2);
  assert.equal(s?.startedAt, NOW - 10 * MIN);
  assert.equal(s?.project, 'b');
  assert.equal(s?.model, undefined, 'facts come from the current session only');
});

test('aggregate: null when every marker is stale', () => {
  const stale: SessionMarker = { id: 'a', startedAt: NOW, heartbeat: NOW - 21 * MIN };
  assert.equal(aggregate([stale], NOW, 20 * MIN), null);
});

// Review follow-ups (PR #8): ids reach the filesystem, markers come from
// disk, and the two thresholds are independent options.
test('record and end reject an id that could escape the sessions directory', () => {
  const store = new SessionStore(root);
  const backslash = String.fromCharCode(92);
  const nul = String.fromCharCode(0);
  for (const id of ['../config', 'a/b', `a${backslash}b`, `a${nul}b`, '.', '..', '']) {
    assert.throws(() => store.record(id, {}, NOW), /session id/, JSON.stringify(id));
    assert.throws(() => store.end(id), /session id/, JSON.stringify(id));
  }
  assert.ok(!existsSync(join(root, 'config.json')));
  assert.ok(!existsSync(join(root, 'sessions', 'a')));
});

test('a marker whose id does not match its filename is ignored', () => {
  const store = new SessionStore(root);
  store.record('real', {}, NOW);
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(
    markerFile('imposter'),
    JSON.stringify({ id: 'other', startedAt: NOW, heartbeat: NOW }),
  );
  assert.equal(store.snapshot(NOW)?.sessionCount, 1);
});

test('a marker without numeric startedAt and heartbeat is ignored', () => {
  const store = new SessionStore(root);
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(markerFile('no-heartbeat'), JSON.stringify({ id: 'no-heartbeat', startedAt: NOW }));
  writeFileSync(markerFile('no-start'), JSON.stringify({ id: 'no-start', heartbeat: NOW }));
  writeFileSync(
    markerFile('strings'),
    JSON.stringify({ id: 'strings', startedAt: 'x', heartbeat: 'y' }),
  );
  writeFileSync(markerFile('not-object'), '42');
  assert.equal(store.snapshot(NOW), null);
});

test('a marker pruned in this snapshot is not reported as live', () => {
  const store = new SessionStore(root, { staleAfterMs: 10 * MIN, pruneAfterMs: 2 * MIN });
  store.record('gone', {}, NOW);
  assert.equal(store.snapshot(NOW + 3 * MIN), null);
  assert.ok(!existsSync(markerFile('gone')));
});
