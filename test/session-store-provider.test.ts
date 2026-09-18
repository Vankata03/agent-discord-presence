import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, aggregate } from '../src/core/session-store';
import type { SessionMarker } from '../src/types';

const NOW = 1_700_000_000_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-provider-store-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('equal raw session ids from different providers use isolated opaque markers', () => {
  const store = new SessionStore(root);

  store.record(
    { provider: 'claude-code', sessionId: 'same-session' },
    { project: 'claude-project' },
    NOW,
    true,
  );
  store.record(
    { provider: 'codex', sessionId: 'same-session' },
    { project: 'codex-project' },
    NOW + 1,
    true,
  );

  for (const provider of ['claude-code', 'codex']) {
    const files = readdirSync(join(root, 'sessions', provider));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[a-f0-9]{64}\.json$/);
    assert.ok(!files[0]!.includes('same-session'));
  }

  const snapshot = store.snapshot(NOW + 1);
  assert.equal(snapshot?.sessionCount, 2);
  assert.equal(snapshot?.provider, 'codex');
  assert.equal(snapshot?.sessionId, 'same-session');
  assert.equal(snapshot?.project, 'codex-project');

  const markerPath = join(
    root,
    'sessions',
    'codex',
    readdirSync(join(root, 'sessions', 'codex'))[0]!,
  );
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as SessionMarker;
  assert.equal(marker.provider, 'codex');
  assert.equal(marker.sessionId, 'same-session');
});

test('heartbeat keeps a session live without stealing the current session', () => {
  const store = new SessionStore(root, { staleAfterMs: 10_000 });
  const housekeeping = { provider: 'claude-code', sessionId: 'housekeeping' } as const;
  const current = { provider: 'codex', sessionId: 'meaningful-work' } as const;

  store.record(
    housekeeping,
    {
      startedAt: NOW - 60_000,
      cwd: '/work/housekeeping',
      enrichmentRef: '/logs/housekeeping.jsonl',
      project: 'housekeeping-project',
      branch: 'housekeeping-branch',
      model: 'housekeeping-model',
      state: 'thinking',
      activity: 'Thinking',
      file: 'housekeeping.ts',
      tokens: 1,
      cost: 0.01,
    },
    NOW,
    true,
  );
  store.record(
    current,
    {
      startedAt: NOW + 500,
      cwd: '/work/current',
      enrichmentRef: '/logs/current.jsonl',
      project: 'current-project',
      branch: 'current-branch',
      model: 'current-model',
      state: 'editing',
      activity: 'Editing current.ts',
      file: 'current.ts',
      tokens: 42,
      cost: 1.25,
    },
    NOW + 1_000,
    true,
  );
  store.record(housekeeping, {}, NOW + 2_000, false);

  assert.deepEqual(store.snapshot(NOW + 2_000), {
    sessionCount: 2,
    provider: 'codex',
    sessionId: 'meaningful-work',
    startedAt: NOW + 500,
    cwd: '/work/current',
    enrichmentRef: '/logs/current.jsonl',
    project: 'current-project',
    branch: 'current-branch',
    model: 'current-model',
    state: 'editing',
    activity: 'Editing current.ts',
    file: 'current.ts',
    tokens: 42,
    cost: 1.25,
  });
});

test('invalid, mismatched, and legacy markers never enter aggregation', () => {
  const sessions = join(root, 'sessions');
  const providerDir = join(sessions, 'claude-code');
  mkdirSync(providerDir, { recursive: true });

  writeFileSync(
    join(sessions, 'legacy.json'),
    JSON.stringify({
      id: 'legacy',
      startedAt: NOW,
      heartbeat: NOW,
      lastActivityAt: NOW,
    }),
  );

  const maliciousId = '../outside';
  const maliciousDigest = createHash('sha256').update(maliciousId).digest('hex');
  writeFileSync(
    join(providerDir, `${maliciousDigest}.json`),
    JSON.stringify({
      provider: 'claude-code',
      sessionId: maliciousId,
      startedAt: NOW,
      heartbeat: NOW,
      lastActivityAt: NOW,
    }),
  );

  const mismatchedId = 'mismatched';
  const mismatchedDigest = createHash('sha256').update(mismatchedId).digest('hex');
  writeFileSync(
    join(providerDir, `${mismatchedDigest}.json`),
    JSON.stringify({
      provider: 'codex',
      sessionId: mismatchedId,
      startedAt: NOW,
      heartbeat: NOW,
      lastActivityAt: NOW,
    }),
  );

  assert.equal(new SessionStore(root).snapshot(NOW), null);
});

test('aggregate rejects invalid provider and raw session identities', () => {
  const marker = {
    provider: 'unknown-provider',
    sessionId: '../outside',
    startedAt: NOW,
    heartbeat: NOW,
    lastActivityAt: NOW,
  } as unknown as SessionMarker;

  assert.equal(aggregate([marker], NOW), null);
});

test('current-session ties use heartbeat then stable identity independent of input order', () => {
  const olderHeartbeat: SessionMarker = {
    provider: 'grok-build',
    sessionId: 'older-heartbeat',
    startedAt: NOW,
    heartbeat: NOW - 1,
    lastActivityAt: NOW,
  };
  const stableWinner: SessionMarker = {
    provider: 'claude-code',
    sessionId: 'a',
    startedAt: NOW,
    heartbeat: NOW,
    lastActivityAt: NOW,
  };
  const stableRunnerUp: SessionMarker = {
    provider: 'codex',
    sessionId: 'a',
    startedAt: NOW,
    heartbeat: NOW,
    lastActivityAt: NOW,
  };

  for (const markers of [
    [olderHeartbeat, stableRunnerUp, stableWinner],
    [stableWinner, olderHeartbeat, stableRunnerUp],
  ]) {
    const snapshot = aggregate(markers, NOW);
    assert.equal(snapshot?.provider, 'claude-code');
    assert.equal(snapshot?.sessionId, 'a');
  }
});

test('child activity updates one root marker without increasing the root-session count', () => {
  const store = new SessionStore(root);
  const rootIdentity = { provider: 'opencode', sessionId: 'root-session' } as const;

  store.record(rootIdentity, { activity: 'Thinking' }, NOW, true);
  store.record(rootIdentity, { activity: 'Running a child tool' }, NOW + 1, true);

  const snapshot = store.snapshot(NOW + 1);
  assert.equal(snapshot?.sessionCount, 1);
  assert.equal(snapshot?.sessionId, 'root-session');
  assert.equal(snapshot?.activity, 'Running a child tool');
});
