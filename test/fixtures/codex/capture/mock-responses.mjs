// Local Responses API mock for capturing Codex fixtures. Each request is answered
// from scenarios.mjs, keyed by its latest matching user or subagent task message
// and by how many tool-call batches were already answered after it.
// usage: node mock-responses.mjs <scenarios.mjs> <request-log> (listens on 127.0.0.1:8765)
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { default: script } = await import(pathToFileURL(process.argv[2]).href);
const log = process.argv[3];
let n = 0;
/** The text of a message item, including a subagent's encrypted task payload. */
const text = (m) =>
  Array.isArray(m.content)
    ? m.content.map((c) => c.text ?? c.encrypted_content ?? '').join('')
    : String(m.content ?? '');
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.includes('/responses')) {
      res.writeHead(404);
      return res.end('{}');
    }
    const parsed = JSON.parse(body);
    const input = parsed.input ?? [];
    let lastUser = -1;
    input.forEach((it, i) => {
      if (
        ((it.type === 'message' && it.role === 'user') || it.type === 'agent_message') &&
        Object.keys(script).some((k) => text(it).includes(k))
      )
        lastUser = i;
    });
    const prompt = lastUser >= 0 ? text(input[lastUser]) : '';
    let step = 0,
      inCalls = false;
    for (const it of input.slice(lastUser + 1)) {
      const isCall = /_call$/.test(it.type ?? '');
      if (isCall && !inCalls) step++;
      inCalls = isCall;
    }
    const key = Object.keys(script).find((k) => prompt.includes(k));
    const steps = key ? script[key] : [];
    n++;
    const items = steps[step] ?? [
      {
        type: 'message',
        role: 'assistant',
        id: `msg_${n}`,
        content: [{ type: 'output_text', text: `done ${key ?? prompt.slice(0, 20)}` }],
      },
    ];
    appendFileSync(
      log,
      JSON.stringify({
        tail: key ? undefined : input.slice(-3).map((i) => JSON.stringify(i).slice(0, 300)),
        n,
        prompt: prompt.slice(0, 80),
        step,
        out: items.map((i) => i.name ?? i.type),
      }) + '\n',
    );
    const id = 'resp_' + n;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    /** Write one server-sent event. */
    const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ type: 'response.created', response: { id } });
    items.forEach((item, i) => send({ type: 'response.output_item.done', output_index: i, item }));
    send({
      type: 'response.completed',
      response: {
        id,
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 7 * n,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 100 + 7 * n,
        },
      },
    });
    res.end();
  });
}).listen(8765, '127.0.0.1');
