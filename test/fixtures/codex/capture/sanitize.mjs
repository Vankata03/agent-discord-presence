// Redacts capture paths and trims long prompt/instruction text from captured JSONL.
// usage: P=<capture dir> node sanitize.mjs <src> <dst> <rollout|hooks>
import { readFileSync, writeFileSync } from 'node:fs';
const [, , src, dst, kind] = process.argv;
const P = process.env.P;
const redact = (s) =>
  s
    .split(`${P}/homeA`)
    .join('/home/me/.codex')
    .split(`${P}/homeB2`)
    .join('/home/me/.codex')
    .split(`${P}/work`)
    .join('/home/me/my-app')
    .split(P)
    .join('/home/me');
const trim = (v, key) => {
  if (typeof v === 'string')
    return v.length > 160 && !/_path$/.test(key ?? '') ? '[trimmed]' : redact(v);
  if (Array.isArray(v)) return v.map((x) => trim(x, key));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), trim(x, k)]));
  return v;
};
const out = [];
for (const line of readFileSync(src, 'utf8').split('\n')) {
  if (!line) continue;
  let rec = JSON.parse(line);
  if (kind === 'hooks') rec = { event: rec.event, payload: rec.payload };
  out.push(JSON.stringify(trim(rec)));
}
writeFileSync(dst, out.join('\n') + '\n');
