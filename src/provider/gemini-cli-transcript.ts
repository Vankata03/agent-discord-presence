/**
 * Gemini CLI transcript reader (daemon-side enrichment).
 *
 * A Gemini CLI session's chat recording (`~/.gemini/tmp/<project>/chats/
 * session-*.jsonl`, the hook payload's `transcript_path`) is the only source of
 * the model and output tokens: VDP installs no model hooks and never enables
 * Gemini telemetry.
 *
 * Supported format, as written by Gemini CLI 0.62.0 (fixtures in
 * test/fixtures/gemini-cli/): append-only JSONL whose first record is the
 * session metadata, `{ sessionId, projectHash, startTime, lastUpdated, kind }`.
 * Later records are one of:
 *   - a message, `{ id, timestamp, type, content, ... }`. Gemini re-appends a
 *     message under the same `id` whenever it changes (tokens arrive, tool
 *     calls are added), so a record replaces the earlier one with its id.
 *     `type: "gemini"` messages carry `model` and `tokens.output`;
 *   - a metadata update, `{ $set: { ... } }`. On resume, `$set.messages`
 *     restates the whole history, but without the `tokens` and `model` of the
 *     messages written before the resume;
 *   - a rewind, `{ $rewindTo: <id> }`, which drops messages from the history.
 *
 * Output tokens are summed over unique Gemini message ids, each counted once
 * with the latest `tokens.output` recorded for it. A record without tokens (a
 * restatement, or a message whose tokens have not arrived) never erases a count
 * already seen, and a rewind keeps them: those tokens were still spent. The
 * model is the latest one recorded on a Gemini message. Unknown records and
 * malformed lines are ignored. A file whose first record is not the supported
 * metadata record (such as an older single-JSON `.json` session) yields no
 * facts at all, and neither does a missing file: Gemini deletes some session
 * files on its own.
 */
import { JsonlTail } from '../core/jsonl-tail';
import type { SessionIdentity } from '../types';

export interface TranscriptFacts {
  model?: string;
  tokens?: number;
}

interface TranscriptState {
  /** Undefined until the first record is complete. */
  supported?: boolean;
  /** Latest recorded output tokens per Gemini message id. */
  outputs: Map<string, number>;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a transcript's first record is the supported session metadata. */
function isSessionMetadata(record: Record<string, unknown>): boolean {
  return typeof record.sessionId === 'string' && typeof record.projectHash === 'string';
}

/** Fold one message, appended or restated, into the state. */
function foldMessage(state: TranscriptState, message: unknown): void {
  if (!isRecord(message) || typeof message.id !== 'string' || message.type !== 'gemini') return;
  if (typeof message.model === 'string' && message.model !== '') state.model = message.model;
  const output = isRecord(message.tokens) ? message.tokens.output : undefined;
  if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
    state.outputs.set(message.id, output);
  }
}

/** Fold one complete line into the state. */
function consume(state: TranscriptState, line: string): void {
  if (line.trim() === '') return;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    if (state.supported === undefined) state.supported = false;
    return;
  }
  if (state.supported === undefined) {
    state.supported = isRecord(record) && isSessionMetadata(record);
    return;
  }
  if (!state.supported || !isRecord(record)) return;
  if (typeof record.id === 'string') {
    foldMessage(state, record);
  } else if (isRecord(record.$set) && Array.isArray(record.$set.messages)) {
    for (const message of record.$set.messages) foldMessage(state, message);
  }
}

const tail = new JsonlTail<TranscriptState>(() => ({ outputs: new Map() }), consume);

/** Cache per session identity, so facts never carry across sessions. */
function cacheKey(path: string, identity?: SessionIdentity): string {
  return JSON.stringify(identity ? [identity.provider, identity.sessionId] : [path]);
}

/** The model and output tokens recorded in a transcript, or none when unsupported. */
export function readGeminiTranscript(
  transcriptPath?: string,
  identity?: SessionIdentity,
): TranscriptFacts {
  if (!transcriptPath) return {};
  const state = tail.read(transcriptPath, cacheKey(transcriptPath, identity));
  if (!state?.supported) return {};
  const facts: TranscriptFacts = {};
  if (state.model !== undefined) facts.model = state.model;
  if (state.outputs.size > 0) {
    let tokens = 0;
    for (const output of state.outputs.values()) tokens += output;
    facts.tokens = tokens;
  }
  return facts;
}
