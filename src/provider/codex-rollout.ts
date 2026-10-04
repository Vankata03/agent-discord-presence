/**
 * Codex rollout reader (daemon-side enrichment).
 *
 * A Codex session's rollout (`$CODEX_HOME/sessions/.../rollout-*.jsonl`, the
 * hook payload's `transcript_path`) records each turn's settings and the
 * session's running token usage. The hook payload already carries the model,
 * so the rollout is only a fallback for it; output tokens come only from here.
 *
 * Supported format, as written by Codex 0.160.0 (fixtures in
 * test/fixtures/codex/): one JSON record per line, `{ timestamp, type, payload }`,
 * starting with a `session_meta` record whose payload has `cli_version`.
 *   - `turn_context` payloads carry the turn's `model`; the latest wins.
 *   - `event_msg` payloads of type `token_count` carry
 *     `info.total_token_usage.output_tokens`, a cumulative snapshot for the
 *     session, so the latest snapshot is the total. Snapshots are never summed.
 * Every other record type is ignored, and so is a malformed line. A trailing
 * line without its newline is still being written, so it waits for the next
 * read. A rollout that does not start with a supported `session_meta` record
 * yields no facts at all; the public hooks keep working without them.
 *
 * Reads are incremental: each read parses only the bytes appended since the
 * last one, so a long session costs no more per tick than a short one.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { SessionIdentity } from '../types';

export interface RolloutFacts {
  model?: string;
  tokens?: number;
}

interface CacheEntry {
  path: string;
  /** Identifies the file itself, so a replacement at the same path is noticed. */
  ino: number;
  /** Bytes consumed so far: always the end of a complete line. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** Undefined until the first record is complete. */
  supported?: boolean;
  facts: RolloutFacts;
}

const MAX_CACHED_SESSIONS = 32;
const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

const cache = new Map<string, CacheEntry>();

/** Cache per session identity, so facts never carry across sessions. */
function cacheKey(path: string, identity?: SessionIdentity): string {
  return JSON.stringify(identity ? [identity.provider, identity.sessionId] : [path]);
}

interface RolloutRecord {
  type?: unknown;
  payload?: {
    type?: unknown;
    cli_version?: unknown;
    model?: unknown;
    info?: { total_token_usage?: { output_tokens?: unknown } } | null;
  };
}

/** Whether a rollout's first record is the supported `session_meta` header. */
function isSessionMeta(record: RolloutRecord): boolean {
  return record.type === 'session_meta' && typeof record.payload?.cli_version === 'string';
}

/** Fold one complete line into the entry. */
function consume(entry: CacheEntry, line: string): void {
  if (line.trim() === '') return;
  let record: RolloutRecord;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not a record');
    record = parsed as RolloutRecord;
  } catch {
    if (entry.supported === undefined) entry.supported = false;
    return;
  }
  if (entry.supported === undefined) {
    entry.supported = isSessionMeta(record);
    return;
  }
  if (!entry.supported) return;

  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return;
  if (record.type === 'turn_context') {
    if (typeof payload.model === 'string' && payload.model !== '')
      entry.facts.model = payload.model;
  } else if (record.type === 'event_msg' && payload.type === 'token_count') {
    const output = payload.info?.total_token_usage?.output_tokens;
    if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
      entry.facts.tokens = output;
    }
  }
}

/** Parse the complete lines appended since `entry.offset`. */
function readAppended(entry: CacheEntry, fd: number, size: number): void {
  let pending = Buffer.alloc(0);
  let position = entry.offset;
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
    const read = readSync(fd, chunk, 0, chunk.length, position);
    if (read <= 0) break;
    position += read;
    const data =
      pending.length > 0
        ? Buffer.concat([pending, chunk.subarray(0, read)])
        : chunk.subarray(0, read);
    const lastNewline = data.lastIndexOf(NEWLINE);
    if (lastNewline < 0) {
      pending = data;
      continue;
    }
    for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
      consume(entry, line);
    }
    entry.offset += lastNewline + 1;
    pending = data.subarray(lastNewline + 1);
  }
}

/** The model and output tokens recorded in a rollout, or none when unsupported. */
export function readCodexRollout(rolloutPath?: string, identity?: SessionIdentity): RolloutFacts {
  if (!rolloutPath) return {};
  let fd: number;
  try {
    fd = openSync(rolloutPath, 'r');
  } catch {
    return {};
  }
  try {
    const st = fstatSync(fd);
    const key = cacheKey(rolloutPath, identity);
    let entry = cache.get(key);
    // A different or replaced file, or one rewritten rather than appended to
    // (it shrank, or changed without growing), is read from the start.
    if (
      !entry ||
      entry.path !== rolloutPath ||
      entry.ino !== st.ino ||
      st.size < entry.offset ||
      (st.size === entry.size && st.mtimeMs !== entry.mtimeMs)
    ) {
      entry = { path: rolloutPath, ino: st.ino, offset: 0, size: 0, mtimeMs: 0, facts: {} };
    }
    if (entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
      readAppended(entry, fd, st.size);
      entry.size = st.size;
      entry.mtimeMs = st.mtimeMs;
    }
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value as string);
    return entry.supported ? { ...entry.facts } : {};
  } catch {
    return {};
  } finally {
    closeSync(fd);
  }
}
