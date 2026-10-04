// VDP OpenCode runtime probe: a global plugin dropped into
// <config>/plugins/ (OpenCode auto-discovers {plugin,plugins}/*.{js,ts}).
//
// It records every plugin callback, in invocation order, to VDP_PROBE_LOG, and
// exercises the delivery design the OpenCode provider will use:
//   - each `event` is snapshotted and appended to one ordered queue
//     (only the types in VDP_PROBE_FILTER when it is set);
//   - one child process is in flight at a time, started with a fixed argv
//     (`<node> sink.mjs <seq>`, no shell), and the snapshot goes to its stdin;
//     with VDP_PROBE_BATCH=1 the child takes every queued entry as JSONL;
//   - a failing or crashing child never stops later entries;
//   - `dispose` drains the queue for at most VDP_PROBE_DRAIN_MS;
//   - unknown session ids are resolved through the public client
//     (`client.session.get`), following parentID with a depth bound and cycle
//     protection.
// Nothing here blocks an OpenCode callback: the awaited hooks return at once.
/* global Bun -- OpenCode runs plugins under Bun */
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const env = process.env;
const LOG = env.VDP_PROBE_LOG;
const NODE = env.VDP_PROBE_NODE ?? 'node';
const SINK = env.VDP_PROBE_SINK;
const DRAIN_MS = Number(env.VDP_PROBE_DRAIN_MS ?? 2000);
const CHILD_TIMEOUT_MS = Number(env.VDP_PROBE_CHILD_TIMEOUT_MS ?? 3000);
const MAX_DEPTH = 8;
const FILTER = env.VDP_PROBE_FILTER ? new Set(env.VDP_PROBE_FILTER.split(',')) : null;
const BATCH = env.VDP_PROBE_BATCH === '1';

export const VdpProbe = async (input) => {
  const instance = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const write = (rec) => {
    try {
      appendFileSync(LOG, JSON.stringify({ seq: ++seq, instance, at: Date.now(), ...rec }) + '\n');
    } catch {
      // logging must never throw into OpenCode
    }
    return seq;
  };
  write({
    kind: 'init',
    pid: process.pid,
    directory: input.directory,
    worktree: input.worktree,
    project: input.project?.id,
    serverUrl: String(input.serverUrl ?? ''),
    hasClient: typeof input.client?.session?.get === 'function',
    runtime: typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`,
  });

  // ---- ordered, failure-isolated delivery queue ----
  const queue = [];
  let inFlight = null;
  let drained = null;
  const pump = () => {
    if (inFlight || queue.length === 0) {
      if (!inFlight && drained) drained();
      return;
    }
    const batch = BATCH ? queue.splice(0) : [queue.shift()];
    const entry = { ref: batch[0].ref, type: batch[0].type, refs: batch.map((e) => e.ref) };
    const started = Date.now();
    let child;
    const done = (result) => {
      if (inFlight !== entry) return;
      inFlight = null;
      write({
        kind: 'delivered',
        ...(BATCH ? { refs: entry.refs } : { ref: entry.ref, type: entry.type }),
        ms: Date.now() - started,
        ...result,
      });
      pump();
    };
    inFlight = entry;
    try {
      child = spawn(NODE, [SINK, String(entry.ref)], {
        stdio: ['pipe', 'ignore', 'ignore'],
        shell: false,
        windowsHide: true,
        env,
      });
    } catch (error) {
      return done({ error: String(error) });
    }
    const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ error: String(error) });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(batch.map((e) => JSON.stringify(e.payload)).join('\n') + '\n');
  };
  const enqueue = (ref, type, payload) => {
    queue.push({ ref, type, payload });
    pump();
  };

  // ---- root resolution through the public client ----
  const known = new Map(); // sessionID -> { parentID } | { error }
  const resolving = new Set();
  const resolve = async (id) => {
    if (!id || known.has(id) || resolving.has(id)) return;
    resolving.add(id);
    const chain = [];
    const seen = new Set();
    let cursor = id;
    let outcome = 'root';
    const t0 = Date.now();
    while (cursor) {
      if (seen.has(cursor)) {
        outcome = 'cycle';
        break;
      }
      if (chain.length >= MAX_DEPTH) {
        outcome = 'too-deep';
        break;
      }
      seen.add(cursor);
      let res;
      try {
        res = await input.client.session.get({ path: { id: cursor } });
      } catch (error) {
        res = { error: String(error) };
      }
      const info = res?.data;
      if (!info) {
        chain.push({
          id: cursor,
          error: res?.error ? JSON.stringify(res.error).slice(0, 200) : 'no data',
        });
        outcome = 'unresolved';
        break;
      }
      chain.push({ id: info.id, parentID: info.parentID ?? null, directory: info.directory });
      cursor = info.parentID;
    }
    known.set(id, { chain, outcome });
    resolving.delete(id);
    write({ kind: 'lookup', id, outcome, ms: Date.now() - t0, chain });
  };
  const sessionOf = (event) => {
    const p = event?.properties ?? {};
    return p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? p.info?.id;
  };

  return {
    event: async ({ event }) => {
      const ref = write({ kind: 'event', type: event?.type, event });
      if (!FILTER || FILTER.has(event?.type)) enqueue(ref, event?.type, event);
      void resolve(sessionOf(event));
    },
    'chat.message': async (i, o) => {
      write({ kind: 'chat.message', input: i, messageID: o?.message?.id });
    },
    'permission.ask': async (i, o) => {
      write({ kind: 'permission.ask', input: i, status: o?.status });
    },
    'tool.execute.before': async (i, o) => {
      write({ kind: 'tool.execute.before', input: i, args: o?.args });
    },
    'tool.execute.after': async (i, o) => {
      write({
        kind: 'tool.execute.after',
        input: i,
        title: o?.title,
        metadataKeys: Object.keys(o?.metadata ?? {}),
      });
    },
    'command.execute.before': async (i) => {
      write({ kind: 'command.execute.before', input: i });
    },
    dispose: async () => {
      const t0 = Date.now();
      write({ kind: 'dispose', queued: queue.length, inFlight: inFlight?.ref ?? null });
      if (inFlight || queue.length) {
        await Promise.race([
          new Promise((r) => (drained = r)),
          new Promise((r) => setTimeout(r, DRAIN_MS)),
        ]);
      }
      write({
        kind: 'dispose.done',
        ms: Date.now() - t0,
        queued: queue.length,
        inFlight: inFlight?.ref ?? null,
      });
    },
  };
};

// Record what is still queued when the process exits without (or after) dispose.
process.on('exit', () => {
  try {
    appendFileSync(
      LOG,
      JSON.stringify({ kind: 'process.exit', at: Date.now(), pid: process.pid }) + '\n',
    );
  } catch {
    // ignore
  }
});
