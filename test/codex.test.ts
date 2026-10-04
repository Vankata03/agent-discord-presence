import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/core/session-store';
import {
  CODEX_HOOK_EVENTS,
  runHook,
  translate,
  type CodexHookPayload,
} from '../src/provider/codex';
import { SESSION_AGENT_STALE_MS } from '../src/provider/codex-ledger';
import type { HookRuntime, LedgerHookStore } from '../src/provider/hook-runner';
import type { TranslateEnv } from '../src/provider/types';
import type { SessionIdentity, SessionMarker } from '../src/types';

const NOW = 1_700_000_000_000;
const ENV: TranslateEnv = { cwd: '/home/me/fallback-proj' };
const ID = { provider: 'codex', sessionId: 'thread-1' } as const;
const ROLLOUT = '/home/me/.codex/sessions/2026/10/03/rollout-1.jsonl';
const BASE: CodexHookPayload = {
  session_id: 'thread-1',
  cwd: '/work/my-app',
  model: 'gpt-5.5-codex',
  transcript_path: ROLLOUT,
};
const COMMON = {
  cwd: '/work/my-app',
  project: 'my-app',
  model: 'gpt-5.5-codex',
  enrichmentRef: ROLLOUT,
};
const ARG_FOR = new Map(CODEX_HOOK_EVENTS.map(({ name, arg }) => [name, arg]));

type Step = [event: string, extra?: Partial<CodexHookPayload>];

/** Feed events through the translator, threading the ledger like the hook does. */
function session(start: unknown = null) {
  let ledger = start;
  return (event: string, extra: Partial<CodexHookPayload> = {}, now = NOW) => {
    const { translation, ledger: next } = translate(event, { ...BASE, ...extra }, now, ENV, ledger);
    ledger = next;
    return translation;
  };
}

/** The visible activity after each event of a sequence. */
function activities(steps: Step[]): string[] {
  const send = session();
  return steps.map(([event, extra]) => {
    const r = send(event, extra);
    assert.equal(r?.kind, 'update', event);
    return r?.kind === 'update' ? (r.patch.activity ?? '(unchanged)') : '';
  });
}

test('startup, resume, clear and fork reset the timer and show a starting session', () => {
  for (const source of ['startup', 'resume', 'clear', 'fork']) {
    const { translation } = translate('session-start', { ...BASE, source }, NOW, ENV);
    assert.deepEqual(
      translation,
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

test('a new session forgets the previous session’s tools, subagents and waits', () => {
  const send = session();
  send('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'a' });
  send('subagent-start', { agent_id: 'agent-1' });
  send('permission-request', { tool_name: 'Bash' });
  const r = send('session-start', { source: 'resume' });
  assert.equal(r?.kind === 'update' && r.patch.activity, 'Starting a session');
  const next = send('user-prompt-submit');
  assert.equal(next?.kind === 'update' && next.patch.activity, 'Thinking');
});

test('compaction refreshes liveness without touching the timer or visible activity', () => {
  const send = session();
  send('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'a' });
  for (const [event, extra] of [
    ['session-start', { source: 'compact' }],
    ['pre-compact', { trigger: 'auto' }],
    ['post-compact', { trigger: 'manual' }],
  ] as const) {
    assert.deepEqual(
      send(event, extra as Partial<CodexHookPayload>),
      { kind: 'update', identity: ID, activityChanged: false, patch: COMMON },
      event,
    );
  }
  const after = send('user-prompt-submit');
  assert.equal(after?.kind === 'update' && after.patch.activity, 'Thinking');
});

test('an unknown event only proves liveness', () => {
  assert.deepEqual(session()('something-new'), {
    kind: 'update',
    identity: ID,
    activityChanged: false,
    patch: COMMON,
  });
});

test('the basic lifecycle: prompt, permission, tool, subagent, stop and interrupt', () => {
  assert.deepEqual(
    activities([
      ['user-prompt-submit'],
      ['pre-tool-use', { tool_name: 'Bash', tool_use_id: 't1' }],
      ['permission-request', { tool_name: 'Bash' }],
      ['post-tool-use', { tool_name: 'Bash', tool_use_id: 't1' }],
      ['subagent-start', { agent_id: 'a1' }],
      ['subagent-stop', { agent_id: 'a1' }],
      ['stop'],
      ['user-prompt-submit'],
      ['interrupt'],
    ]),
    [
      'Thinking',
      'Running a command',
      'Waiting for permission',
      'Thinking',
      'Running a subagent',
      'Thinking',
      'Idle',
      'Thinking',
      'Idle',
    ],
  );
});

test('two overlapping tools: completing one keeps the other visible, in either order', () => {
  for (const [first, second] of [
    ['edit', 'cmd'],
    ['cmd', 'edit'],
  ]) {
    const seen = activities([
      ['user-prompt-submit'],
      ['pre-tool-use', { tool_name: 'Bash', tool_use_id: 'cmd' }],
      [
        'pre-tool-use',
        { tool_name: 'Write', tool_use_id: 'edit', tool_input: { file_path: '/w/a.ts' } },
      ],
      ['post-tool-use', { tool_use_id: first }],
      ['post-tool-use', { tool_use_id: second }],
    ]);
    const remaining = first === 'edit' ? 'Running a command' : 'Editing a.ts';
    assert.deepEqual(
      seen,
      ['Thinking', 'Running a command', 'Editing a.ts', remaining, 'Thinking'],
      `${first} first`,
    );
  }
});

test('a completion for an unknown or already-finished tool removes nothing else', () => {
  const seen = activities([
    ['pre-tool-use', { tool_name: 'Bash', tool_use_id: 'cmd' }],
    ['post-tool-use', { tool_name: 'Bash', tool_use_id: 'someone-else' }],
    ['post-tool-use', { tool_name: 'Bash', tool_use_id: 'cmd' }],
    ['post-tool-use', { tool_name: 'Bash', tool_use_id: 'cmd' }],
  ]);
  assert.deepEqual(seen, ['Running a command', 'Running a command', 'Thinking', 'Thinking']);
});

test('two overlapping subagents: one stopping keeps the other active', () => {
  assert.deepEqual(
    activities([
      ['user-prompt-submit'],
      ['subagent-start', { agent_id: 'a1' }],
      ['subagent-start', { agent_id: 'a2' }],
      ['subagent-stop', { agent_id: 'a2' }],
      ['subagent-stop', { agent_id: 'a1' }],
    ]),
    ['Thinking', 'Running a subagent', 'Running 2 subagents', 'Running a subagent', 'Thinking'],
  );
});

test('the root Stop keeps subagent work; SubagentStop clears that subagent’s tools', () => {
  assert.deepEqual(
    activities([
      ['user-prompt-submit'],
      ['subagent-start', { agent_id: 'a1' }],
      ['pre-tool-use', { agent_id: 'a1', tool_name: 'Bash', tool_use_id: 'sub-cmd' }],
      ['stop'],
      ['subagent-stop', { agent_id: 'a1' }],
    ]),
    ['Thinking', 'Running a subagent', 'Running a command', 'Running a command', 'Idle'],
  );
});

test('permission wait outranks tools and clears when its tool moves on', () => {
  // Approved: the waiting tool completes.
  assert.deepEqual(
    activities([
      ['pre-tool-use', { tool_name: 'Bash', tool_use_id: 'esc' }],
      ['pre-tool-use', { tool_name: 'Read', tool_use_id: 'read' }],
      ['permission-request', { tool_name: 'Bash' }],
      ['post-tool-use', { tool_use_id: 'read' }],
      ['post-tool-use', { tool_use_id: 'esc' }],
    ]),
    [
      'Running a command',
      'Searching the codebase',
      'Waiting for permission',
      'Waiting for permission',
      'Thinking',
    ],
  );
  // Denied: no completion arrives, and the next tool call settles the wait.
  assert.deepEqual(
    activities([
      ['pre-tool-use', { tool_name: 'Bash', tool_use_id: 'esc' }],
      ['permission-request', { tool_name: 'Bash' }],
      ['pre-tool-use', { tool_name: 'apply_patch', tool_use_id: 'patch' }],
      ['post-tool-use', { tool_use_id: 'patch' }],
    ]),
    ['Running a command', 'Waiting for permission', 'Editing', 'Thinking'],
  );
});

test('a subagent’s permission wait survives the root’s stop and ends with the subagent', () => {
  assert.deepEqual(
    activities([
      ['user-prompt-submit'],
      ['subagent-start', { agent_id: 'a1' }],
      ['pre-tool-use', { agent_id: 'a1', tool_name: 'Bash', tool_use_id: 's' }],
      ['permission-request', { agent_id: 'a1', tool_name: 'Bash' }],
      ['stop'],
      ['subagent-stop', { agent_id: 'a1' }],
    ]),
    [
      'Thinking',
      'Running a subagent',
      'Running a command',
      'Waiting for permission',
      'Waiting for permission',
      'Idle',
    ],
  );
});

test('stale turn state from a tool that never completed clears at the turn boundary', () => {
  for (const boundary of ['stop', 'interrupt', 'user-prompt-submit']) {
    const seen = activities([
      ['pre-tool-use', { tool_name: 'Bash', tool_use_id: 'denied' }],
      ['permission-request', { tool_name: 'Bash' }],
      [boundary],
    ]);
    assert.equal(seen[2], boundary === 'user-prompt-submit' ? 'Thinking' : 'Idle', boundary);
  }
});

test('a subagent that goes quiet without SubagentStop is forgotten', () => {
  const send = session();
  send('user-prompt-submit', {}, NOW);
  send('subagent-start', { agent_id: 'a1' }, NOW);
  send('stop', {}, NOW);
  const later = send('user-prompt-submit', {}, NOW + SESSION_AGENT_STALE_MS + 1);
  assert.equal(later?.kind === 'update' && later.patch.activity, 'Thinking');
});

test('a subagent event after the session ended does not bring the session back', () => {
  const send = session();
  send('user-prompt-submit');
  assert.equal(send('session-end')?.kind, 'end');
  assert.equal(
    send('pre-tool-use', { agent_id: 'a1', tool_name: 'Bash', tool_use_id: 'late' }),
    null,
  );
  assert.equal(send('subagent-stop', { agent_id: 'a1' }), null);
  // The root resuming the same session starts it again.
  assert.equal(send('session-start', { source: 'resume' })?.kind, 'update');
});

test('subagent events never replace the root session’s model, rollout or directory', () => {
  const send = session();
  send('session-start', { source: 'startup' });
  const r = send('subagent-start', {
    agent_id: 'a1',
    model: 'gpt-6-luna',
    cwd: '/elsewhere',
    transcript_path: '/home/me/.codex/sessions/rollout-subagent.jsonl',
  });
  assert.deepEqual(r?.kind === 'update' && r.patch, {
    state: 'delegating',
    activity: 'Running a subagent',
    file: undefined,
  });
});

test('tool families map to activities with an open-ended fallback', () => {
  const cases: Array<[string, string, string]> = [
    ['apply_patch', 'editing', 'Editing'],
    ['Bash', 'running', 'Running a command'],
    ['exec_command', 'running', 'Running a command'],
    ['grep_files', 'searching', 'Searching the codebase'],
    ['view_image', 'searching', 'Viewing an image'],
    ['web_search', 'browsing', 'Browsing the web'],
    ['spawn_agent', 'delegating', 'Running a subagent'],
    ['collaborationspawn_agent', 'delegating', 'Running a subagent'],
    ['collaborationfollowup_task', 'delegating', 'Coordinating subagents'],
    ['request_user_input', 'waiting', 'Waiting for your answer'],
    ['mcp__github__create_issue', 'running', 'Using mcp__github__create_issue'],
    ['brand_new_tool', 'running', 'Using brand_new_tool'],
  ];
  for (const [tool, state, activity] of cases) {
    const r = session()('pre-tool-use', { tool_name: tool, tool_use_id: 'x' });
    const patch = r?.kind === 'update' ? r.patch : undefined;
    assert.deepEqual([patch?.state, patch?.activity], [state, activity], tool);
  }
});

test('filenames come only from explicit path fields, never from patch or command text', () => {
  const tool = (extra: Partial<CodexHookPayload>) => {
    const r = session()('pre-tool-use', { tool_use_id: 'x', ...extra });
    return r?.kind === 'update' ? r.patch : undefined;
  };
  const patch = tool({
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: src/secret.ts\n' },
  });
  assert.deepEqual([patch?.file, patch?.activity], [undefined, 'Editing']);

  const explicit = tool({
    tool_name: 'Write',
    tool_input: { file_path: '/work/my-app/src/index.ts' },
  });
  assert.deepEqual([explicit?.file, explicit?.activity], ['index.ts', 'Editing index.ts']);

  const shell = tool({ tool_name: 'Bash', tool_input: { command: 'cat a.ts' } });
  assert.equal(shell?.file, undefined);
});

test('session end removes the session and its ledger; a missing session id is ignored', () => {
  assert.deepEqual(
    translate('session-end', { ...BASE, reason: 'other' } as CodexHookPayload, NOW, ENV, {}),
    { translation: { kind: 'end', identity: ID }, ledger: null },
  );
  assert.equal(translate('stop', { cwd: '/x' }, NOW, ENV).translation, null);
});

test('missing payload fields fall back to the environment and stay absent', () => {
  const { translation } = translate('stop', { session_id: 's', transcript_path: null }, NOW, ENV);
  assert.deepEqual(translation?.kind === 'update' && translation.patch, {
    cwd: ENV.cwd,
    project: 'fallback-proj',
    state: 'idle',
    activity: 'Idle',
    file: undefined,
  });
});

test('an unreadable ledger starts empty instead of failing', () => {
  for (const broken of [null, 42, 'x', { version: 99 }, { version: 1, tools: 'nope' }]) {
    const r = session(broken)('post-tool-use', { tool_use_id: 'x' });
    assert.equal(r?.kind === 'update' && r.patch.activity, 'Thinking');
  }
  const damaged = {
    version: 1,
    seq: 3,
    phase: 'thinking',
    tools: [{ id: 'x', name: 'Bash', seq: 1 }, null, 'tool'],
    agents: [{ id: 'a', seq: 2 }],
    permissions: [{ agent: 'a' }],
  };
  const r = session(damaged)('user-prompt-submit', { tool_name: 42 } as never);
  assert.equal(r?.kind === 'update' && r.patch.activity, 'Thinking');
  const odd = session()('pre-tool-use', { tool_name: 42, tool_use_id: 'n' } as never);
  assert.equal(odd?.kind === 'update' && odd.patch.activity, 'Working');
});

/** Replay a captured Codex 0.160.0 hook log; returns event and activity per line. */
function replay(fixture: string): Array<[string, string]> {
  const lines = readFileSync(join(import.meta.dirname, 'fixtures/codex/0.160.0', fixture), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string; payload: CodexHookPayload });
  let ledger: unknown = null;
  return lines.map(({ event, payload }) => {
    const step = translate(ARG_FOR.get(event) ?? event, payload, NOW, ENV, ledger);
    ledger = step.ledger;
    const t = step.translation;
    return [event, t?.kind === 'update' ? (t.patch.activity ?? '(unchanged)') : (t?.kind ?? '')];
  });
}

test('captured run: parallel tools finishing out of order, a patch and two subagents', () => {
  assert.deepEqual(replay('hooks-overlap.jsonl'), [
    ['SessionStart', 'Starting a session'],
    ['UserPromptSubmit', 'Thinking'],
    ['PreToolUse', 'Running a command'],
    ['PreToolUse', 'Running a command'],
    ['PostToolUse', 'Running a command'], // the fast one; the slow one still runs
    ['PostToolUse', 'Thinking'],
    ['PreToolUse', 'Editing'],
    ['PostToolUse', 'Thinking'],
    ['PreToolUse', 'Running a subagent'],
    ['PostToolUse', 'Thinking'],
    ['SubagentStart', 'Running a subagent'],
    ['PreToolUse', 'Running a subagent'],
    ['PreToolUse', 'Running a command'], // inside the first subagent
    ['PostToolUse', 'Running a command'], // the root's spawn finished, not the subagent's tool
    ['SubagentStart', 'Running a command'],
    ['Stop', 'Running a command'], // the root stops while the subagent still works
    ['SessionEnd', 'end'],
  ]);
});

test('captured run: a permission request beside a plain command, then a denied command', () => {
  assert.deepEqual(replay('hooks-permission.jsonl'), [
    ['SessionStart', 'Starting a session'],
    ['UserPromptSubmit', 'Thinking'],
    ['PreToolUse', 'Running a command'],
    ['PreToolUse', 'Running a command'],
    ['PermissionRequest', 'Waiting for permission'],
    ['PostToolUse', 'Waiting for permission'], // the plain command; the escalated one still waits
    ['PreToolUse', 'Editing'], // the model moved on: the escalated command was denied
    ['PostToolUse', 'Thinking'],
    ['Stop', 'Idle'],
    ['SessionEnd', 'end'],
  ]);
});

test('captured run: compaction around a resume and a turn whose tools never complete', () => {
  const seen = replay('hooks-resume.jsonl');
  assert.deepEqual(seen.slice(0, 5), [
    ['PreCompact', '(unchanged)'],
    ['PostCompact', '(unchanged)'],
    ['SessionStart', 'Starting a session'],
    ['SessionStart', '(unchanged)'], // source: compact
    ['UserPromptSubmit', 'Thinking'],
  ]);
  assert.deepEqual(seen.slice(-2), [
    ['Stop', 'Idle'],
    ['SessionEnd', 'end'],
  ]);
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-codex-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runtime(input: string, daemons: { count: number }): HookRuntime<LedgerHookStore> {
  return {
    readInput: () => input,
    now: () => NOW,
    environment: () => ENV,
    root: () => root,
    createStore: (r) => new SessionStore(r),
    ensureDaemon: () => {
      daemons.count++;
    },
  };
}

test('every installed event runs through the hook; only session end skips the daemon', async () => {
  const daemons = { count: 0 };
  const store = new SessionStore(root);
  for (const { name, arg } of CODEX_HOOK_EVENTS) {
    if (arg === 'session-end') continue;
    const payload = { ...BASE, hook_event_name: name, tool_name: 'Bash', tool_use_id: 't' };
    await runHook([arg], runtime(JSON.stringify(payload), daemons));
  }
  assert.equal(daemons.count, CODEX_HOOK_EVENTS.length - 1);
  const live = store.snapshot(NOW);
  assert.equal(live?.provider, 'codex');
  assert.equal(live?.model, 'gpt-5.5-codex');
  assert.ok(store.readLedger(ID), 'the ledger is kept beside the marker');

  await runHook(['session-end'], runtime(JSON.stringify(BASE), daemons));
  await runHook(['session-end'], runtime(JSON.stringify(BASE), daemons));
  assert.equal(daemons.count, CODEX_HOOK_EVENTS.length - 1, 'session end never starts it');
  assert.equal(store.snapshot(NOW), null);
  assert.equal(store.readLedger(ID), null, 'session end removes the ledger');
});

test('the hook persists the ledger between processes', async () => {
  const daemons = { count: 0 };
  const hook = (event: string, extra: Partial<CodexHookPayload>) =>
    runHook([event], runtime(JSON.stringify({ ...BASE, ...extra }), daemons));
  await hook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'slow' });
  await hook('pre-tool-use', { tool_name: 'apply_patch', tool_use_id: 'fast' });
  await hook('post-tool-use', { tool_use_id: 'fast' });
  const marker = new SessionStore(root).snapshot(NOW) as Partial<SessionMarker> | null;
  assert.equal(marker?.activity, 'Running a command');
});

test('the Codex hook runner fails open on malformed input and internal errors', async () => {
  const broken: HookRuntime<LedgerHookStore> = {
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
  const locked: HookRuntime<LedgerHookStore> = {
    ...broken,
    readInput: () => JSON.stringify(BASE),
    createStore: () => ({
      record: () => assert.fail('must not write without the lock'),
      end: () => assert.fail('must not write without the lock'),
      withLock: () => {
        throw new Error('timed out');
      },
      readLedger: () => null,
      writeLedger: () => assert.fail('must not write without the lock'),
    }),
  };
  await assert.doesNotReject(() => runHook(['stop'], locked));
});

test('an end is applied without touching the ledger file directly', async () => {
  const calls: string[] = [];
  const identity: SessionIdentity[] = [];
  const store: LedgerHookStore = {
    withLock: (id, fn) => {
      calls.push('lock');
      identity.push(id);
      const out = fn();
      calls.push('unlock');
      return out;
    },
    readLedger: () => {
      calls.push('read');
      return null;
    },
    writeLedger: () => calls.push('write-ledger'),
    record: () => calls.push('record'),
    end: () => calls.push('end'),
  };
  const daemons = { count: 0 };
  const rt = { ...runtime(JSON.stringify(BASE), daemons), createStore: () => store };
  await runHook(['pre-tool-use'], rt);
  await runHook(['session-end'], rt);
  assert.deepEqual(calls, [
    'lock',
    'read',
    'write-ledger',
    'record',
    'unlock',
    'lock',
    'read',
    'end',
    'unlock',
  ]);
  assert.deepEqual(identity, [ID, ID]);
  assert.equal(daemons.count, 1);
});
