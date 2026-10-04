import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockTimeoutError, withFileLock } from '../src/core/file-lock';

const NOW = 1_700_000_000_000;

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vdp-lock-'));
  lock = join(dir, 'nested', 'session.lock');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('runs the critical section, returns its value and releases the lock', () => {
  const value = withFileLock(lock, () => {
    assert.ok(existsSync(lock), 'held while running');
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(existsSync(lock), false);
});

test('releases the lock when the critical section throws', () => {
  assert.throws(() =>
    withFileLock(lock, () => {
      throw new Error('boom');
    }),
  );
  assert.equal(existsSync(lock), false);
});

test('waits for a live owner, then gives up after the timeout', () => {
  withFileLock(lock, () => {
    const start = Date.now();
    assert.throws(
      () => withFileLock(lock, () => assert.fail('must not enter'), { timeoutMs: 50 }),
      LockTimeoutError,
    );
    assert.ok(Date.now() - start >= 50);
    assert.ok(existsSync(lock), 'the owner keeps its lock');
  });
});

test('takes over a lock whose owner is gone or has held it too long', () => {
  const flat = join(dir, 'session.lock');
  const held = (pid: number, at: number) =>
    writeFileSync(flat, JSON.stringify({ pid, token: 'old', at }));

  held(999_999, NOW);
  assert.equal(
    withFileLock(flat, () => 'dead owner', { isAlive: () => false, now: () => NOW }),
    'dead owner',
  );

  held(process.pid, NOW - 10_000);
  assert.equal(
    withFileLock(flat, () => 'stuck owner', { staleAfterMs: 2_000, now: () => NOW }),
    'stuck owner',
  );
  assert.equal(existsSync(flat), false);
});

test('never removes a lock it no longer owns', () => {
  withFileLock(lock, () => {
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now() }),
    );
  });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'someone-else');
});
