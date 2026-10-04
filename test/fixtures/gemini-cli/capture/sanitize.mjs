// Redacts capture paths and trims long prompt/context text from captured JSONL.
// usage: P=<capture dir> node sanitize.mjs <src> <dst> <hooks|transcript>
import { readFileSync, writeFileSync } from 'node:fs';
const [, , src, dst, kind] = process.argv;
const P = process.env.P;
/** Replace capture-machine paths with neutral `/home/me/...` ones. */
const redact = (s) =>
  s
    .split(`${P}/home/.gemini`)
    .join('/home/me/.gemini')
    .split(`${P}/work`)
    .join('/home/me/my-app')
    .split(P)
    .join('/home/me');
/** Redact every string and trim long ones, except `*_path` fields. */
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
