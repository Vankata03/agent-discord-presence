// Gemini CLI hook command for fixture capture: appends { event, at, payload } to
// a log, then prints the neutral `{}` VDP hooks print.
// usage: node hook-logger.mjs <EventName> <log-file> [sleep-ms]
import { appendFileSync, readFileSync } from 'node:fs';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  // no stdin
}
const at = Date.now();
const sleep = Number(process.argv[4] ?? 0);
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
appendFileSync(
  process.argv[3],
  JSON.stringify({
    event: process.argv[2],
    at,
    done: Date.now(),
    payload: raw ? JSON.parse(raw) : null,
  }) + '\n',
);
process.stdout.write('{}');
