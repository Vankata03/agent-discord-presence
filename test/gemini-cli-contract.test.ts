// The Gemini CLI hook contract as captured from the real runtime (fixtures in
// test/fixtures/gemini-cli/0.62.0). These pin the runtime facts the provider is
// designed around, so a re-capture that changes any of them fails here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/gemini-cli/0.62.0');

interface HookRecord {
  event: string;
  payload: Record<string, unknown> & { session_id: string };
}

const capture = (name: string): HookRecord[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as HookRecord);
/** The events VDP's Gemini CLI provider installs. */
const INSTALLED = new Set([
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'Notification',
]);
const installed = (name: string) => capture(name).filter((r) => INSTALLED.has(r.event));
/** The payload of the first record, which every fixture has. */
const firstPayload = (records: HookRecord[]) => {
  assert.ok(records[0]);
  return records[0].payload;
};
const label = (r: HookRecord) =>
  [
    r.event,
    r.payload.tool_name ?? r.payload.source ?? r.payload.reason ?? r.payload.notification_type,
  ]
    .filter(Boolean)
    .join(':');

const ALL = [
  'hooks-overlap.jsonl',
  'hooks-out-of-order.jsonl',
  'hooks-permission.jsonl',
  'hooks-resume.jsonl',
  'hooks-resume-later.jsonl',
];

test('every hook payload carries the base fields, and hook_event_name matches the event', () => {
  for (const name of ALL) {
    for (const { event, payload } of capture(name)) {
      for (const key of ['session_id', 'transcript_path', 'cwd', 'timestamp']) {
        assert.equal(typeof payload[key], 'string', `${name} ${event} ${key}`);
      }
      assert.equal(payload.hook_event_name, event, name);
    }
  }
});

test('a turn: lifecycle order, with every tool bracketed by BeforeTool and AfterTool', () => {
  assert.deepEqual(installed('hooks-overlap.jsonl').map(label), [
    'SessionStart:startup',
    'BeforeAgent',
    'BeforeTool:read_file',
    'BeforeTool:run_shell_command',
    'AfterTool:read_file',
    'AfterTool:run_shell_command',
    'BeforeTool:write_file',
    'AfterTool:write_file',
    'AfterAgent',
    'SessionEnd:exit',
  ]);
});

test('tools in one response overlap and can complete out of start order, with no call id', () => {
  const tools = installed('hooks-out-of-order.jsonl').filter((r) => /Tool$/.test(r.event));
  assert.deepEqual(tools.slice(0, 4).map(label), [
    'BeforeTool:run_shell_command',
    'BeforeTool:read_file',
    'AfterTool:read_file',
    'AfterTool:run_shell_command',
  ]);
  // Only the tool name and input identify a call: no stable operation id exists.
  for (const { event, payload } of tools) {
    const extra = Object.keys(payload).filter(
      (k) => !['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'timestamp'].includes(k),
    );
    assert.deepEqual(
      extra.sort(),
      event === 'BeforeTool'
        ? ['tool_input', 'tool_name']
        : ['tool_input', 'tool_name', 'tool_response'],
    );
  }
});

test('a permission prompt notifies between its BeforeTool and AfterTool', () => {
  const records = installed('hooks-permission.jsonl');
  assert.deepEqual(records.slice(2, 5).map(label), [
    'BeforeTool:run_shell_command',
    'Notification:ToolPermission',
    'AfterTool:run_shell_command',
  ]);
  const notification = firstPayload(records.slice(3));
  assert.equal(typeof notification.message, 'string');
  assert.equal((notification.details as { type?: unknown }).type, 'exec');
});

test('a cancelled permission prompt sends neither AfterTool nor AfterAgent', () => {
  // Captured with only the seven installed events logged.
  assert.deepEqual(capture('hooks-permission-cancelled.jsonl').map(label), [
    'SessionStart:startup',
    'BeforeAgent',
    'BeforeTool:run_shell_command',
    'Notification:ToolPermission',
    'SessionEnd:exit',
    'SessionEnd:exit',
  ]);
});

test('/clear ends the session and starts a new session id; exit can repeat SessionEnd', () => {
  const records = installed('hooks-permission.jsonl').slice(-5);
  assert.deepEqual(records.map(label), [
    'SessionEnd:clear',
    'SessionStart:clear',
    'SessionEnd:exit',
    'SessionEnd:exit',
    'SessionEnd:exit',
  ]);
  const [ended, started, ...exits] = records.map((r) => r.payload.session_id);
  assert.notEqual(started, ended);
  assert.deepEqual(exits, [started, started, started]);
});

test('resume keeps the session id; its SessionStart may name a short-lived transcript', () => {
  const first = firstPayload(installed('hooks-overlap.jsonl'));
  for (const name of ['hooks-resume.jsonl', 'hooks-resume-later.jsonl']) {
    const records = installed(name);
    assert.deepEqual(records.map(label), [
      'SessionStart:resume',
      'BeforeAgent',
      'AfterAgent',
      'SessionEnd:exit',
    ]);
    assert.ok(records.every((r) => r.payload.session_id === first.session_id));
    // Every event after SessionStart names the session's own transcript.
    assert.ok(records.slice(1).every((r) => r.payload.transcript_path === first.transcript_path));
  }
  // Resumed in a later minute, SessionStart names a new file that Gemini abandons.
  const later = firstPayload(installed('hooks-resume-later.jsonl'));
  assert.notEqual(later.transcript_path, first.transcript_path);
});

test('the hooks VDP leaves out fire around every model call', () => {
  // PreCompress (trigger "auto") and the model hooks run before each request.
  const skipped = capture('hooks-overlap.jsonl').filter((r) => !INSTALLED.has(r.event));
  assert.deepEqual([...new Set(skipped.map((r) => r.event))].sort(), [
    'AfterModel',
    'BeforeModel',
    'BeforeToolSelection',
    'PreCompress',
  ]);
  assert.equal(skipped.filter((r) => r.event === 'PreCompress').length, 3);
});
