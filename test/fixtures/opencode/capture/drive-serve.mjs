// Drives a running `opencode serve` through the public v1 SDK client (the same
// client a plugin receives), for runs whose timing a TUI cannot control.
// usage: node drive-serve.mjs <sdk dir> <base url> <directory> <step> [args...]
// steps:
//   subagent-reload   prompt scenario-subagent; when the child session asks
//                     for permission, dispose the instance (plugins reload),
//                     then approve the child's permission request
//   prompt <id> <text>  prompt an existing session and wait for it to idle
//   lookups <id...>   print client.session.get results (root/child/cycle/missing)
//   messages <id>     print client.session.messages: the REST view of usage
//   permissions <reply...>  prompt scenario-permission and answer each
//                     permission request in turn (`once` / `reject`), under
//                     either event name (`permission.asked` or the older
//                     `permission.updated`)
import { pathToFileURL } from 'node:url';

const [, , sdkDir, baseUrl, directory, step, ...args] = process.argv;
const { createOpencodeClient } = await import(pathToFileURL(`${sdkDir}/dist/index.js`).href);
const client = createOpencodeClient({ baseUrl, directory });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Resolve when `predicate(event)` matches on the event stream, or reject on timeout. */
async function waitFor(predicate, timeoutMs = 60_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { stream } = await client.event.subscribe({ signal: ac.signal });
    for await (const event of stream) if (predicate(event)) return event;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  throw new Error('timed out');
}

if (step === 'subagent-reload') {
  const { data: root } = await client.session.create({ body: {} });
  log('root', root.id);
  const asked = waitFor((e) => e.type === 'permission.asked' && e.properties.sessionID !== root.id);
  void client.session.prompt({
    path: { id: root.id },
    body: { parts: [{ type: 'text', text: 'scenario-subagent' }] },
  });
  const ask = await asked;
  log('child asked', ask.properties.sessionID, ask.properties.id);
  const { data: disposed } = await client.instance.dispose();
  log('instance disposed', disposed);
  await sleep(500);
  const reply = await client.postSessionIdPermissionsPermissionId({
    path: { id: ask.properties.sessionID, permissionID: ask.properties.id },
    body: { response: 'once' },
  });
  log('reply', reply.response?.status, JSON.stringify(reply.data ?? reply.error));
  const { data: children } = await client.session.children({ path: { id: root.id } });
  log('children', JSON.stringify(children.map((c) => ({ id: c.id, parentID: c.parentID }))));
  const status = await client.session.status?.();
  log('status', JSON.stringify(status?.data));
} else if (step === 'prompt') {
  const [id, text] = args;
  const idle = waitFor((e) => e.type === 'session.idle' && e.properties.sessionID === id);
  void client.session.prompt({ path: { id }, body: { parts: [{ type: 'text', text }] } });
  await idle;
  log('idle', id);
} else if (step === 'lookups') {
  const out = {};
  for (const id of args) {
    const res = await client.session.get({ path: { id } });
    out[id] = res.data
      ? { status: res.response.status, parentID: res.data.parentID ?? null, data: res.data }
      : { status: res.response.status, error: res.error };
  }
  console.log(JSON.stringify(out, null, 2));
} else if (step === 'permissions') {
  const { data: root } = await client.session.create({ body: {} });
  log('root', root.id);
  const isAsk = (e) => e.type === 'permission.asked' || e.type === 'permission.updated';
  const idle = waitFor((e) => e.type === 'session.idle' && e.properties.sessionID === root.id);
  let next = waitFor(isAsk);
  void client.session.prompt({
    path: { id: root.id },
    body: { parts: [{ type: 'text', text: 'scenario-permission' }] },
  });
  for (const response of args) {
    const ask = await next;
    log(ask.type, ask.properties.id, '->', response);
    next = waitFor(isAsk);
    await sleep(300);
    const reply = await client.postSessionIdPermissionsPermissionId({
      path: { id: ask.properties.sessionID, permissionID: ask.properties.id },
      body: { response },
    });
    log('reply', reply.response?.status);
  }
  await idle;
  log('idle', root.id);
} else if (step === 'messages') {
  const res = await client.session.messages({ path: { id: args[0] } });
  console.log(
    JSON.stringify(
      res.data.map((m) => m.info),
      null,
      2,
    ),
  );
} else {
  throw new Error(`unknown step ${step}`);
}
process.exit(0);
