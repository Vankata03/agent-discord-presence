// Codex hook command for fixture capture: appends { event, at, payload } to a log.
// usage: node hook-logger.mjs <EventName> <log-file>
import { appendFileSync, readFileSync } from 'node:fs';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  // no stdin
}
appendFileSync(
  process.argv[3],
  JSON.stringify({
    event: process.argv[2],
    at: Date.now(),
    payload: raw ? JSON.parse(raw) : null,
  }) + '\n',
);
