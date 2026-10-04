// Local OpenAI Chat Completions mock for capturing OpenCode fixtures. OpenCode
// talks to it through its bundled `@ai-sdk/openai-compatible` provider. Every
// streamed /chat/completions request is answered from scenarios.mjs, keyed by
// the latest user message that names a scenario and by how many assistant
// tool-call turns followed it. Side requests (session titles) get plain text.
// usage: node mock-openai.mjs <scenarios.mjs> <request-log> [port] (default 8767)
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { default: script } = await import(pathToFileURL(process.argv[2]).href);
const log = process.argv[3];
const port = Number(process.argv[4] ?? 8767);
let n = 0;
/** The plain text of one chat message. */
const text = (m) =>
  typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join('');
const sse = (res, chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const url = req.url ?? '';
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      appendFileSync(log, JSON.stringify({ other: `${req.method} ${url}` }) + '\n');
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const parsed = JSON.parse(body);
    const messages = parsed.messages ?? [];
    let last = -1;
    messages.forEach((m, i) => {
      if (m.role === 'user' && Object.keys(script).some((k) => text(m).includes(k))) last = i;
    });
    const key =
      last >= 0 ? Object.keys(script).find((k) => text(messages[last]).includes(k)) : undefined;
    const step = messages
      .slice(last + 1)
      .filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    // A title request has no tools; it must never consume a scenario step.
    const side = !key || !parsed.tools?.length;
    const turn = side ? undefined : script[key][step];
    n++;
    const id = `chatcmpl_${n}`;
    const model = parsed.model;
    appendFileSync(
      log,
      JSON.stringify({
        n,
        model,
        key,
        step,
        side,
        tools: (parsed.tools ?? []).map((t) => t.function?.name),
        out: turn?.calls?.map((c) => c.name) ?? 'text',
      }) + '\n',
    );
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id, object: 'chat.completion.chunk', created: 1, model };
    sse(res, {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    const words = side ? ['Probe ', 'title'] : (turn?.text ?? `done ${key}`).split(/(?<= )/);
    for (const w of words) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
      if (turn?.delayMs) await sleep(turn.delayMs);
    }
    (turn?.calls ?? []).forEach((c, index) =>
      sse(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: `call_${n}_${index}`,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    sse(res, {
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: turn?.calls?.length ? 'tool_calls' : 'stop' },
      ],
    });
    // Token numbers are synthetic: 7 × request number output tokens.
    sse(res, {
      ...base,
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 7 * n, total_tokens: 100 + 7 * n },
    });
    res.end('data: [DONE]\n\n');
  });
}).listen(port, '127.0.0.1');
