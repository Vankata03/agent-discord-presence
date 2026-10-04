// The OpenCode plugin contract as captured from the real runtime (fixtures in
// test/fixtures/opencode/<version>). Each fixture is the log written by the
// probe plugin in test/fixtures/opencode/capture/vdp-probe.js: every plugin
// callback in invocation order, plus the probe's own delivery records. These
// tests pin the runtime facts the OpenCode provider is designed around, so a
// re-capture that changes any of them fails here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/opencode');

interface Part {
  type?: string;
  tool?: string;
  callID?: string;
  sessionID?: string;
  state?: { status?: string; error?: string };
}
interface Info {
  id?: string;
  role?: string;
  sessionID?: string;
  parentID?: string;
  modelID?: string;
  cost?: number;
  tokens?: { output?: number };
  time?: { completed?: number };
  error?: { name?: string };
}
interface Properties {
  sessionID?: string;
  id?: string;
  requestID?: string;
  permissionID?: string;
  reply?: string;
  response?: string;
  permission?: string;
  type?: string;
  callID?: string;
  tool?: { messageID?: string; callID?: string };
  status?: { type?: string };
  info?: Info;
  part?: Part;
  error?: { name?: string };
}
interface Rec {
  seq: number;
  instance: string;
  at: number;
  kind: string;
  type?: string;
  event?: { type: string; properties: Properties };
  input?: { sessionID?: string; callID?: string; tool?: string };
  // init
  hasClient?: boolean;
  runtime?: string;
  // delivered
  ref?: number;
  refs?: number[];
  code?: number | null;
  signal?: string | null;
  // dispose
  queued?: number;
  inFlight?: number | null;
  // lookup
  id?: string;
  outcome?: string;
  chain?: { id: string; parentID?: string | null; error?: string }[];
}

const capture = (version: string, name: string): Rec[] =>
  readFileSync(join(FIXTURES, version, name), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => !line.includes('"kind":"process.exit"'))
    .map((line) => JSON.parse(line) as Rec);
const json = <T>(version: string, name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, version, name), 'utf8')) as T;

const V = '1.18.34';
const RUNS = [
  'plugin-tools.jsonl',
  'plugin-permission-tui.jsonl',
  'plugin-subagent-dispose.jsonl',
  'plugin-unknown-child.jsonl',
  'plugin-resume.jsonl',
  'plugin-cycle-dangling.jsonl',
  'plugin-shutdown-queued.jsonl',
  'plugin-queue-failures.jsonl',
  'plugin-run-sigterm.jsonl',
  'plugin-tui-ctrl-c.jsonl',
  'plugin-tui-hangup.jsonl',
];

/**
 * Runs captured with VDP_PROBE_FILTER, which queues only some event types, or
 * with injected delivery failures (see the fixture README).
 */
const PARTIAL_DELIVERY = [
  'plugin-shutdown-queued.jsonl',
  'plugin-queue-failures.jsonl',
  'plugin-run-sigterm.jsonl',
];

const events = (records: Rec[], type?: string) =>
  records.filter((r) => r.kind === 'event' && (!type || r.type === type));
const props = (r: Rec | undefined): Properties => {
  assert.ok(r?.event, 'an event record');
  return r.event.properties;
};
const one = (records: Rec[], predicate: (r: Rec) => boolean): Rec => {
  const found = records.filter(predicate);
  assert.equal(found.length, 1, 'exactly one match');
  return found[0] as Rec;
};
const toolParts = (records: Rec[], callID: string) =>
  events(records, 'message.part.updated')
    .map((r) => props(r).part)
    .filter((p): p is Part => p?.type === 'tool' && p.callID === callID)
    .map((p) => p.state?.status);
const isIdle = (r: Rec) =>
  r.type === 'session.idle' || (r.type === 'session.status' && props(r).status?.type === 'idle');
/** Every queued ref the probe delivered, per plugin instance, in delivery order. */
const deliveredRefs = (records: Rec[], instance: string) =>
  records
    .filter((r) => r.instance === instance && r.kind === 'delivered')
    .flatMap((r) => r.refs ?? (r.ref === undefined ? [] : [r.ref]));
const instances = (records: Rec[]) => [...new Set(records.map((r) => r.instance))];

test('OpenCode auto-discovers the global plugin and hands it the public client', () => {
  for (const name of RUNS) {
    const records = capture(V, name);
    const init = records.filter((r) => r.kind === 'init');
    assert.ok(init.length >= 1, name);
    for (const r of init) {
      assert.equal(r.hasClient, true, name);
      assert.match(r.runtime ?? '', /^bun /, name);
    }
    // Each plugin instance starts with its init record.
    for (const instance of instances(records)) {
      assert.equal(records.find((r) => r.instance === instance)?.kind, 'init', name);
    }
  }
});

test('1.18.34 emits permission.asked and permission.replied, never permission.updated', () => {
  const types = new Set(RUNS.flatMap((name) => events(capture(V, name)).map((r) => r.type)));
  for (const type of [
    'session.created',
    'session.updated',
    'session.status',
    'session.idle',
    'session.error',
    'message.updated',
    'message.part.updated',
    'permission.asked',
    'permission.replied',
  ]) {
    assert.ok(types.has(type), type);
  }
  assert.equal(types.has('permission.updated'), false);
  // The `permission.ask` plugin hook no longer fires.
  assert.equal(
    RUNS.some((name) => capture(V, name).some((r) => r.kind === 'permission.ask')),
    false,
  );
});

test('1.18.34 permission payloads: asked names the tool call; replied names the request', () => {
  const records = capture(V, 'plugin-permission-tui.jsonl');
  const asked = events(records, 'permission.asked').map(props);
  const replied = events(records, 'permission.replied').map(props);
  assert.equal(asked.length, 2);
  assert.deepEqual(
    replied.map((p) => p.reply),
    ['once', 'reject'],
  );
  asked.forEach((ask, i) => {
    assert.match(ask.id ?? '', /^per_/);
    assert.equal(ask.permission, 'bash');
    assert.match(ask.tool?.callID ?? '', /^call_/);
    assert.equal(replied[i]?.requestID, ask.id);
    assert.equal(replied[i]?.sessionID, ask.sessionID);
    assert.equal(replied[i]?.permissionID, undefined);
  });
});

test('1.0.223 used the older names and shapes: permission.updated, permissionID, response', () => {
  const records = capture('1.0.223', 'plugin-permission.jsonl');
  const types = new Set(events(records).map((r) => r.type));
  assert.ok(types.has('permission.updated'));
  assert.equal(types.has('permission.asked'), false);
  const updated = events(records, 'permission.updated').map(props);
  const replied = events(records, 'permission.replied').map(props);
  assert.deepEqual(
    replied.map((p) => p.response),
    ['once', 'reject'],
  );
  updated.forEach((ask, i) => {
    assert.equal(ask.type, 'bash');
    assert.match(ask.callID ?? '', /^call_/);
    assert.equal(replied[i]?.permissionID, ask.id);
    assert.equal(replied[i]?.requestID, undefined);
  });
  // The awaited `permission.ask` hook still fired there, just before each event.
  assert.equal(records.filter((r) => r.kind === 'permission.ask').length, 2);
});

test('a permission request sits inside its tool call; a rejected call never completes', () => {
  const records = capture(V, 'plugin-permission-tui.jsonl');
  for (const ask of events(records, 'permission.asked')) {
    const callID = props(ask).tool?.callID ?? '';
    const before = one(
      records,
      (r) => r.kind === 'tool.execute.before' && r.input?.callID === callID,
    );
    assert.ok(before.seq < ask.seq, 'tool.execute.before comes first');
  }
  // Approved once: the call runs and completes.
  assert.deepEqual(toolParts(records, 'call_30_0'), ['pending', 'running', 'running', 'completed']);
  // Rejected: the part errors, and tool.execute.after never fires for it.
  assert.deepEqual(toolParts(records, 'call_31_0'), ['pending', 'running', 'error']);
  assert.equal(
    records.some((r) => r.kind === 'tool.execute.after' && r.input?.callID === 'call_31_0'),
    false,
  );
});

test('tools from one response run in parallel and can complete out of start order', () => {
  const records = capture(V, 'plugin-tools.jsonl').filter((r) => r.kind.startsWith('tool.execute'));
  assert.deepEqual(
    records.map(
      (r) => `${r.kind.slice('tool.execute.'.length)}:${r.input?.tool}:${r.input?.callID}`,
    ),
    [
      'before:bash:call_26_0',
      'before:read:call_26_1',
      'after:read:call_26_1',
      'after:bash:call_26_0',
      'before:write:call_27_0',
      'after:write:call_27_0',
    ],
  );
});

test('message.updated repeats per message; the latest value per id is the true total', () => {
  const records = capture(V, 'plugin-tools.jsonl');
  const assistant = events(records, 'message.updated')
    .map((r) => props(r).info)
    .filter((i): i is Info => i?.role === 'assistant');
  const ids = new Set(assistant.map((i) => i.id));
  assert.equal(ids.size, 3);
  assert.ok(assistant.length > ids.size * 2, 'each message is updated several times');
  const latest = new Map(assistant.map((i) => [i.id, i]));
  const sum = (f: (i: Info) => number) => [...latest.values()].reduce((n, i) => n + f(i), 0);
  const naive = assistant.reduce((n, i) => n + (i.tokens?.output ?? 0), 0);
  const output = sum((i) => i.tokens?.output ?? 0);
  assert.ok(naive > output, 'summing every update double-counts');
  assert.ok([...latest.values()].every((i) => i.time?.completed && i.modelID === 'mock-large'));
  // The session's own aggregate, carried by session.updated, agrees.
  const session = props(events(records, 'session.updated').at(-1)).info;
  assert.equal(session?.tokens?.output, output);
  assert.equal(Number(session?.cost?.toFixed(9)), Number(sum((i) => i.cost ?? 0).toFixed(9)));
});

test('a resumed root sends no session.created; the public client resolves it as a root', () => {
  const records = capture(V, 'plugin-resume.jsonl');
  assert.equal(events(records, 'session.created').length, 0);
  assert.equal(records[1]?.kind, 'chat.message');
  const id = records[1]?.input?.sessionID;
  const lookup = one(records, (r) => r.kind === 'lookup');
  assert.equal(lookup.id, id);
  assert.equal(lookup.outcome, 'root');
  assert.deepEqual(
    lookup.chain?.map((c) => c.parentID),
    [null],
  );
  // Only the new turn is reported: earlier messages' usage is not re-sent.
  const messages = new Set(events(records, 'message.updated').map((r) => props(r).info?.id));
  assert.equal(messages.size, 2);
});

test('an unknown child resolves to its root, but only after its first events arrive', () => {
  const records = capture(V, 'plugin-unknown-child.jsonl');
  assert.equal(events(records, 'session.created').length, 0);
  const lookup = one(records, (r) => r.kind === 'lookup');
  assert.equal(lookup.outcome, 'root');
  const [child, root] = lookup.chain ?? [];
  assert.equal(child?.id, lookup.id);
  assert.equal(child?.parentID, root?.id);
  assert.equal(root?.parentID, null);
  // Child events were already delivered to the plugin before the lookup came back.
  const early = events(records).filter(
    (r) => r.seq < lookup.seq && (props(r).sessionID ?? props(r).info?.id) === lookup.id,
  );
  assert.ok(early.length >= 1);
});

test('a subagent is a child session with parentID; its events carry the child id', () => {
  const records = capture(V, 'plugin-subagent-dispose.jsonl');
  const created = events(records, 'session.created').map((r) => props(r).info);
  assert.equal(created.length, 2);
  const [root, child] = created;
  assert.equal(root?.parentID, undefined);
  assert.equal(child?.parentID, root?.id);
  const childLookup = one(records, (r) => r.kind === 'lookup' && r.id === child?.id);
  assert.deepEqual(
    childLookup.chain?.map((c) => c.id),
    [child?.id, root?.id],
  );
  // The child's own tool asks for permission under the child's session id.
  assert.equal(props(one(records, (r) => r.type === 'permission.asked')).sessionID, child?.id);
});

test('parent lookups can cycle or dangle; the public client reports a missing session as 404', () => {
  const records = capture(V, 'plugin-cycle-dangling.jsonl');
  const outcomes = records.filter((r) => r.kind === 'lookup').map((r) => r.outcome);
  assert.deepEqual(outcomes.sort(), ['cycle', 'unresolved']);
  const lookups = json<
    Record<string, { status: number; parentID?: string | null; error?: { name?: string } }>
  >(V, 'session-get.json');
  const a = lookups['ses_0vdpcycle0000000000000000A'];
  const b = lookups['ses_0vdpcycle0000000000000000B'];
  assert.equal(a?.parentID, 'ses_0vdpcycle0000000000000000B');
  assert.equal(b?.parentID, 'ses_0vdpcycle0000000000000000A');
  assert.equal(
    lookups['ses_0vdpdangling00000000000000C']?.parentID,
    'ses_0vdpmissing000000000000000D',
  );
  const missing = lookups['ses_0vdpmissing000000000000000D'];
  assert.equal(missing?.status, 404);
  assert.equal(missing?.error?.name, 'NotFoundError');
});

test('REST recovery: session.messages lists each message once with its final usage', () => {
  const messages = json<Info[]>(V, 'session-messages.json');
  const assistant = messages.filter((m) => m.role === 'assistant');
  assert.equal(new Set(assistant.map((m) => m.id)).size, assistant.length);
  const lookups = json<Record<string, { data?: Info }>>(V, 'session-get.json');
  const root = Object.values(lookups).find((l) => l.data?.id === assistant[0]?.sessionID)?.data;
  assert.equal(
    root?.tokens?.output,
    assistant.reduce((n, m) => n + (m.tokens?.output ?? 0), 0),
  );
});

test('the probe queue delivers every event once, in order, per plugin instance', () => {
  for (const name of RUNS) {
    const records = capture(V, name);
    for (const instance of instances(records)) {
      const refs = deliveredRefs(records, instance);
      assert.deepEqual(
        refs,
        [...refs].sort((x, y) => x - y),
        `${name} ${instance} in order`,
      );
      assert.equal(new Set(refs).size, refs.length, `${name} ${instance} once`);
      const done = records.find((r) => r.instance === instance && r.kind === 'dispose.done');
      if (!PARTIAL_DELIVERY.includes(name) && done?.queued === 0 && done.inFlight === null) {
        const disposeSeq = one(records, (r) => r.instance === instance && r.kind === 'dispose').seq;
        const owed = events(records)
          .filter((r) => r.instance === instance && r.seq < disposeSeq)
          .map((r) => r.seq);
        assert.ok(
          owed.every((seq) => refs.includes(seq)),
          `${name} ${instance} drained`,
        );
      }
    }
  }
});

test('dispose is awaited: lifecycle-end events queued at exit are still delivered', () => {
  const records = capture(V, 'plugin-shutdown-queued.jsonl');
  const instance = records[0]?.instance ?? '';
  const dispose = one(records, (r) => r.instance === instance && r.kind === 'dispose');
  assert.ok((dispose.queued ?? 0) > 10, 'a backlog at dispose');
  const ends = events(records).filter((r) => r.instance === instance && isIdle(r));
  assert.equal(ends.length, 2);
  const deliveredLate = records
    .filter((r) => r.instance === instance && r.kind === 'delivered' && r.at >= dispose.at)
    .flatMap((r) => r.refs ?? [r.ref]);
  for (const end of ends) assert.ok(deliveredLate.includes(end.seq), `${end.type} delivered`);
});

test('events keep arriving after dispose starts, and a late instance may never be disposed', () => {
  const records = capture(V, 'plugin-shutdown-queued.jsonl');
  const [first, second] = instances(records);
  const dispose = one(records, (r) => r.instance === first && r.kind === 'dispose');
  assert.ok(events(records).some((r) => r.instance === first && r.seq > dispose.seq));
  // A second plugin instance started during shutdown and got no dispose.
  assert.ok(second);
  assert.equal(
    records.some((r) => r.instance === second && r.kind === 'dispose'),
    false,
  );
});

test('a failing or hung delivery never stops the entries after it', () => {
  const records = capture(V, 'plugin-queue-failures.jsonl');
  const delivered = records.filter((r) => r.kind === 'delivered');
  const failed = delivered.filter((r) => r.code !== 0);
  assert.ok(failed.some((r) => r.code === 1));
  assert.ok(failed.some((r) => r.signal === 'SIGTERM'));
  // After every failure but the last, the queue went on to the next entry...
  for (const f of failed.slice(0, -1)) {
    assert.ok(
      delivered.some((r) => r.seq > f.seq && (r.ref ?? 0) > (f.ref ?? 0)),
      `the queue moved on after ${f.ref}`,
    );
  }
  // ...and later entries were delivered successfully.
  const firstFailure = failed[0]?.seq ?? Infinity;
  assert.ok(delivered.some((r) => r.code === 0 && r.seq > firstFailure));
});

test('before 1.15.11 OpenCode never disposes plugins, and exit loses the idle events', () => {
  const old = capture('1.15.10', 'plugin-exit.jsonl');
  assert.equal(
    old.some((r) => r.kind === 'dispose'),
    false,
  );
  const lost = events(old).filter(
    (r) => isIdle(r) && !deliveredRefs(old, r.instance).includes(r.seq),
  );
  assert.equal(lost.length, 2);

  const fixed = capture('1.15.11', 'plugin-exit.jsonl');
  assert.ok(fixed.some((r) => r.kind === 'dispose'));
  const refs = deliveredRefs(fixed, fixed[0]?.instance ?? '');
  assert.ok(events(fixed).every((r) => refs.includes(r.seq)));
});

test('a signal to `opencode run` ends it with no dispose and no idle event', () => {
  const records = capture(V, 'plugin-run-sigterm.jsonl');
  assert.equal(
    records.some((r) => r.kind.startsWith('dispose') || isIdle(r)),
    false,
  );
  // The last thing the plugin heard was a running tool.
  const last = events(records).at(-1);
  assert.equal(props(last).part?.state?.status, 'running');
});

test('closing the TUI aborts the turn, idles the session and disposes the plugin', () => {
  const records = capture(V, 'plugin-tui-hangup.jsonl');
  const asked = one(records, (r) => r.type === 'permission.asked');
  const next = records
    .filter((r) => r.kind !== 'delivered' && r.seq > asked.seq)
    .slice(0, 4)
    .map((r) => r.type ?? r.kind);
  assert.deepEqual(next, ['session.error', 'session.status', 'session.idle', 'dispose']);
  const error = props(one(records, (r) => r.type === 'session.error')).error;
  assert.equal(error?.name, 'MessageAbortedError');
  // The open permission request is never answered: only the abort ends the wait.
  assert.equal(events(records, 'permission.replied').length, 0);
});

test('Ctrl+C at a TUI permission prompt rejects it, then a second Ctrl+C quits', () => {
  const records = capture(V, 'plugin-tui-ctrl-c.jsonl');
  assert.deepEqual(
    events(records, 'permission.replied').map((r) => props(r).reply),
    ['reject'],
  );
  assert.ok(records.some((r) => r.kind === 'dispose'));
});

test('disposing an instance aborts a running child, but the root gets no end event', () => {
  const records = capture(V, 'plugin-subagent-dispose.jsonl');
  const [root, child] = events(records, 'session.created').map((r) => props(r).info?.id);
  const dispose = one(records, (r) => r.kind === 'dispose');
  const before = events(records).filter((r) => r.seq < dispose.seq);
  const ended = (id?: string) =>
    before
      .filter((r) => isIdle(r) || r.type === 'session.error')
      .map((r) => props(r).sessionID === id);
  assert.ok(ended(child).includes(true));
  assert.equal(ended(root).includes(true), false);
});
