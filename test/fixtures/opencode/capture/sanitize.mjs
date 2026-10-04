// Redacts capture paths and trims long strings in captured probe logs and
// lookup dumps. P is the capture root (several may be joined with ':'); each
// root's work/ becomes /home/me/my-app and its home/ becomes /home/me.
// usage: P=<capture root[:root...]> node sanitize.mjs <src> <dst> <jsonl|json>
import { readFileSync, writeFileSync } from 'node:fs';
const [, , src, dst, kind] = process.argv;
// Longest first, so a root never matches inside a longer sibling (cap, cap1).
const roots = (process.env.P ?? '')
  .split(':')
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);
/** Replace capture-machine paths with neutral `/home/me/...` ones. */
const redact = (s) => {
  for (const root of roots) {
    s = s
      .split(`${root}/work`)
      .join('/home/me/my-app')
      .split(`${root}/home`)
      .join('/home/me')
      .split(root)
      .join('/home/me/capture');
  }
  return s;
};
/** Redact every string and trim long ones, except path-like fields. */
const PATHY = /path|directory|worktree|filePath|cwd|root|file$/i;
const trim = (v, key) => {
  if (typeof v === 'string')
    return v.length > 160 && !PATHY.test(key ?? '') ? '[trimmed]' : redact(v);
  if (Array.isArray(v)) return v.map((x) => trim(x, key));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), trim(x, k)]));
  return v;
};
const text = readFileSync(src, 'utf8');
if (kind === 'json') {
  writeFileSync(dst, JSON.stringify(trim(JSON.parse(text)), null, 2) + '\n');
} else {
  const out = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.stringify(trim(JSON.parse(line))));
  writeFileSync(dst, out.join('\n') + '\n');
}
