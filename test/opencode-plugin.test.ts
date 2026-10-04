// The generated OpenCode plugin, run for real: the rendered module is imported
// as OpenCode would load it, fed the bus events captured from OpenCode 1.18.34
// and 1.0.223 (test/fixtures/opencode), and given a fake public client that
// answers like the captured `client.session.get`. Its VDP process is a sink
// that records each batch it receives on stdin; the batches are then applied
// through the real hook translator and session store.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionStore } from '../src/core/session-store';
import { END_TYPE, parseSnapshots, runHook, type OpenCodeSnapshot } from '../src/provider/opencode';
import {
  OPENCODE_PLUGIN_HEADER,
  isOwnedPlugin,
  renderOpenCodePlugin,
  type OpenCodePluginOptions,
} from '../src/provider/opencode-plugin';
import type { TranslateEnv } from '../src/provider/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/opencode');
const ENV: TranslateEnv = { cwd: '/home/me/fallback' };

interface Rec {
  instance: string;
  kind: string;
  type?: string;
  event?: { type: string; properties: Record<string, unknown> };
  chain?: { id: string; parentID?: string | null; error?: string }[];
}
const capture = (version: string, name: string): Rec[] =>
  readFileSync(join(FIXTURES, version, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Rec)
    .filter((r) => r.kind !== 'process.exit');

/** Every parent link OpenCode reported, from the lookup dumps and the probe's lookups. */
function knownParents(): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  const dump = JSON.parse(
    readFileSync(join(FIXTURES, '1.18.34/session-get.json'), 'utf8'),
  ) as Record<string, { status: number; parentID?: string | null }>;
  for (const [id, entry] of Object.entries(dump)) {
    if (entry.status === 200) parents.set(id, entry.parentID ?? null);
  }
  for (const [version, names] of [
    [
      '1.18.34',
      [
        'plugin-tools.jsonl',
        'plugin-permission-tui.jsonl',
        'plugin-resume.jsonl',
        'plugin-shutdown-queued.jsonl',
      ],
    ],
    ['1.0.223', ['plugin-permission.jsonl']],
  ] as const) {
    for (const name of names) {
      for (const r of capture(version, name)) {
        for (const link of r.chain ?? []) {
          if (!link.error) parents.set(link.id, link.parentID ?? null);
        }
      }
    }
  }
  return parents;
}
const PARENTS = knownParents();

let dir: string;
let sink: string;
let pluginCount = 0;
before(() => {
  // A path no shell could survive unquoted: the plugin must never use one.
  dir = mkdtempSync(join(tmpdir(), 'vdp opencode $HOME `x` \'q\' "d" (x86) &;%PATH%! '));
  sink = join(dir, 'sink.mjs');
  writeFileSync(
    sink,
    `import { appendFileSync, readFileSync } from 'node:fs';
const [log, fail = '', hang = '', delay = '0'] = process.argv.slice(2);
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch {}
if (Number(delay) > 0) await new Promise((r) => setTimeout(r, Number(delay)));
appendFileSync(log, JSON.stringify({ raw }) + '\\n');
const types = raw.split('\\n').filter(Boolean).map((l) => JSON.parse(l).type);
if (types.some((t) => hang.split(',').includes(t))) setInterval(() => {}, 1000);
else if (types.some((t) => fail.split(',').includes(t))) process.exit(1);
`,
  );
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Sink {
  fail?: string[];
  hang?: string[];
  delayMs?: number;
}
type Hooks = {
  event: (input: { event: unknown }) => Promise<void>;
  dispose: () => Promise<void>;
};
interface Client {
  session: { get: (input: { path: { id: string } }) => Promise<unknown> };
}

/** A public client answering from the captured lookups, optionally slowly. */
function fixtureClient(delayMs = 0, calls: string[] = []): Client {
  return {
    session: {
      get: async ({ path: { id } }) => {
        calls.push(id);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (!PARENTS.has(id))
          return { error: { name: 'NotFoundError' }, response: { status: 404 } };
        const parentID = PARENTS.get(id);
        return { data: { id, ...(parentID ? { parentID } : {}) } };
      },
    },
  };
}

/** Render, write and import a plugin as OpenCode does, and start one instance. */
async function startPlugin(
  options: { sink?: Sink; client?: Client } & Omit<OpenCodePluginOptions, 'command'> = {},
) {
  const log = join(dir, `delivered-${++pluginCount}.jsonl`);
  const { sink: s = {}, client = fixtureClient(), ...timing } = options;
  const file = join(dir, `plugin-${pluginCount}.js`);
  const source = renderOpenCodePlugin({
    command: [
      process.execPath,
      sink,
      log,
      (s.fail ?? []).join(','),
      (s.hang ?? []).join(','),
      String(s.delayMs ?? 0),
    ],
    ...timing,
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const exports = Object.values(mod);
  // OpenCode calls every export as a plugin and rejects a module with any other export.
  assert.equal(exports.length, 1);
  assert.equal(typeof exports[0], 'function');
  const hooks = (await (exports[0] as (input: unknown) => Promise<Hooks>)({
    directory: '/home/me/my-app',
    worktree: '/home/me/my-app',
    client,
  })) as Hooks;
  /** Every batch the VDP process received so far, in delivery order. */
  const batches = (): string[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => (JSON.parse(l) as { raw: string }).raw)
      : [];
  const lines = (): OpenCodeSnapshot[] => batches().flatMap((raw) => parseSnapshots(raw));
  return { hooks, batches, lines, file };
}

/** Replay one plugin instance's captured bus events, unawaited as OpenCode calls them. */
function replay(hooks: Hooks, records: Rec[], instance = records[0]?.instance): void {
  for (const r of records) {
    if (r.instance === instance && r.kind === 'event') void hooks.event({ event: r.event });
  }
}

const waitFor = async (predicate: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Apply delivered batches through the real hook process into a fresh store. */
async function applyBatches(raws: string[], now = 1_800_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), 'vdp-opencode-store-'));
  for (const raw of raws) {
    await runHook([], {
      readInput: () => raw,
      now: () => now,
      environment: () => ENV,
      root: () => root,
      createStore: (r) => new SessionStore(r),
      ensureDaemon: () => {},
    });
  }
  const state = new SessionStore(root).snapshot(now);
  rmSync(root, { recursive: true, force: true });
  return state;
}
const withoutEnds = (raw: string) =>
  raw
    .split('\n')
    .filter((l) => !l.includes(`"type":"${END_TYPE}"`))
    .join('\n');

/** The order of the given event types in a fixture instance, and as delivered. */
const typeOrder = (types: string[], fromFixture: Rec[], delivered: OpenCodeSnapshot[]) => [
  fromFixture.filter((r) => r.kind === 'event' && types.includes(r.type ?? '')).map((r) => r.type),
  delivered.filter((l) => types.includes(l.type)).map((l) => l.type),
];

test('the generated plugin carries the ownership header and embeds paths as data', () => {
  const source = renderOpenCodePlugin({
    command: ['/usr/bin/node', "/a b/$(rm -rf ~)`x`'q'/vdp.js"],
  });
  assert.ok(source.startsWith(`${OPENCODE_PLUGIN_HEADER}\n`));
  assert.ok(isOwnedPlugin(source));
  assert.ok(source.includes(JSON.stringify("/a b/$(rm -rf ~)`x`'q'/vdp.js")));
  assert.match(source, /shell: false/);
  assert.equal(isOwnedPlugin(`// my own plugin\n${OPENCODE_PLUGIN_HEADER}\n`), false);
  assert.ok(isOwnedPlugin(`\ufeff${OPENCODE_PLUGIN_HEADER}\r\nrest`));
});

test('a turn with parallel tools reaches VDP in bus order, attributed to its root', async () => {
  const records = capture('1.18.34', 'plugin-tools.jsonl');
  const root = 'ses_ef9888c88ffeP4r4571xrlocMJ';
  const plugin = await startPlugin();
  replay(plugin.hooks, records);
  await plugin.hooks.dispose();

  const lines = plugin.lines();
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => l.root === root && l.v === 1));
  assert.ok(lines.every((l) => l.type === END_TYPE || l.cwd === '/home/me/my-app'));
  // Nothing housekeeping-only or streaming is sent.
  assert.ok(
    !lines.some((l) => ['plugin.added', 'message.part.delta', 'session.diff'].includes(l.type)),
  );
  // Lifecycle events keep their exact order; nothing is coalesced.
  const [expected, delivered] = typeOrder(
    ['session.created', 'session.status', 'session.idle', 'permission.asked', 'permission.replied'],
    records,
    lines,
  );
  assert.deepEqual(delivered, expected);
  // Each tool call's state changes arrive in order, once each.
  const states = (call: string) => lines.filter((l) => l.call === call).map((l) => l.state);
  assert.deepEqual(states('call_26_0'), ['pending', 'running', 'completed']);
  assert.deepEqual(states('call_26_1'), ['pending', 'running', 'completed']);
  assert.equal(
    lines.find((l) => l.call === 'call_27_0' && l.state === 'running')?.file,
    '/home/me/my-app/hello.txt',
  );
  // Snapshots carry no payload text (prompts, file content, command output).
  const allowed = new Set([
    'v',
    'type',
    'root',
    'session',
    'cwd',
    'parent',
    'status',
    'message',
    'role',
    'model',
    'output',
    'cost',
    'call',
    'tool',
    'state',
    'file',
    'request',
  ]);
  for (const l of lines) for (const key of Object.keys(l)) assert.ok(allowed.has(key), key);
  // dispose ends the root after everything queued before it.
  assert.deepEqual(lines.at(-1), { v: 1, type: END_TYPE, root });
  assert.equal(lines.filter((l) => l.type === END_TYPE).length, 1);

  // Through the hook: an idle root with the turn's exact usage, then ended.
  const state = await applyBatches(plugin.batches().map(withoutEnds));
  assert.equal(state?.sessionId, root);
  assert.equal(state?.activity, 'Idle');
  assert.equal(state?.project, 'my-app');
  assert.equal(state?.model, 'mock-large');
  assert.equal(state?.tokens, 182 + 189 + 196);
  assert.equal(state?.cost?.toFixed(6), (0.000464 + 0.000478 + 0.000492).toFixed(6));
  assert.equal(await applyBatches(plugin.batches()), null);
});

test('a TUI permission prompt shows as waiting until it is answered or rejected', async () => {
  const records = capture('1.18.34', 'plugin-permission-tui.jsonl');
  const plugin = await startPlugin();
  replay(plugin.hooks, records);
  await plugin.hooks.dispose();
  // Step through every delivered line to see each visible activity.
  const seen: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'vdp-opencode-tui-'));
  for (const l of plugin.lines()) {
    await runHook([], {
      readInput: () => JSON.stringify(l),
      now: () => 1_800_000_000_000,
      environment: () => ENV,
      root: () => root,
      createStore: (r) => new SessionStore(r),
      ensureDaemon: () => {},
    });
    const activity = new SessionStore(root).snapshot(1_800_000_000_000)?.activity ?? 'ended';
    if (seen.at(-1) !== activity) seen.push(activity);
  }
  rmSync(root, { recursive: true, force: true });
  assert.equal(seen.filter((a) => a === 'Waiting for permission').length, 2);
  // The rejected call errors and never completes, yet nothing stays stuck.
  assert.deepEqual(seen.slice(-2), ['Idle', 'ended']);
});

test('the pre-1.0.224 permission names and fields are accepted', async () => {
  const records = capture('1.0.223', 'plugin-permission.jsonl');
  const plugin = await startPlugin();
  replay(plugin.hooks, records);
  await plugin.hooks.dispose();
  const lines = plugin.lines();
  const asked = lines.filter((l) => l.type === 'permission.updated');
  const replied = lines.filter((l) => l.type === 'permission.replied');
  assert.equal(asked.length, 2);
  assert.deepEqual(
    replied.map((l) => l.request),
    asked.map((l) => l.request),
  );
  assert.ok(asked.every((l) => /^per_/.test(l.request ?? '')));
  const state = await applyBatches(plugin.batches().map(withoutEnds));
  assert.equal(state?.activity, 'Idle', 'both waits ended');
});

test("a subagent's work, permission included, lands on its root's one marker", async () => {
  const records = capture('1.18.34', 'plugin-subagent-dispose.jsonl');
  const root = 'ses_ef986de5cffernPG5zeiXoUrah';
  const child = 'ses_ef986d75cffeQs277PBgJo5MGB';
  const plugin = await startPlugin();
  replay(plugin.hooks, records);
  await plugin.hooks.dispose();
  const lines = plugin.lines();
  assert.ok(lines.some((l) => l.session === child));
  assert.ok(lines.every((l) => l.root === root));
  assert.equal(lines.find((l) => l.type === 'permission.asked')?.session, child);
  // The reload ends the root, which got no end event of its own.
  assert.deepEqual(
    lines.filter((l) => l.type === END_TYPE),
    [{ v: 1, type: END_TYPE, root }],
  );
  const state = await applyBatches(plugin.batches().map(withoutEnds));
  assert.equal(state?.sessionCount, 1);
  assert.equal(state?.sessionId, root);
});

test('an unknown child is held until the public client names its root', async () => {
  const records = capture('1.18.34', 'plugin-unknown-child.jsonl');
  const root = 'ses_ef986de5cffernPG5zeiXoUrah';
  const child = 'ses_ef986d75cffeQs277PBgJo5MGB';
  const calls: string[] = [];
  // The captured lookup took about 480 ms, after several child events.
  const plugin = await startPlugin({ client: fixtureClient(150, calls) });
  replay(plugin.hooks, records);
  await plugin.hooks.dispose();
  const lines = plugin.lines();
  assert.ok(lines.length > 5);
  assert.ok(lines.every((l) => l.root === root));
  assert.ok(lines.filter((l) => l.type !== END_TYPE).every((l) => l.session === child));
  // The event that taught the parent link (session.updated) made the lookup unneeded
  // for the child, so only the root was looked up.
  assert.ok(calls.length <= 2);
  const [expected, delivered] = typeOrder(['session.status', 'session.idle'], records, lines);
  assert.deepEqual(delivered, expected);
  const state = await applyBatches(plugin.batches().map(withoutEnds));
  assert.equal(state?.sessionId, root);
  assert.equal(state?.tokens, 245);
});

test('a resumed root sends no session.created and is still resolved and reported', async () => {
  const records = capture('1.18.34', 'plugin-resume.jsonl');
  const root = 'ses_ef986de5cffernPG5zeiXoUrah';
  const calls: string[] = [];
  const plugin = await startPlugin({ client: fixtureClient(20, calls) });
  replay(plugin.hooks, records);
  await plugin.hooks.dispose();
  assert.deepEqual(calls, [root]);
  const state = await applyBatches(plugin.batches().map(withoutEnds));
  assert.equal(state?.sessionId, root);
  assert.equal(state?.tokens, 252);
  assert.equal(state?.cost, 0.000604);
});

test('a parent cycle or a missing parent never creates a marker', async () => {
  const records = capture('1.18.34', 'plugin-cycle-dangling.jsonl');
  const calls: string[] = [];
  const plugin = await startPlugin({ client: fixtureClient(0, calls) });
  replay(plugin.hooks, records);
  await plugin.hooks.dispose();
  assert.deepEqual(plugin.lines(), []);
  // Links already learned from events need no lookup; each unknown one is looked up once.
  assert.equal(new Set(calls).size, calls.length);
  assert.ok(calls.includes('ses_0vdpmissing000000000000000D'));
  assert.ok(calls.length <= 4);
});

test('the parent walk is bounded', async () => {
  const chain = Array.from({ length: 12 }, (_, i) => `ses_deep${i}`);
  const calls: string[] = [];
  const client: Client = {
    session: {
      get: async ({ path: { id } }) => {
        calls.push(id);
        const i = chain.indexOf(id);
        return { data: { id, ...(i < chain.length - 1 ? { parentID: chain[i + 1] } : {}) } };
      },
    },
  };
  const plugin = await startPlugin({ client });
  void plugin.hooks.event({
    event: {
      type: 'session.status',
      properties: { sessionID: chain[0], status: { type: 'busy' } },
    },
  });
  await plugin.hooks.dispose();
  assert.deepEqual(plugin.lines(), []);
  assert.ok(calls.length <= 9, `${calls.length} lookups`);
});

const status = (sessionID: string, type: string) => ({
  type: 'session.status',
  properties: { sessionID, status: { type } },
});
const created = (id: string) => ({ type: 'session.created', properties: { info: { id } } });
const event = (type: string, sessionID: string) => ({ type, properties: { sessionID } });

test('a hung public-client lookup costs a bounded wait and never blocks later sessions', async () => {
  const client: Client = { session: { get: () => new Promise(() => {}) } };
  const plugin = await startPlugin({ client, lookupTimeoutMs: 100 });
  const started = Date.now();
  await plugin.hooks.event({ event: status('ses_unknown', 'busy') });
  assert.ok(Date.now() - started < 50, 'the callback returns at once');
  void plugin.hooks.event({ event: created('ses_known') });
  void plugin.hooks.event({ event: status('ses_known', 'busy') });
  await waitFor(() => plugin.lines().length >= 2);
  assert.ok(plugin.lines().every((l) => l.root === 'ses_known'));
  await plugin.hooks.dispose();
});

test('a failed or hung VDP process never stops the entries after it', async () => {
  const plugin = await startPlugin({
    sink: { fail: ['session.error'], hang: ['session.idle'] },
    childTimeoutMs: 200,
  });
  void plugin.hooks.event({ event: created('ses_a') });
  await waitFor(() => plugin.batches().length === 1);
  void plugin.hooks.event({ event: event('session.error', 'ses_a') }); // exits 1
  await waitFor(() => plugin.batches().length === 2);
  void plugin.hooks.event({ event: event('session.idle', 'ses_a') }); // hangs until killed
  await waitFor(() => plugin.batches().length === 3);
  void plugin.hooks.event({ event: status('ses_a', 'busy') });
  await waitFor(() => plugin.batches().length === 4);
  await plugin.hooks.dispose();
  assert.deepEqual(
    plugin.lines().map((l) => l.type),
    ['session.created', 'session.error', 'session.idle', 'session.status', END_TYPE],
  );
});

test('a backlog is batched, delivered once and in order, one process at a time', async () => {
  const plugin = await startPlugin({ sink: { delayMs: 100 } });
  void plugin.hooks.event({ event: created('ses_a') });
  for (let i = 0; i < 60; i++) {
    void plugin.hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          info: { id: `msg_${i}`, sessionID: 'ses_a', role: 'assistant', tokens: { output: i } },
        },
      },
    });
  }
  await plugin.hooks.dispose();
  const messages = plugin.lines().filter((l) => l.type === 'message.updated');
  assert.deepEqual(
    messages.map((l) => l.message),
    Array.from({ length: 60 }, (_, i) => `msg_${i}`),
  );
  assert.ok(plugin.batches().length < 10, `${plugin.batches().length} processes`);
});

test('dispose drains for a bounded time, then ignores events that keep arriving', async () => {
  const plugin = await startPlugin({
    sink: { hang: ['session.status'] },
    drainMs: 300,
    childTimeoutMs: 10_000,
  });
  void plugin.hooks.event({ event: created('ses_a') });
  void plugin.hooks.event({ event: status('ses_a', 'busy') });
  await waitFor(() => plugin.batches().length >= 1);
  const started = Date.now();
  await plugin.hooks.dispose();
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 2000, `dispose took ${took} ms`);
  // A late event after dispose starts is not queued.
  await plugin.hooks.event({ event: status('ses_a', 'idle') });
  assert.ok(!plugin.lines().some((l) => l.status === 'idle'));
});

test('dispose ends nothing for an instance that reported nothing', async () => {
  const plugin = await startPlugin();
  await plugin.hooks.dispose();
  assert.deepEqual(plugin.batches(), []);
});

test('a backlog at exit is drained in order, and a late instance cannot revive the root', async () => {
  const records = capture('1.18.34', 'plugin-shutdown-queued.jsonl');
  const [first, second] = [...new Set(records.map((r) => r.instance))];
  const plugin = await startPlugin({ sink: { delayMs: 120 } });
  replay(plugin.hooks, records, first);
  await plugin.hooks.dispose();
  const lines = plugin.lines();
  const [expected, delivered] = typeOrder(
    ['session.status', 'session.idle'],
    records.filter((r) => r.instance === first),
    lines,
  );
  assert.deepEqual(delivered, expected, 'both idle events and every status, in order');
  assert.equal(lines.at(-1)?.type, END_TYPE);

  // A second instance started during shutdown, never disposed, sees only housekeeping.
  const late = await startPlugin();
  replay(late.hooks, records, second);
  await waitFor(() => late.lines().length > 0);
  assert.equal(await applyBatches([...plugin.batches(), ...late.batches()]), null);
});
