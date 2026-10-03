import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, translate, type CodexHookPayload } from '../src/provider/codex';
import type { HookRuntime } from '../src/provider/hook-runner';
import type { TranslateEnv } from '../src/provider/types';
import type { SessionIdentity, SessionMarkerPatch } from '../src/types';

const NOW = 1_700_000_000_000;
const ENV: TranslateEnv = { cwd: '/home/me/fallback-proj' };
const ID = { provider: 'codex', sessionId: 'thread-1' } as const;
const BASE: CodexHookPayload = {
  session_id: 'thread-1',
  cwd: '/work/my-app',
  model: 'gpt-5.5-codex',
  transcript_path: '/home/me/.codex/sessions/2026/10/03/rollout-1.jsonl',
};
const COMMON = {
  cwd: '/work/my-app',
  project: 'my-app',
  model: 'gpt-5.5-codex',
  enrichmentRef: '/home/me/.codex/sessions/2026/10/03/rollout-1.jsonl',
};

function update(event: string, extra: Partial<CodexHookPayload> = {}) {
  return translate(event, { ...BASE, ...extra }, NOW, ENV);
}

function visible(event: string, extra: Partial<CodexHookPayload> = {}) {
  const r = update(event, extra);
  assert.equal(r?.kind, 'update', event);
  return r?.kind === 'update' ? { ...r.patch, activityChanged: r.activityChanged } : null;
}

test('startup, resume, clear and fork reset the timer and show a starting session', () => {
  for (const source of ['startup', 'resume', 'clear', 'fork']) {
    assert.deepEqual(
      update('session-start', { source }),
      {
        kind: 'update',
        identity: ID,
        activityChanged: true,
        patch: {
          ...COMMON,
          state: 'idle',
          activity: 'Starting a session',
          file: undefined,
          startedAt: NOW,
        },
      },
      source,
    );
  }
});

test('compaction refreshes liveness without touching the timer or visible activity', () => {
  for (const [event, extra] of [
    ['session-start', { source: 'compact' }],
    ['pre-compact', { trigger: 'auto' }],
    ['post-compact', { trigger: 'manual' }],
  ] as const) {
    assert.deepEqual(
      update(event, extra as Partial<CodexHookPayload>),
      { kind: 'update', identity: ID, activityChanged: false, patch: COMMON },
      event,
    );
  }
});

test('an unknown event only proves liveness', () => {
  assert.deepEqual(update('something-new'), {
    kind: 'update',
    identity: ID,
    activityChanged: false,
    patch: COMMON,
  });
});

test('the basic lifecycle: prompt, permission, tool, subagent, stop and interrupt', () => {
  const cases: Array<[string, Partial<CodexHookPayload>, string, string]> = [
    ['user-prompt-submit', {}, 'thinking', 'Thinking'],
    ['permission-request', { tool_name: 'Bash' }, 'waiting', 'Waiting for permission'],
    ['pre-tool-use', { tool_name: 'Bash' }, 'running', 'Running a command'],
    ['post-tool-use', { tool_name: 'Bash' }, 'thinking', 'Thinking'],
    ['subagent-start', {}, 'delegating', 'Running a subagent'],
    ['subagent-stop', {}, 'thinking', 'Thinking'],
    ['stop', {}, 'idle', 'Idle'],
    ['interrupt', {}, 'idle', 'Idle'],
  ];
  for (const [event, extra, state, activity] of cases) {
    const patch = visible(event, extra);
    assert.equal(patch?.state, state, event);
    assert.equal(patch?.activity, activity, event);
    assert.equal(patch?.activityChanged, true, event);
    assert.equal(patch?.startedAt, undefined, `${event} keeps the timer`);
  }
});

test('tool families map to activities with an open-ended fallback', () => {
  const cases: Array<[string, string, string]> = [
    ['apply_patch', 'editing', 'Editing'],
    ['exec_command', 'running', 'Running a command'],
    ['grep_files', 'searching', 'Searching the codebase'],
    ['web_search', 'browsing', 'Browsing the web'],
    ['spawn_agent', 'delegating', 'Running a subagent'],
    ['mcp__github__create_issue', 'running', 'Using mcp__github__create_issue'],
    ['brand_new_tool', 'running', 'Using brand_new_tool'],
  ];
  for (const [tool, state, activity] of cases) {
    const patch = visible('pre-tool-use', { tool_name: tool });
    assert.deepEqual([patch?.state, patch?.activity], [state, activity], tool);
  }
});

test('filenames come only from explicit path fields, never from patch or command text', () => {
  const patch = visible('pre-tool-use', {
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: src/secret.ts\n' },
  });
  assert.equal(patch?.file, undefined);
  assert.equal(patch?.activity, 'Editing');

  const explicit = visible('pre-tool-use', {
    tool_name: 'Write',
    tool_input: { file_path: '/work/my-app/src/index.ts' },
  });
  assert.deepEqual([explicit?.file, explicit?.activity], ['index.ts', 'Editing index.ts']);

  const shell = visible('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'cat a.ts' } });
  assert.equal(shell?.file, undefined);
});

test('session end removes the session; a missing session id is ignored', () => {
  assert.deepEqual(update('session-end', { reason: 'other' } as Partial<CodexHookPayload>), {
    kind: 'end',
    identity: ID,
  });
  assert.equal(translate('stop', { cwd: '/x' }, NOW, ENV), null);
});

test('missing payload fields fall back to the environment and stay absent', () => {
  const r = translate('stop', { session_id: 's', transcript_path: null }, NOW, ENV);
  assert.deepEqual(r?.kind === 'update' && r.patch, {
    cwd: ENV.cwd,
    project: 'fallback-proj',
    state: 'idle',
    activity: 'Idle',
    file: undefined,
  });
});

function runtime(
  input: string,
  sink: { records: unknown[]; ended: SessionIdentity[]; daemons: number },
): HookRuntime {
  return {
    readInput: () => input,
    now: () => NOW,
    environment: () => ENV,
    root: () => '/presence',
    createStore: () => ({
      record: (identity, patch: SessionMarkerPatch, now, activityChanged) => {
        sink.records.push({ identity, patch, now, activityChanged });
      },
      end: (identity) => {
        sink.ended.push(identity);
      },
    }),
    ensureDaemon: () => {
      sink.daemons++;
    },
  };
}

test('accepted events record the session and ensure the daemon; session end never starts it', async () => {
  const sink = { records: [] as unknown[], ended: [] as SessionIdentity[], daemons: 0 };
  await runHook(['user-prompt-submit'], runtime(JSON.stringify(BASE), sink));
  assert.equal(sink.records.length, 1);
  assert.equal(sink.daemons, 1);

  await runHook(['session-end'], runtime(JSON.stringify(BASE), sink));
  await runHook(['session-end'], runtime(JSON.stringify(BASE), sink));
  assert.deepEqual(sink.ended, [ID, ID]);
  assert.equal(sink.daemons, 1, 'session end never starts the daemon');
});

test('the Codex hook runner fails open on malformed input and internal errors', async () => {
  const broken: HookRuntime = {
    readInput: () => '{broken',
    now: () => NOW,
    environment: () => ENV,
    root: () => '/presence',
    createStore: () => {
      throw new Error('unavailable');
    },
    ensureDaemon: () => {
      throw new Error('unavailable');
    },
  };
  await assert.doesNotReject(() => runHook(['stop'], broken));
  await assert.doesNotReject(() =>
    runHook(['stop'], { ...broken, readInput: () => JSON.stringify(BASE) }),
  );
});
