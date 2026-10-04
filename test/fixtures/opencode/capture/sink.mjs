// Child process the probe plugin starts for queued events, standing in for
// `vdp hook opencode`. Reads one snapshot per stdin line (several in batch
// mode) and appends { ref, line, type, bytes, received } per line to
// VDP_PROBE_SINK_LOG.
// Failure injection, by event type (comma-separated lists):
//   VDP_PROBE_FAIL_TYPES   exit 1 after recording
//   VDP_PROBE_HANG_TYPES   never exit (the plugin's child timeout kills it)
// VDP_PROBE_SINK_DELAY_MS delays every child, to build a backlog.
// usage: node sink.mjs <ref>
import { appendFileSync, readFileSync } from 'node:fs';

const env = process.env;
const list = (name) => (env[name] ?? '').split(',').filter(Boolean);
let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  // no stdin
}
const types = raw
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line).type ?? null;
    } catch {
      return 'unparsable';
    }
  });
const delay = Number(env.VDP_PROBE_SINK_DELAY_MS ?? 0);
if (delay > 0) await new Promise((r) => setTimeout(r, delay));
const received = Date.now();
appendFileSync(
  env.VDP_PROBE_SINK_LOG,
  types
    .map((type, line) =>
      JSON.stringify({ ref: Number(process.argv[2]), line, type, bytes: raw.length, received }),
    )
    .join('\n') + '\n',
);
if (types.some((t) => list('VDP_PROBE_HANG_TYPES').includes(t))) setInterval(() => {}, 1000);
else if (types.some((t) => list('VDP_PROBE_FAIL_TYPES').includes(t))) process.exit(1);
