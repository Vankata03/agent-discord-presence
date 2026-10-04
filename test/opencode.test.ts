import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/core/session-store';
import {
  END_TYPE,
  parseSnapshots,
  runHook,
  toolActivity,
  translate,
  type OpenCodeSnapshot,
} from '../src/provider/opencode';
import { parseLedger } from '../src/provider/opencode-ledger';
import type { HookRuntime, LedgerHookStore } from '../src/provider/hook-runner';
import type { Translation, TranslateEnv } from '../src/provider/types';

const NOW = 1_700_000_000_000;
const ENV: TranslateEnv = { cwd: '/home/me/fallback' };
const ROOT = 'ses_root';
const CHILD = 'ses_child';
const ID = { provider: 'opencode', sessionId: ROOT } as const;

const line = (type: string, extra: Partial<OpenCodeSnapshot> = {}): OpenCodeSnapshot => ({
  v: 1,
  type,
  root: ROOT,
  session: ROOT,
  cwd: '/work/my-app',
  ...extra,
});
const created = (session = ROOT) => line('session.created', { session });
const status = (value: string, session = ROOT) =>
  line('session.status', { session, status: value });
const busy = (session = ROOT) => status('busy', session);
const idle = (session = ROOT) => line('session.idle', { session });
const tool = (call: string, state: string, name = 'bash', extra: Partial<OpenCodeSnapshot> = {}) =>
  line('message.part.updated', { call, state, tool: name, ...extra });
const asked = (request: string, session = ROOT, type = 'permission.asked') =>
  line(type, { session, request });
const replied = (request?: string, session = ROOT) =>
  line('permission.replied', { session, request });
const message = (
  id: string,
  output?: number,
  cost?: number,
  extra: Partial<OpenCodeSnapshot> = {},
) =>
  line('message.updated', {
    message: id,
    role: 'assistant',
    model: 'mock-large',
    output,
    cost,
    ...extra,
  });

/** Feed snapshots through the translator, threading the ledger like the hook does. */
function session(start: unknown = null) {
  let ledger = start;
  const step = (snapshot: OpenCodeSnapshot, now = NOW): Translation => {
    const result = translate(snapshot, now, ENV, ledger);
    ledger = result.ledger;
    return result.translation;
  };
  return Object.assign(step, { ledger: () => ledger });
}

const patchOf = (t: Translation) => {
  assert.equal(t?.kind, 'update');
  return t.kind === 'update' ? t.patch : {};
};

test("a root's session.created starts its marker and timer", () => {
  const t = session()(created(), NOW + 5);
  assert.deepEqual(t, {
    kind: 'update',
    identity: ID,
    patch: {
      cwd: '/work/my-app',
      project: 'my-app',
      state: 'idle',
      activity: 'Starting a session',
      file: undefined,
      startedAt: NOW + 5,
    },
    activityChanged: true,
  });
});

test('a resumed root (no session.created) starts with its first busy status', () => {
  const s = session();
  assert.equal(s(line('message.updated', { message: 'msg_u', role: 'user' })), null);
  const t = s(busy());
  assert.equal(patchOf(t).activity, 'Thinking');
  assert.equal(patchOf(t).startedAt, undefined, 'the store starts the timer for a new marker');
});

test('housekeeping and end events never revive an untracked root', () => {
  for (const snapshot of [
    line('session.updated', { output: 5, cost: 1 }),
    message('msg_1', 5, 1),
    idle(),
    status('idle'),
    line('session.error'),
    replied('per_1'),
    tool('call_1', 'completed'),
    created(CHILD),
    line('session.deleted', { session: CHILD }),
    line('file.edited'),
  ]) {
    const result = translate(snapshot, NOW, ENV, null);
    assert.equal(result.translation, null, snapshot.type);
    assert.equal(result.ledger, null, snapshot.type);
  }
});

test('a missing cwd falls back to the environment', () => {
  const t = session()({ ...created(), cwd: undefined });
  assert.equal(patchOf(t).cwd, '/home/me/fallback');
  assert.equal(patchOf(t).project, 'fallback');
});

test('parallel tools: the newest running tool shows until it completes, in any order', () => {
  const s = session();
  s(created());
  s(busy());
  assert.equal(patchOf(s(tool('call_a', 'pending'))).activity, 'Running a command');
  s(tool('call_a', 'running'));
  s(tool('call_b', 'pending', 'read'));
  const reading = patchOf(s(tool('call_b', 'running', 'read', { file: '/work/my-app/README.md' })));
  assert.equal(reading.activity, 'Reading README.md');
  assert.equal(reading.file, 'README.md');
  // The read finishes first; the command that started earlier is still running.
  const back = patchOf(s(tool('call_b', 'completed', 'read')));
  assert.equal(back.activity, 'Running a command');
  assert.equal(back.file, undefined);
  assert.equal(patchOf(s(tool('call_a', 'completed'))).activity, 'Thinking');
});

test('a running update keeps the call’s start order; an error part ends the call', () => {
  const s = session();
  s(busy());
  s(tool('call_a', 'running', 'write', { file: '/w/a.ts' }));
  s(tool('call_b', 'running', 'edit', { file: '/w/b.ts' }));
  // A later update to the older call does not make it the newest.
  assert.equal(patchOf(s(tool('call_a', 'running', 'write', { file: '/w/a.ts' }))).file, 'b.ts');
  assert.equal(patchOf(s(tool('call_b', 'error', 'edit'))).activity, 'Editing a.ts');
});

test('permission requests: both event names start a wait, the reply ends it', () => {
  for (const type of ['permission.asked', 'permission.updated']) {
    const s = session();
    s(busy());
    s(tool('call_a', 'running'));
    const waiting = patchOf(s(asked('per_1', ROOT, type)));
    assert.deepEqual([waiting.state, waiting.activity], ['waiting', 'Waiting for permission']);
    assert.equal(patchOf(s(replied('per_1'))).activity, 'Running a command', type);
  }
});

test('a permission wait outranks a newer tool and lasts until its own reply', () => {
  const s = session();
  s(busy());
  s(asked('per_1'));
  s(asked('per_2'));
  assert.equal(patchOf(s(tool('call_b', 'running', 'read'))).activity, 'Waiting for permission');
  assert.equal(patchOf(s(replied('per_1'))).activity, 'Waiting for permission');
  assert.equal(patchOf(s(replied('per_2'))).activity, 'Searching the codebase');
});

test('an aborted request gets no reply: the session error or idle ends the wait', () => {
  const viaError = session();
  viaError(busy());
  viaError(asked('per_1'));
  assert.equal(patchOf(viaError(line('session.error'))).activity, 'Thinking');

  const viaIdle = session();
  viaIdle(busy());
  viaIdle(asked('per_1'));
  assert.equal(patchOf(viaIdle(idle())).activity, 'Idle');

  // A reply naming no known request still ends the session's waits.
  const unnamed = session();
  unnamed(busy());
  unnamed(asked('per_1'));
  assert.equal(patchOf(unnamed(replied(undefined))).activity, 'Thinking');
});

test('a retry wait outranks tools but not a permission wait', () => {
  const s = session();
  s(busy());
  s(tool('call_a', 'running'));
  assert.equal(patchOf(s(status('retry'))).activity, 'Waiting to retry');
  assert.equal(patchOf(s(asked('per_1'))).activity, 'Waiting for permission');
  s(replied('per_1'));
  assert.equal(patchOf(s(busy())).activity, 'Running a command');
});

test('child work is attributed to the root, by the documented priority', () => {
  const s = session();
  s(created());
  s(busy());
  s(tool('call_task', 'running', 'task'));
  assert.equal(patchOf(s(created(CHILD))).activity, 'Running a subagent');
  s(busy(CHILD));
  // A running child tool outranks a newer root tool.
  s(tool('call_child', 'running', 'bash', { session: CHILD }));
  assert.equal(
    patchOf(s(tool('call_root', 'running', 'read', { file: '/w/x.md' }))).activity,
    'Running a command',
  );
  // With no child tool, the root tool shows; then an active child session.
  assert.equal(
    patchOf(s(tool('call_child', 'completed', 'bash', { session: CHILD }))).file,
    'x.md',
  );
  s(tool('call_root', 'completed', 'read'));
  s(tool('call_task', 'completed', 'task'));
  assert.equal(patchOf(s(busy())).activity, 'Running a subagent');
  // The child goes idle; the busy root shows thinking.
  assert.equal(patchOf(s(idle(CHILD))).activity, 'Thinking');
  assert.equal(patchOf(s(idle())).activity, 'Idle');
});

test("a child's permission request and its own idle are scoped to the child", () => {
  const s = session();
  s(busy());
  s(busy(CHILD));
  s(tool('call_root', 'running', 'read'));
  s(asked('per_c', CHILD));
  assert.equal(patchOf(s(idle(CHILD))).activity, 'Searching the codebase');
});

test("the root's idle clears whatever its children and rejected calls left", () => {
  const s = session();
  s(busy());
  s(busy(CHILD));
  s(tool('call_child', 'running', 'bash', { session: CHILD }));
  s(asked('per_c', CHILD));
  s(status('retry', CHILD));
  assert.equal(patchOf(s(idle())).activity, 'Idle');
  assert.equal(patchOf(s(busy())).activity, 'Thinking');
});

test('repeated message updates replace earlier values for the same message id', () => {
  const s = session();
  s(busy());
  s(message('msg_1', 0, 0));
  s(message('msg_1', 182, 0.000464));
  const once = patchOf(s(message('msg_1', 182, 0.000464)));
  assert.deepEqual([once.tokens, once.cost], [182, 0.000464]);
  s(message('msg_2', 0, 0));
  const both = patchOf(s(message('msg_2', 189, 0.000478)));
  assert.equal(both.tokens, 371);
  assert.equal(both.cost?.toFixed(6), '0.000942');
  // User messages carry no usage.
  assert.equal(patchOf(s(message('msg_u', undefined, undefined, { role: 'user' }))).tokens, 371);
});

test("children's usage adds to the root's; the session aggregate covers resumed turns", () => {
  const s = session();
  s(busy());
  // After a resume the root's aggregate already holds earlier turns.
  s(line('session.updated', { output: 1000, cost: 0.002 }));
  const resumed = patchOf(s(message('msg_new', 200, 0.0005)));
  assert.equal(resumed.tokens, 1000, 'an aggregate ahead of the messages wins');
  s(message('msg_child', 50, 0.0001, { session: CHILD }));
  assert.equal(patchOf(s(message('msg_new', 1300, 0.003))).tokens, 1350, 'messages ahead win');
  // A child's aggregate replaces only the child's share.
  assert.equal(patchOf(s(line('session.updated', { session: CHILD, output: 80 }))).tokens, 1380);
  // Housekeeping only proves liveness.
  const t = s(line('session.updated', { output: 1300 }));
  assert.equal(t?.kind === 'update' && t.activityChanged, false);
});

test('missing usage stays absent rather than zero', () => {
  const patch = patchOf(session()(busy()));
  assert.equal('tokens' in patch, false);
  assert.equal('cost' in patch, false);
  assert.equal('model' in patch, false);
});

test("the model is the root's newest, never a child's once the root has one", () => {
  const s = session();
  s(busy());
  assert.equal(
    patchOf(s(line('session.updated', { model: 'from-session' }))).model,
    'from-session',
  );
  assert.equal(patchOf(s(message('msg_1', 1, 0, { model: 'big' }))).model, 'big');
  assert.equal(patchOf(s(message('msg_c', 1, 0, { session: CHILD, model: 'small' }))).model, 'big');
  const user = message('msg_u', undefined, undefined, { role: 'user', model: 'picked' });
  assert.equal(patchOf(s(user)).model, 'picked');
  // A child's model fills in only when the root has none.
  const fresh = session();
  fresh(busy());
  assert.equal(
    patchOf(fresh(message('m', 1, 0, { session: CHILD, model: 'small' }))).model,
    'small',
  );
});

test('the plugin end line and a deleted root end the marker; a deleted child does not', () => {
  const s = session();
  s(busy());
  assert.deepEqual(s(line(END_TYPE, { session: undefined })), { kind: 'end', identity: ID });
  assert.equal(s.ledger(), null);

  const d = session();
  d(busy());
  d(busy(CHILD));
  d(tool('call_child', 'running', 'bash', { session: CHILD }));
  assert.equal(patchOf(d(line('session.deleted', { session: CHILD }))).activity, 'Thinking');
  assert.deepEqual(d(line('session.deleted')), { kind: 'end', identity: ID });
});

test('an end needs no ledger: it is idempotent', () => {
  assert.deepEqual(translate(line(END_TYPE), NOW, ENV, null).translation, {
    kind: 'end',
    identity: ID,
  });
});

test('tool activity: families, explicit file paths only, open-ended fallback', () => {
  assert.deepEqual(toolActivity('edit', '/w/src/a.ts'), {
    state: 'editing',
    activity: 'Editing a.ts',
    file: 'a.ts',
  });
  assert.deepEqual(toolActivity('write'), { state: 'editing', activity: 'Editing' });
  assert.equal(toolActivity('apply_patch').state, 'editing');
  assert.equal(toolActivity('bash', '/not/a/file').file, undefined);
  assert.equal(toolActivity('grep').state, 'searching');
  assert.equal(toolActivity('webfetch').state, 'browsing');
  assert.equal(toolActivity('task').state, 'delegating');
  assert.equal(toolActivity('todowrite').activity, 'Planning');
  assert.equal(toolActivity('question').activity, 'Waiting for your answer');
  assert.deepEqual(toolActivity('github_create_issue'), {
    state: 'running',
    activity: 'Using github_create_issue',
  });
  assert.equal(toolActivity(undefined).activity, 'Working');
});

test('the ledger stays bounded, and folded messages keep the totals exact', () => {
  const s = session();
  s(busy());
  for (let i = 0; i < 300; i++) s(message(`msg_${i}`, 10, 0.001));
  // An update to a folded message cannot be matched, so only recent ones are replaced.
  const t = patchOf(s(message('msg_299', 20, 0.002)));
  assert.equal(t.tokens, 3010);
  for (let i = 0; i < 100; i++) s(tool(`call_${i}`, 'running'));
  const ledger = parseLedger(s.ledger(), ROOT);
  assert.ok(ledger);
  assert.ok(ledger.messages.length <= 256);
  assert.ok(ledger.tools.length <= 64);
});

test('a damaged or foreign ledger is treated as absent', () => {
  assert.equal(parseLedger({ version: 2, root: ROOT, seq: 1 }, ROOT), null);
  assert.equal(parseLedger({ version: 1, root: 'other', seq: 1 }, ROOT), null);
  const parsed = parseLedger(
    { version: 1, root: ROOT, seq: 3, tools: [{ call: 'x' }, null], sessions: 'nope' },
    ROOT,
  );
  assert.deepEqual(parsed?.tools, []);
  assert.deepEqual(parsed?.sessions, []);
});

test('parseSnapshots keeps well-formed lines in order and skips the rest', () => {
  const raw = [
    '\ufeff' + JSON.stringify(busy()),
    '{not json',
    JSON.stringify({ ...busy(), v: 2 }),
    JSON.stringify({ ...busy(), root: '' }),
    '',
    JSON.stringify(idle()),
  ].join('\n');
  assert.deepEqual(
    parseSnapshots(raw).map((s) => s.type),
    ['session.status', 'session.idle'],
  );
});

// ---- the hook process: one stdin batch, many events ----

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-opencode-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runtime(
  input: string,
  onDaemon: () => void = () => {},
  now = NOW,
): HookRuntime<LedgerHookStore> {
  return {
    readInput: () => input,
    now: () => now,
    environment: () => ENV,
    root: () => root,
    createStore: (r) => new SessionStore(r),
    ensureDaemon: onDaemon,
  };
}
const jsonl = (...snapshots: OpenCodeSnapshot[]) =>
  snapshots.map((s) => JSON.stringify(s)).join('\n') + '\n';

test('a batch applies every line in order, then ensures the daemon once', async () => {
  let daemons = 0;
  // Another root, active in an earlier batch.
  const other = { root: 'ses_other', session: 'ses_other' };
  await runHook(
    [],
    runtime(jsonl(line('session.status', { ...other, status: 'busy' })), () => {}, NOW - 1000),
  );
  await runHook(
    [],
    runtime(
      jsonl(
        created(),
        busy(),
        tool('call_a', 'running', 'edit', { file: '/w/a.ts' }),
        message('msg_1', 7, 0.5),
      ),
      () => daemons++,
    ),
  );
  assert.equal(daemons, 1);
  const state = new SessionStore(root).snapshot(NOW);
  assert.equal(state?.sessionCount, 2);
  assert.equal(state?.sessionId, ROOT);
  assert.equal(state?.startedAt, NOW);
  assert.equal(state?.activity, 'Editing a.ts');
  assert.equal(state?.tokens, 7);
  assert.equal(state?.cost, 0.5);
  assert.equal(state?.model, 'mock-large');
});

test('one broken line never stops the lines after it', async () => {
  await runHook([], runtime(jsonl(line('session.status', { root: '..', status: 'busy' }), busy())));
  assert.equal(new SessionStore(root).snapshot(NOW)?.sessionId, ROOT);
});

test('an end-only batch removes the marker without starting the daemon', async () => {
  await runHook([], runtime(jsonl(busy())));
  let daemons = 0;
  await runHook(
    [],
    runtime(jsonl(line(END_TYPE)), () => daemons++),
  );
  assert.equal(daemons, 0);
  assert.equal(new SessionStore(root).snapshot(NOW), null);
  assert.equal(new SessionStore(root).readLedger(ID), null);
});

test('the hook is fail-open on empty or garbage input', async () => {
  let daemons = 0;
  await assert.doesNotReject(() =>
    runHook(
      [],
      runtime('', () => daemons++),
    ),
  );
  await assert.doesNotReject(() =>
    runHook(
      [],
      runtime('\0garbage', () => daemons++),
    ),
  );
  assert.equal(daemons, 0);
});
