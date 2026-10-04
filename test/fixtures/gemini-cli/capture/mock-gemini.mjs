// Local Gemini API mock for capturing Gemini CLI fixtures. Every
// generateContent / streamGenerateContent request is answered from
// scenarios.mjs, keyed by the latest user text that names a scenario and by
// how many function-response batches followed it.
// usage: node mock-gemini.mjs <scenarios.mjs> <request-log> [port] (default 8766)
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { default: script } = await import(pathToFileURL(process.argv[2]).href);
const log = process.argv[3];
const port = Number(process.argv[4] ?? 8766);
let n = 0;
/** The plain text of one content entry. */
const text = (c) => (c.parts ?? []).map((p) => p.text ?? '').join('');
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url ?? '';
    if (req.method !== 'POST' || !/:(stream)?[gG]enerateContent|:countTokens/.test(url)) {
      appendFileSync(log, JSON.stringify({ other: `${req.method} ${url}` }) + '\n');
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const parsed = body ? JSON.parse(body) : {};
    if (url.includes(':countTokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ totalTokens: 10 }));
    }
    const contents = parsed.contents ?? [];
    let last = -1;
    contents.forEach((c, i) => {
      if (c.role === 'user' && Object.keys(script).some((k) => text(c).includes(k))) last = i;
    });
    const key =
      last >= 0 ? Object.keys(script).find((k) => text(contents[last]).includes(k)) : undefined;
    // Each model function-call turn after the prompt advances one step.
    const step = contents
      .slice(last + 1)
      .filter((c) => c.role === 'model' && (c.parts ?? []).some((p) => p.functionCall)).length;
    const steps = key ? script[key] : [];
    n++;
    const model = url.match(/models\/([^:]+):/)?.[1] ?? 'unknown';
    // Side requests (routing, summaries, next-speaker checks) get plain JSON-ish text.
    const side = !key || parsed.generationConfig?.responseMimeType === 'application/json';
    const parts = side
      ? [
          {
            text:
              parsed.generationConfig?.responseMimeType === 'application/json'
                ? '{"next_speaker":"user","reasoning":"done","model_choice":"flash"}'
                : `done ${key ?? ''}`.trim(),
          },
        ]
      : (steps[step] ?? [{ text: `done ${key}` }]);
    appendFileSync(
      log,
      JSON.stringify({
        n,
        url: url.replace(/key=[^&]+/, 'key=…'),
        model,
        key,
        step,
        side,
        out: parts.map((p) => p.functionCall?.name ?? 'text'),
      }) + '\n',
    );
    const chunk = {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 7 * n,
        totalTokenCount: 100 + 7 * n,
      },
      modelVersion: model,
      responseId: `resp_${n}`,
    };
    if (url.includes('streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chunk));
  });
}).listen(port, '127.0.0.1');
