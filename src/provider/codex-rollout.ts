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
 * Reads are incremental (core/jsonl-tail.ts): each read parses only the bytes
 * appended since the last one, so a long session costs no more per tick than a
 * short one.
 */
import { JsonlTail } from '../core/jsonl-tail';
import type { SessionIdentity } from '../types';

export interface RolloutFacts {
  model?: string;
  tokens?: number;
}

interface RolloutState {
  /** Undefined until the first record is complete. */
  supported?: boolean;
  facts: RolloutFacts;
}

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

/** Fold one complete line into the state. */
function consume(state: RolloutState, line: string): void {
  if (line.trim() === '') return;
  let record: RolloutRecord;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not a record');
    record = parsed as RolloutRecord;
  } catch {
    if (state.supported === undefined) state.supported = false;
    return;
  }
  if (state.supported === undefined) {
    state.supported = isSessionMeta(record);
    return;
  }
  if (!state.supported) return;

  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return;
  if (record.type === 'turn_context') {
    if (typeof payload.model === 'string' && payload.model !== '')
      state.facts.model = payload.model;
  } else if (record.type === 'event_msg' && payload.type === 'token_count') {
    const output = payload.info?.total_token_usage?.output_tokens;
    if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
      state.facts.tokens = output;
    }
  }
}

const tail = new JsonlTail<RolloutState>(() => ({ facts: {} }), consume);

/** The model and output tokens recorded in a rollout, or none when unsupported. */
export function readCodexRollout(rolloutPath?: string, identity?: SessionIdentity): RolloutFacts {
  if (!rolloutPath) return {};
  const state = tail.read(rolloutPath, cacheKey(rolloutPath, identity));
  return state?.supported ? { ...state.facts } : {};
}
