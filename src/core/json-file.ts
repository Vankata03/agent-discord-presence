/**
 * JSON files on disk: BOM-tolerant reads and atomic writes.
 *
 * Every persisted record (session markers, user config, daemon status, the
 * coding tool's settings) goes through here so the two recipes exist once:
 *   - reads strip a UTF-8 BOM (Windows editors add one) before parsing,
 *   - writes go to a pid-unique temp file then rename into place, so a
 *     concurrent reader never sees a half-written file and concurrent hook
 *     processes never collide on the temp name.
 *
 * Synchronous on purpose: the hook path must finish fast and exit.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Parse a JSON file. Returns null when it is missing or corrupt. */
export function readJson<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(stripBom(readFileSync(path, 'utf8'))) as T;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON file that is allowed to be absent but not broken: returns null
 * only for a missing file; any other read or parse error is thrown to the
 * caller.
 */
export function readJsonIfExists<T = unknown>(path: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(stripBom(raw)) as T;
}

export interface WriteJsonOptions {
  /** Indent with two spaces and end with a newline (human-edited files). */
  pretty?: boolean;
}

/** Write a JSON file atomically (temp file + rename), creating parent dirs. */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = options.pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}
