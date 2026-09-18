import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonState, type DaemonStatus } from '../src/core/daemon-state';

const NOW = 1_700_000_000_000;
const ME = 1000;
const OTHER = 2000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-daemon-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A daemon-state view for `pid`, on a machine where only `alive` pids exist. */
function state(pid: number, alive: number[]): DaemonState {
  return new DaemonState(root, { pid, isAlive: (p) => alive.includes(p) });
}

test('acquireLock creates <root>/daemon.lock holding the pid and start time', () => {
  const me = state(ME, [ME]);
  assert.equal(me.acquireLock(NOW), true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'daemon.lock'), 'utf8')), {
    pid: ME,
    startedAt: NOW,
  });
  assert.deepEqual(me.readLock(), { pid: ME, startedAt: NOW });
});

test('acquireLock refuses while a live daemon holds the lock', () => {
  assert.equal(state(OTHER, [OTHER, ME]).acquireLock(NOW), true);
  const me = state(ME, [OTHER, ME]);
  assert.equal(me.acquireLock(NOW + 1), false);
  assert.equal(me.readLock()?.pid, OTHER, 'the other daemon still owns it');
});

test('acquireLock takes over a lock whose pid is dead', () => {
  assert.equal(state(OTHER, [OTHER]).acquireLock(NOW), true);
  const me = state(ME, [ME]); // OTHER has since died
  assert.equal(me.acquireLock(NOW + 1), true);
  assert.deepEqual(me.readLock(), { pid: ME, startedAt: NOW + 1 });
});

test('acquireLock takes over a corrupt lock file', () => {
  writeFileSync(join(root, 'daemon.lock'), 'not json');
  const me = state(ME, [ME]);
  assert.equal(me.acquireLock(NOW), true);
  assert.equal(me.readLock()?.pid, ME);
});

test('re-acquiring our own lock succeeds', () => {
  const me = state(ME, [ME]);
  assert.equal(me.acquireLock(NOW), true);
  assert.equal(me.acquireLock(NOW + 1), true);
  assert.equal(me.readLock()?.startedAt, NOW + 1);
});

test('releaseLock removes the lock only when we own it', () => {
  const other = state(OTHER, [OTHER, ME]);
  other.acquireLock(NOW);
  state(ME, [OTHER, ME]).releaseLock();
  assert.equal(other.readLock()?.pid, OTHER, 'not ours, left alone');
  other.releaseLock();
  assert.equal(other.readLock(), null);
  assert.doesNotThrow(() => other.releaseLock(), 'already gone is fine');
});

test('daemon status round-trips through <root>/state.json and clears', () => {
  const me = state(ME, [ME]);
  const status: DaemonStatus = {
    pid: ME,
    connected: true,
    sessionCount: 2,
    activity: 'Editing a.ts',
    updatedAt: NOW,
  };
  assert.equal(me.readStatus(), null);
  me.writeStatus(status);
  assert.deepEqual(me.readStatus(), status);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), JSON.stringify(status));
  assert.deepEqual(readdirSync(root), ['state.json'], 'no temp file left behind');
  me.clearStatus();
  assert.equal(me.readStatus(), null);
  assert.ok(!existsSync(join(root, 'state.json')));
  assert.doesNotThrow(() => me.clearStatus());
});

test('writeStatus is best-effort: an unwritable root does not throw', () => {
  const blocked = join(root, 'file-not-dir');
  writeFileSync(blocked, '');
  const me = new DaemonState(join(blocked, 'child'), { pid: ME, isAlive: () => true });
  assert.doesNotThrow(() =>
    me.writeStatus({ pid: ME, connected: false, sessionCount: 0, updatedAt: NOW }),
  );
});

test('stop is a no-op when no daemon is running', async () => {
  const me = state(ME, [ME]);
  assert.equal(await me.stop(), null, 'no lock');
  state(OTHER, [OTHER]).acquireLock(NOW);
  assert.equal(await me.stop(), null, 'lock held by a dead pid');
});

// Review follow-up (PR #8): stale-lock takeover must not clear a lock another
// daemon created between our read and our retry.
test('takeover leaves no stale tombstone behind', () => {
  state(OTHER, [OTHER]).acquireLock(NOW);
  assert.equal(state(ME, [ME]).acquireLock(NOW + 1), true);
  assert.deepEqual(readdirSync(root), ['daemon.lock']);
});

test('takeover yields when a live daemon replaced the stale lock first', () => {
  const THIRD = 3000;
  state(OTHER, [OTHER]).acquireLock(NOW); // OTHER then dies
  // ME reads the stale lock; before ME moves it aside, THIRD takes it over.
  let raced = false;
  const me = new DaemonState(root, {
    pid: ME,
    isAlive: (p) => {
      if (p === OTHER && !raced) {
        raced = true;
        state(THIRD, [THIRD]).acquireLock(NOW + 1);
      }
      return p === ME || p === THIRD;
    },
  });
  assert.equal(me.acquireLock(NOW + 2), false);
  assert.deepEqual(me.readLock(), { pid: THIRD, startedAt: NOW + 1 }, 'THIRD keeps its lock');
  assert.deepEqual(readdirSync(root), ['daemon.lock']);
});
