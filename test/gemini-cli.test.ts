import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore, STALE_AFTER_MS } from '../src/core/session-store';
import {
  GEMINI_CLI_HOOK_EVENTS,
  NEUTRAL_OUTPUT,
  runHook,
  translate,
  type GeminiHookPayload,
  type GeminiHookRuntime,
} from '../src/provider/gemini-cli';
import type { LedgerHookStore } from '../src/provider/hook-runner';
import type { TranslateEnv } from '../src/provider/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/gemini-cli/0.62.0');

const NOW = 1_700_000_000_000;
const ENV: TranslateEnv = { cwd: '/home/me/fallback-proj' };
const ID = { provider: 'gemini-cli', sessionId: 'session-1' } as const;
const TRANSCRIPT = '/home/me/.gemini/tmp/my-app/chats/session-2026-10-04T09-49-session1.jsonl';
const BASE: GeminiHookPayload = {
  session_id: 'session-1',
  cwd: '/work/my-app',
  transcript_path: TRANSCRIPT,
};
const COMMON = { cwd: '/work/my-app', project: 'my-app', enrichmentRef: TRANSCRIPT };
const ARG_FOR = new Map(GEMINI_CLI_HOOK_EVENTS.map(({ name, arg }) => [name, arg]));

const shell = (command = 'npm test'): Partial<GeminiHookPayload> => ({
  tool_name: 'run_shell_command',
  tool_input: { command },
});
const read = (file: string): Partial<GeminiHookPayload> => ({
  tool_name: 'read_file',
  tool_input: { file_path: `/work/my-app/${file}` },
});
const write = (file: string): Partial<GeminiHookPayload> => ({
  tool_name: 'write_file',
  tool_input: { file_path: `/work/my-app/${file}`, content: 'hi' },
});
const permission = (type = 'exec'): Partial<GeminiHookPayload> => ({
  notification_type: 'ToolPermission',
  message: 'Tool Confirm Shell Command requires execution',
  details: { type },
});

type Step = [event: string, extra?: Partial<GeminiHookPayload>];

/** Feed events through the translator, threading the ledger like the hook does. */
function session(start: unknown = null) {
  let ledger = start;
  return (event: string, extra: Partial<GeminiHookPayload> = {}, now = NOW) => {
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

test('the installed events are exactly the presence-relevant ones', () => {
  assert.deepEqual(GEMINI_CLI_HOOK_EVENTS.map((e) => e.name).sort(), [
    'AfterAgent',
    'AfterTool',
    'BeforeAgent',
    'BeforeTool',
    'Notification',
    'SessionEnd',
    'SessionStart',
  ]);
});

test('startup, resume and clear reset the timer and show a starting session', () => {
  for (const source of ['startup', 'resume', 'clear']) {
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

test('an unknown SessionStart source or event only proves liveness', () => {
  const send = session();
  send('before-tool', shell());
  for (const [event, extra] of [
    ['session-start', { source: 'compress' }],
    ['pre-compress', { trigger: 'auto' }],
    ['something-new', {}],
  ] as const) {
    assert.deepEqual(
      send(event, extra as Partial<GeminiHookPayload>),
      { kind: 'update', identity: ID, activityChanged: false, patch: COMMON },
      event,
    );
  }
  const after = send('after-tool', shell());
  assert.equal(after?.kind === 'update' && after.patch.activity, 'Thinking');
});

test('a turn: prompt, tools, and the agent finishing', () => {
  assert.deepEqual(
    activities([
      ['before-agent'],
      ['before-tool', shell()],
      ['after-tool', shell()],
      ['before-tool', write('hello.txt')],
      ['after-tool', write('hello.txt')],
      ['after-agent'],
    ]),
    ['Thinking', 'Running a command', 'Thinking', 'Editing hello.txt', 'Thinking', 'Idle'],
  );
});

test('two overlapping families: completing one keeps the other visible, in either order', () => {
  for (const order of [
    ['shell', 'read'],
    ['read', 'shell'],
  ]) {
    const send = session();
    send('before-agent');
    send('before-tool', read('README.md'));
    const both = send('before-tool', shell());
    assert.equal(both?.kind === 'update' && both.patch.activity, 'Running a command');
    const [first, second] = order.map((t) => (t === 'shell' ? shell() : read('README.md')));
    const one = send('after-tool', first);
    assert.equal(
      one?.kind === 'update' && one.patch.activity,
      order[0] === 'shell' ? 'Reading README.md' : 'Running a command',
      order.join(' then '),
    );
    const none = send('after-tool', second);
    assert.equal(none?.kind === 'update' && none.patch.activity, 'Thinking');
  }
});

test('the newest running family is shown, and an older one returns when it finishes', () => {
  assert.deepEqual(
    activities([
      ['before-tool', shell()],
      ['before-tool', write('a.ts')],
      ['before-tool', read('b.ts')],
      ['after-tool', read('b.ts')],
      ['after-tool', write('a.ts')],
      ['after-tool', shell()],
    ]),
    [
      'Running a command',
      'Editing a.ts',
      'Reading b.ts',
      'Editing a.ts',
      'Running a command',
      'Thinking',
    ],
  );
});

test('a family counts its tools: one finishing keeps the family running', () => {
  assert.deepEqual(
    activities([
      ['before-tool', shell('sleep 5')],
      ['before-tool', shell('npm test')],
      ['after-tool', shell('npm test')],
      ['after-tool', shell('sleep 5')],
    ]),
    ['Running a command', 'Running a command', 'Running a command', 'Thinking'],
  );
});

test('a family never shows the file of a tool that already finished', () => {
  assert.deepEqual(
    activities([
      ['before-tool', write('a.ts')],
      ['before-tool', write('b.ts')],
      ['after-tool', write('b.ts')],
      ['after-tool', write('a.ts')],
    ]),
    ['Editing a.ts', 'Editing b.ts', 'Editing', 'Thinking'],
  );
  assert.deepEqual(
    activities([
      ['before-tool', write('a.ts')],
      ['before-tool', write('b.ts')],
      ['after-tool', write('a.ts')],
    ]).slice(-1),
    ['Editing b.ts'],
    'the newest start is still running, so its file stays',
  );
});

test('a completion for a family that is not running removes nothing else', () => {
  assert.deepEqual(
    activities([
      ['before-tool', shell()],
      ['after-tool', read('README.md')],
      ['after-tool', { tool_name: 'never_started' }],
    ]),
    ['Running a command', 'Running a command', 'Running a command'],
  );
});

test('a permission notification outranks tools and ends when its tool completes', () => {
  assert.deepEqual(
    activities([
      ['before-agent'],
      ['before-tool', read('README.md')],
      ['before-tool', shell()],
      ['notification', permission('exec')],
      ['after-tool', read('README.md')],
      ['after-tool', shell()],
    ]),
    [
      'Thinking',
      'Reading README.md',
      'Running a command',
      'Waiting for permission',
      'Waiting for permission',
      'Thinking',
    ],
  );
});

test('a permission prompt of an unmapped type waits on the newest running family', () => {
  assert.deepEqual(
    activities([
      ['before-tool', shell()],
      ['before-tool', { tool_name: 'mcp_github_create_issue' }],
      ['notification', permission('mcp')],
      ['after-tool', shell()],
      ['after-tool', { tool_name: 'mcp_github_create_issue' }],
    ]),
    [
      'Running a command',
      'Using mcp_github_create_issue',
      'Waiting for permission',
      'Waiting for permission',
      'Thinking',
    ],
  );
});

test('other notifications refresh liveness without stealing visible activity', () => {
  const send = session();
  send('before-tool', shell());
  for (const extra of [
    { notification_type: 'Idle', message: 'waiting' },
    { message: 'no type' },
    { notification_type: 'ToolPermissionLater' },
  ]) {
    assert.deepEqual(send('notification', extra), {
      kind: 'update',
      identity: ID,
      activityChanged: false,
      patch: COMMON,
    });
  }
  const after = send('after-tool', shell());
  assert.equal(after?.kind === 'update' && after.patch.activity, 'Thinking');
});

test('the turn boundary clears tools and waits that never completed', () => {
  // A denied tool gets BeforeTool but never AfterTool.
  assert.deepEqual(
    activities([
      ['before-agent'],
      ['before-tool', shell('rm -rf build')],
      ['notification', permission('exec')],
      ['after-agent'],
      ['before-agent'],
      ['before-tool', read('a.ts')],
      ['after-tool', read('a.ts')],
    ]),
    [
      'Thinking',
      'Running a command',
      'Waiting for permission',
      'Idle',
      'Thinking',
      'Reading a.ts',
      'Thinking',
    ],
  );
  assert.deepEqual(
    activities([['before-tool', shell()], ['before-agent']]),
    ['Running a command', 'Thinking'],
    'the next prompt clears leaked counters too',
  );
});

test('a new session forgets the previous session’s tools and waits', () => {
  const send = session();
  send('before-tool', shell());
  send('notification', permission());
  const r = send('session-start', { source: 'resume' });
  assert.equal(r?.kind === 'update' && r.patch.activity, 'Starting a session');
  const next = send('before-agent');
  assert.equal(next?.kind === 'update' && next.patch.activity, 'Thinking');
});

test('tool families map to activities with an open-ended fallback', () => {
  const cases: Array<[string, unknown, string, string]> = [
    ['replace', { file_path: '/w/src/a.ts' }, 'editing', 'Editing a.ts'],
    ['write_file', {}, 'editing', 'Editing'],
    ['run_shell_command', { command: 'cat secret.txt' }, 'running', 'Running a command'],
    ['read_file', { file_path: 'notes.md' }, 'searching', 'Reading notes.md'],
    ['read_many_files', { include: ['*.md'] }, 'searching', 'Searching the codebase'],
    ['grep_search', { pattern: 'x' }, 'searching', 'Searching the codebase'],
    ['search_file_content', { pattern: 'x' }, 'searching', 'Searching the codebase'],
    ['glob', { pattern: '*.ts' }, 'searching', 'Searching the codebase'],
    ['list_directory', { dir_path: '.' }, 'searching', 'Searching the codebase'],
    ['web_fetch', { prompt: 'x' }, 'browsing', 'Browsing the web'],
    ['google_web_search', { query: 'x' }, 'browsing', 'Browsing the web'],
    ['invoke_agent', {}, 'delegating', 'Running a subagent'],
    ['write_todos', {}, 'thinking', 'Planning'],
    ['tracker_create_task', {}, 'thinking', 'Planning'],
    ['ask_user', {}, 'waiting', 'Waiting for your answer'],
    ['mcp_github_create_issue', {}, 'running', 'Using mcp_github_create_issue'],
    ['', {}, 'running', 'Working'],
  ];
  for (const [tool_name, tool_input, state, activity] of cases) {
    const r = session()('before-tool', { tool_name, tool_input });
    assert.equal(r?.kind === 'update' && r.patch.state, state, tool_name);
    assert.equal(r?.kind === 'update' && r.patch.activity, activity, tool_name);
  }
});

test('filenames come only from an explicit file_path field', () => {
  for (const tool_input of [
    { command: 'vim secret.txt' },
    { content: 'see /etc/passwd' },
    { file_path: 42 },
    'file_path=/x/y.ts',
    null,
  ]) {
    const r = session()('before-tool', { tool_name: 'write_file', tool_input });
    assert.equal(r?.kind === 'update' && r.patch.file, undefined, JSON.stringify(tool_input));
  }
});

test('session end removes the session and its ledger, and is idempotent', () => {
  const send = session();
  send('before-tool', shell());
  for (let i = 0; i < 3; i++) {
    const { translation, ledger } = translate('session-end', { ...BASE, reason: 'exit' }, NOW, ENV);
    assert.deepEqual(translation, { kind: 'end', identity: ID });
    assert.equal(ledger, null);
  }
});

test('a missing session id falls back to the environment, or is ignored', () => {
  assert.deepEqual(translate('before-agent', {}, NOW, ENV), { translation: null, ledger: null });
  const { translation } = translate('before-agent', null, NOW, { ...ENV, sessionId: 'env-id' });
  assert.deepEqual(translation, {
    kind: 'update',
    identity: { provider: 'gemini-cli', sessionId: 'env-id' },
    activityChanged: true,
    patch: {
      cwd: ENV.cwd,
      project: 'fallback-proj',
      state: 'thinking',
      activity: 'Thinking',
      file: undefined,
    },
  });
});

test('no hook event supplies model, tokens or cost', () => {
  const r = session()('before-agent', { model: 'gemini-3' } as Partial<GeminiHookPayload>);
  assert.ok(r?.kind === 'update');
  for (const key of ['model', 'tokens', 'cost'] as const) assert.equal(key in r.patch, false);
});

test('an unreadable ledger starts empty instead of failing', () => {
  for (const damaged of [
    'nonsense',
    { version: 2 },
    { version: 1, seq: 1, phase: 'idle', families: 'x', permission: null },
    {
      version: 1,
      seq: 3,
      phase: 'thinking',
      families: [{ family: 'command', count: 'two' }, null],
      permission: { seq: 'x' },
    },
  ]) {
    const r = session(damaged)('after-tool', shell());
    assert.equal(r?.kind === 'update' && r.patch.activity, 'Thinking', JSON.stringify(damaged));
  }
});

/** Replay a captured run's installed events; the visible activity after each. */
function replay(fixture: string): Array<[string, string]> {
  const ledgers = new Map<string, unknown>();
  const seen: Array<[string, string]> = [];
  const records = readFileSync(join(FIXTURES, fixture), 'utf8').trim().split('\n');
  for (const line of records) {
    const { event, payload } = JSON.parse(line) as { event: string; payload: GeminiHookPayload };
    const arg = ARG_FOR.get(event);
    if (!arg) continue; // VDP does not install this hook
    const id = payload.session_id ?? '';
    const { translation, ledger } = translate(arg, payload, NOW, ENV, ledgers.get(id) ?? null);
    ledgers.set(id, ledger);
    seen.push([
      event,
      translation?.kind === 'update' ? (translation.patch.activity ?? '(unchanged)') : 'end',
    ]);
  }
  return seen;
}

test('captured run: overlapping tools completing in start order, then a write', () => {
  assert.deepEqual(replay('hooks-overlap.jsonl'), [
    ['SessionStart', 'Starting a session'],
    ['BeforeAgent', 'Thinking'],
    ['BeforeTool', 'Reading README.md'],
    ['BeforeTool', 'Running a command'],
    ['AfterTool', 'Running a command'],
    ['AfterTool', 'Thinking'],
    ['BeforeTool', 'Editing hello.txt'],
    ['AfterTool', 'Thinking'],
    ['AfterAgent', 'Idle'],
    ['SessionEnd', 'end'],
  ]);
});

test('captured run: overlapping tools completing out of start order', () => {
  assert.deepEqual(replay('hooks-out-of-order.jsonl').slice(2, 6), [
    ['BeforeTool', 'Running a command'],
    ['BeforeTool', 'Reading README.md'],
    ['AfterTool', 'Running a command'],
    ['AfterTool', 'Thinking'],
  ]);
});

test('captured run: an approved command, /clear to a new session, and a repeated exit', () => {
  assert.deepEqual(replay('hooks-permission.jsonl'), [
    ['SessionStart', 'Starting a session'],
    ['BeforeAgent', 'Thinking'],
    ['BeforeTool', 'Running a command'],
    ['Notification', 'Waiting for permission'],
    ['AfterTool', 'Thinking'],
    ['AfterAgent', 'Idle'],
    ['SessionEnd', 'end'],
    ['SessionStart', 'Starting a session'],
    ['SessionEnd', 'end'],
    ['SessionEnd', 'end'],
    ['SessionEnd', 'end'],
  ]);
});

test('captured run: a cancelled permission prompt waits until the session ends', () => {
  // Gemini reports nothing when the user presses Esc at the prompt; the next
  // BeforeAgent (or the session ending) is the first event that clears it.
  assert.deepEqual(replay('hooks-permission-cancelled.jsonl'), [
    ['SessionStart', 'Starting a session'],
    ['BeforeAgent', 'Thinking'],
    ['BeforeTool', 'Running a command'],
    ['Notification', 'Waiting for permission'],
    ['SessionEnd', 'end'],
    ['SessionEnd', 'end'],
  ]);
});

test('captured run: a later-minute resume ends on the session’s own transcript', () => {
  const ledgers: { value: unknown } = { value: null };
  let reference: string | undefined;
  for (const line of readFileSync(join(FIXTURES, 'hooks-resume-later.jsonl'), 'utf8')
    .trim()
    .split('\n')) {
    const { event, payload } = JSON.parse(line) as { event: string; payload: GeminiHookPayload };
    const arg = ARG_FOR.get(event);
    if (!arg || arg === 'session-end') continue;
    const step = translate(arg, payload, NOW, ENV, ledgers.value);
    ledgers.value = step.ledger;
    if (step.translation?.kind === 'update') {
      reference = step.translation.patch.enrichmentRef ?? reference;
    }
  }
  assert.match(reference ?? '', /session-2026-10-04T09-49-ffd08608\.jsonl$/);
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-gemini-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runtime(
  input: string,
  daemons: { count: number },
  output: string[] = [],
): GeminiHookRuntime {
  return {
    readInput: () => input,
    now: () => NOW,
    environment: () => ENV,
    root: () => root,
    createStore: (r) => new SessionStore(r),
    ensureDaemon: () => {
      daemons.count++;
    },
    writeOutput: (text) => {
      output.push(text);
    },
  };
}

test('every installed event prints the neutral {}; only session end skips the daemon', async () => {
  const daemons = { count: 0 };
  const output: string[] = [];
  const store = new SessionStore(root);
  for (const { name, arg } of GEMINI_CLI_HOOK_EVENTS) {
    if (arg === 'session-end') continue;
    const payload = { ...BASE, hook_event_name: name, ...shell() };
    await runHook([arg], runtime(JSON.stringify(payload), daemons, output));
  }
  assert.equal(daemons.count, GEMINI_CLI_HOOK_EVENTS.length - 1);
  const live = store.snapshot(NOW);
  assert.equal(live?.provider, 'gemini-cli');
  assert.equal(live?.enrichmentRef, TRANSCRIPT);
  assert.ok(store.readLedger(ID), 'the ledger is kept beside the marker');

  for (let i = 0; i < 3; i++) {
    await runHook(['session-end'], runtime(JSON.stringify(BASE), daemons, output));
  }
  assert.equal(daemons.count, GEMINI_CLI_HOOK_EVENTS.length - 1, 'session end never starts it');
  assert.equal(store.snapshot(NOW), null);
  assert.equal(store.readLedger(ID), null, 'session end removes the ledger');
  assert.deepEqual(output, Array(GEMINI_CLI_HOOK_EVENTS.length + 2).fill(NEUTRAL_OUTPUT));
});

test('the hook persists the family counters between processes', async () => {
  const daemons = { count: 0 };
  const hook = (event: string, extra: Partial<GeminiHookPayload>) =>
    runHook([event], runtime(JSON.stringify({ ...BASE, ...extra }), daemons));
  await hook('before-tool', shell());
  await hook('before-tool', read('README.md'));
  await hook('after-tool', read('README.md'));
  assert.equal(new SessionStore(root).snapshot(NOW)?.activity, 'Running a command');
});

test('a session whose end never arrives goes stale by heartbeat', async () => {
  await runHook(['before-agent'], runtime(JSON.stringify(BASE), { count: 0 }));
  const store = new SessionStore(root);
  assert.equal(store.snapshot(NOW + STALE_AFTER_MS)?.activity, 'Thinking');
  assert.equal(store.snapshot(NOW + STALE_AFTER_MS + 1), null);
});

test('the Gemini hook prints {} and fails open on malformed input and internal errors', async () => {
  const output: string[] = [];
  const broken: GeminiHookRuntime = {
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
    writeOutput: (text) => {
      output.push(text);
    },
  };
  await assert.doesNotReject(() => runHook(['after-agent'], broken));
  await assert.doesNotReject(() =>
    runHook(['after-agent'], { ...broken, readInput: () => JSON.stringify(BASE) }),
  );
  const locked: GeminiHookRuntime = {
    ...broken,
    readInput: () => JSON.stringify(BASE),
    createStore: (): LedgerHookStore => ({
      record: () => assert.fail('must not write without the lock'),
      end: () => assert.fail('must not write without the lock'),
      withLock: () => {
        throw new Error('timed out');
      },
      readLedger: () => null,
      writeLedger: () => assert.fail('must not write without the lock'),
    }),
  };
  await assert.doesNotReject(() => runHook(['before-tool'], locked));
  await assert.doesNotReject(() =>
    runHook(['before-tool'], {
      ...locked,
      writeOutput: () => {
        throw new Error('EPIPE');
      },
    }),
  );
  assert.deepEqual(output, [NEUTRAL_OUTPUT, NEUTRAL_OUTPUT, NEUTRAL_OUTPUT]);
});
