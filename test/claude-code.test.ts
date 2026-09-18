import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, type HookPayload, type TranslateEnv } from '../src/provider/claude-code';
import type { ActivityState } from '../src/types';

const NOW = 1_700_000_000_000;
const ENV: TranslateEnv = { cwd: '/home/me/fallback-proj' };
const BASE: HookPayload = {
  session_id: 'sess-1',
  cwd: '/work/my-app',
  transcript_path: '/t.jsonl',
};

/** The marker patch every non-end event carries before the activity fields. */
const COMMON = {
  cwd: '/work/my-app',
  project: 'my-app',
  transcriptPath: '/t.jsonl',
};

function update(event: string, extra: Partial<HookPayload> = {}) {
  return translate(event, { ...BASE, ...extra }, NOW, ENV);
}

test('session-start resets the elapsed timer and reports a starting session', () => {
  assert.deepEqual(update('session-start', { source: 'startup' }), {
    kind: 'update',
    id: 'sess-1',
    patch: {
      ...COMMON,
      state: 'idle',
      activity: 'Starting a session',
      file: undefined,
      startedAt: NOW,
    },
  });
});

test('a resumed or cleared session also restarts the timer', () => {
  for (const source of ['resume', 'clear', undefined]) {
    const r = update('session-start', { source });
    assert.equal(r?.kind === 'update' && r.patch.startedAt, NOW, `source=${source}`);
  }
});

test('an auto-compaction keeps the original start time', () => {
  const r = update('session-start', { source: 'compact' });
  assert.equal(r?.kind, 'update');
  assert.ok(r?.kind === 'update' && !('startedAt' in r.patch));
});

test('user-prompt-submit means thinking; stop means idle; an unknown event means working', () => {
  const cases: Array<[string, ActivityState, string]> = [
    ['user-prompt-submit', 'thinking', 'Thinking'],
    ['stop', 'idle', 'Idle'],
    ['something-new', 'idle', 'Working'],
  ];
  for (const [event, state, activity] of cases) {
    const r = update(event);
    assert.deepEqual(
      r,
      { kind: 'update', id: 'sess-1', patch: { ...COMMON, state, activity, file: undefined } },
      event,
    );
  }
});

test('pre-tool-use maps every tool to an activity state and sentence', () => {
  const cases: Array<
    [string, Record<string, unknown> | undefined, ActivityState, string, string?]
  > = [
    ['Edit', { file_path: '/work/my-app/src/index.ts' }, 'editing', 'Editing index.ts', 'index.ts'],
    ['Write', { file_path: '/work/notes.md' }, 'editing', 'Editing notes.md', 'notes.md'],
    ['MultiEdit', { file_path: 'a/b.ts' }, 'editing', 'Editing b.ts', 'b.ts'],
    ['NotebookEdit', { file_path: 'nb.ipynb' }, 'editing', 'Editing nb.ipynb', 'nb.ipynb'],
    ['Edit', undefined, 'editing', 'Editing', undefined],
    ['Read', { file_path: 'src/x.ts' }, 'searching', 'Reading x.ts', 'x.ts'],
    ['Read', {}, 'searching', 'Reading', undefined],
    ['Bash', { command: 'ls' }, 'running', 'Running a command', undefined],
    ['Grep', { pattern: 'x' }, 'searching', 'Searching the codebase', undefined],
    ['Glob', undefined, 'searching', 'Searching the codebase', undefined],
    ['LS', undefined, 'searching', 'Searching the codebase', undefined],
    ['WebFetch', { url: 'https://x' }, 'browsing', 'Browsing the web', undefined],
    ['WebSearch', undefined, 'browsing', 'Browsing the web', undefined],
    ['Task', undefined, 'delegating', 'Running a subagent', undefined],
    ['Agent', undefined, 'delegating', 'Running a subagent', undefined],
    ['SomeNewTool', undefined, 'running', 'Using SomeNewTool', undefined],
  ];
  for (const [tool, input, state, activity, file] of cases) {
    const r = update('pre-tool-use', { tool_name: tool, tool_input: input });
    assert.deepEqual(
      r,
      { kind: 'update', id: 'sess-1', patch: { ...COMMON, state, activity, file } },
      `${tool}`,
    );
  }
});

test('pre-tool-use without a tool name is generic work', () => {
  const r = update('pre-tool-use');
  assert.ok(r?.kind === 'update');
  assert.equal(r.patch.state, 'running');
  assert.equal(r.patch.activity, 'Working');
});

test('a file_path that is not a string yields no file', () => {
  const r = update('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: 42 } });
  assert.ok(r?.kind === 'update');
  assert.equal(r.patch.activity, 'Editing');
  assert.equal(r.patch.file, undefined);
});

test('a notification mentioning permission is waiting; any other notification is idle', () => {
  const waiting = update('notification', { message: 'Claude needs your PERMISSION to run Bash' });
  assert.ok(waiting?.kind === 'update');
  assert.equal(waiting.patch.state, 'waiting');
  assert.equal(waiting.patch.activity, 'Waiting for permission');

  for (const message of ['Claude is waiting for your input', '', undefined]) {
    const idle = update('notification', { message });
    assert.ok(idle?.kind === 'update');
    assert.equal(idle.patch.state, 'idle', `message=${message}`);
    assert.equal(idle.patch.activity, 'Idle');
  }
});

test('session-end ends the session and carries nothing else', () => {
  assert.deepEqual(update('session-end'), { kind: 'end', id: 'sess-1' });
});

test('the session id falls back to the environment, then the event is dropped', () => {
  const noId: HookPayload = { cwd: '/work/my-app' };
  const fromEnv = translate('stop', noId, NOW, { ...ENV, sessionId: 'env-sess' });
  assert.equal(fromEnv?.id, 'env-sess');
  assert.deepEqual(translate('session-end', noId, NOW, { ...ENV, sessionId: 'env-sess' }), {
    kind: 'end',
    id: 'env-sess',
  });
  assert.equal(translate('stop', noId, NOW, ENV), null);
  assert.equal(translate('session-end', noId, NOW, ENV), null);
  assert.equal(translate('stop', { ...noId, session_id: '' }, NOW, ENV), null, 'empty id');
});

test('a malformed payload is treated as empty: cwd comes from the environment', () => {
  const r = translate('user-prompt-submit', null, NOW, { cwd: '/srv/proj', sessionId: 's' });
  assert.deepEqual(r, {
    kind: 'update',
    id: 's',
    patch: {
      cwd: '/srv/proj',
      project: 'proj',
      transcriptPath: undefined,
      state: 'thinking',
      activity: 'Thinking',
      file: undefined,
    },
  });
});

test('the payload cwd wins over the environment cwd', () => {
  const r = translate('stop', { session_id: 's', cwd: '/a/b' }, NOW, { cwd: '/c/d' });
  assert.ok(r?.kind === 'update');
  assert.equal(r.patch.cwd, '/a/b');
  assert.equal(r.patch.project, 'b');
});
