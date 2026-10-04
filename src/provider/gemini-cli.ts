/**
 * Gemini CLI provider.
 *
 * User-level command hooks in Gemini's `settings.json` call
 * `vdp hook gemini-cli <event>` with Gemini's JSON payload on stdin. Every
 * payload carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`
 * and `timestamp`, plus event fields such as `source`, `tool_name`,
 * `tool_input` and `notification_type` (verified against Gemini CLI 0.62.0,
 * test/fixtures/gemini-cli/README.md).
 *
 * Gemini parses a hook's stdout, or its stderr when stdout is empty, so every
 * hook prints the neutral `{}`, writes nothing to stderr and exits 0, whatever
 * happens inside: exit 1 would show the user a warning and exit 2 would deny
 * the tool. Only `SessionEnd` skips starting the daemon, and it is idempotent
 * (`/quit` delivers it three times; a killed Gemini never delivers it, and the
 * session then goes stale by heartbeat).
 *
 * `/clear` ends the session and starts one with a new `session_id`; resume
 * keeps the id. No payload carries the model, so the model and output tokens
 * come from the transcript the payload names (gemini-cli-transcript.ts). Every
 * event updates that reference, because a later-minute resume's SessionStart
 * names a short-lived file that every later event corrects.
 *
 * Overlapping tools and permission waits are counted in the session's ledger
 * (gemini-cli-ledger.ts), updated under the session lock (runLedgerHook).
 */
import { basename } from 'node:path';
import type { SessionIdentity, SessionMarkerPatch } from '../types';
import {
  applyEvent,
  parseLedger,
  visibleActivity,
  type Activity,
  type LedgerEvent,
  type ToolCall,
} from './gemini-cli-ledger';
import {
  defaultHookRuntime,
  parsePayload,
  runLedgerHook,
  type HookRuntime,
  type LedgerHookStore,
  type LedgerStep,
} from './hook-runner';
import type { TranslateEnv } from './types';

/**
 * Gemini event name and the normalized event argument passed to VDP. Model,
 * tool-selection and compression hooks are left out: they fire around every
 * model request and say nothing visible.
 */
export const GEMINI_CLI_HOOK_EVENTS: ReadonlyArray<{ name: string; arg: string }> = [
  { name: 'SessionStart', arg: 'session-start' },
  { name: 'BeforeAgent', arg: 'before-agent' },
  { name: 'BeforeTool', arg: 'before-tool' },
  { name: 'AfterTool', arg: 'after-tool' },
  { name: 'Notification', arg: 'notification' },
  { name: 'AfterAgent', arg: 'after-agent' },
  { name: 'SessionEnd', arg: 'session-end' },
];

/** The neutral hook response: Gemini continues exactly as without the hook. */
export const NEUTRAL_OUTPUT = '{}';

/** What Gemini CLI writes to the hook's stdin. Every field is treated as optional. */
export interface GeminiHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  timestamp?: string;
  /** SessionStart: 'startup' | 'resume' | 'clear'. */
  source?: string;
  /** SessionEnd: 'exit' | 'clear' | … */
  reason?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** Notification: 'ToolPermission' for an approval prompt. */
  notification_type?: string;
  message?: string;
  /** ToolPermission: the confirmation, e.g. `{ type: 'exec' | 'edit' | 'mcp' | 'info', … }`. */
  details?: unknown;
}

/** The SessionStart sources that begin a session for the user. */
const SESSION_STARTS = new Set(['startup', 'resume', 'clear']);

const EDIT_TOOLS = new Set(['replace', 'write_file']);
const COMMAND_TOOLS = new Set(['run_shell_command']);
const READ_TOOLS = new Set(['read_file']);
const SEARCH_TOOLS = new Set([
  'read_many_files',
  'list_directory',
  'glob',
  'grep_search',
  // The pre-rename name of grep_search, still accepted by Gemini.
  'search_file_content',
  'get_internal_docs',
  'read_mcp_resource',
  'list_mcp_resources',
]);
const WEB_TOOLS = new Set(['web_fetch', 'google_web_search']);
const AGENT_TOOLS = new Set(['invoke_agent']);
const PLAN_TOOLS = new Set(['write_todos', 'enter_plan_mode', 'exit_plan_mode', 'update_topic']);
const TRACKER_PREFIX = 'tracker_';

/** Permission detail types whose family the tool name alone decides. */
const PERMISSION_FAMILIES: Readonly<Record<string, string>> = { exec: 'command', edit: 'edit' };

const EDITING: Activity = { state: 'editing', activity: 'Editing' };
const RUNNING: Activity = { state: 'running', activity: 'Running a command' };
const SEARCHING: Activity = { state: 'searching', activity: 'Searching the codebase' };
const BROWSING: Activity = { state: 'browsing', activity: 'Browsing the web' };
const DELEGATING: Activity = { state: 'delegating', activity: 'Running a subagent' };
const PLANNING: Activity = { state: 'thinking', activity: 'Planning' };
const ASKING: Activity = { state: 'waiting', activity: 'Waiting for your answer' };

/** The value when it is a non-empty string; payload fields are untrusted. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A filename only from an explicit path field, never parsed out of other text. */
function explicitFile(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const path = nonEmpty((input as Record<string, unknown>).file_path);
  return path ? basename(path) : undefined;
}

/** A tool call's family and what it is visibly doing, with an open-ended fallback. */
export function toolCall(toolName: unknown, input: unknown): ToolCall {
  const tool = nonEmpty(toolName) ?? '';
  const family = (name: string, activity: Activity, generic = activity): ToolCall => ({
    family: name,
    activity,
    generic,
  });
  if (EDIT_TOOLS.has(tool)) {
    const file = explicitFile(input);
    return family(
      'edit',
      file ? { ...EDITING, activity: `Editing ${file}`, file } : EDITING,
      EDITING,
    );
  }
  if (COMMAND_TOOLS.has(tool)) return family('command', RUNNING);
  if (READ_TOOLS.has(tool)) {
    const file = explicitFile(input);
    return family(
      'search',
      file ? { ...SEARCHING, activity: `Reading ${file}`, file } : SEARCHING,
      SEARCHING,
    );
  }
  if (SEARCH_TOOLS.has(tool)) return family('search', SEARCHING);
  if (WEB_TOOLS.has(tool)) return family('web', BROWSING);
  if (AGENT_TOOLS.has(tool)) return family('agent', DELEGATING);
  if (PLAN_TOOLS.has(tool) || tool.startsWith(TRACKER_PREFIX)) return family('plan', PLANNING);
  if (tool === 'ask_user') return family('ask', ASKING);
  // MCP tools (`mcp_<server>_<tool>`), subagents and anything new each count
  // as their own family, shown by name.
  return family(`tool:${tool}`, { state: 'running', activity: tool ? `Using ${tool}` : 'Working' });
}

/** The family a permission prompt was raised for, when its details say. */
function permissionFamily(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const type = (details as { type?: unknown }).type;
  return typeof type === 'string' ? PERMISSION_FAMILIES[type] : undefined;
}

/** The ledger event a hook event implies, or null when it only proves liveness. */
function ledgerEvent(event: string, payload: GeminiHookPayload): LedgerEvent | null {
  switch (event) {
    case 'session-start':
      return payload.source === undefined || SESSION_STARTS.has(payload.source)
        ? { kind: 'session-start' }
        : null;
    case 'before-agent':
      return { kind: 'prompt' };
    case 'after-agent':
      return { kind: 'turn-end' };
    case 'before-tool':
      return { kind: 'before-tool', ...toolCall(payload.tool_name, payload.tool_input) };
    case 'after-tool':
      return { kind: 'after-tool', ...toolCall(payload.tool_name, payload.tool_input) };
    case 'notification':
      // Other notifications prove liveness without replacing what is visible.
      return payload.notification_type === 'ToolPermission'
        ? { kind: 'permission', family: permissionFamily(payload.details) }
        : null;
    default:
      return null;
  }
}

/** The session an event belongs to, or null when it can't be attributed. */
export function geminiIdentity(
  payload: GeminiHookPayload | null,
  env: TranslateEnv,
): SessionIdentity | null {
  const id = nonEmpty(payload?.session_id) ?? env.sessionId;
  return id ? { provider: 'gemini-cli', sessionId: id } : null;
}

/**
 * Translate one Gemini CLI hook event against the session's previous ledger.
 * Pure: `now`, the environment and the ledger are passed in, and a malformed
 * (null) payload is treated as empty so the fallbacks decide.
 */
export function translate(
  event: string,
  payload: GeminiHookPayload | null,
  now: number,
  env: TranslateEnv,
  previous: unknown = null,
): LedgerStep {
  const p = payload ?? {};
  const identity = geminiIdentity(p, env);
  if (!identity) return { translation: null, ledger: previous }; // can't attribute it
  if (event === 'session-end') return { translation: { kind: 'end', identity }, ledger: null };

  const cwd = nonEmpty(p.cwd) ?? env.cwd;
  const patch: SessionMarkerPatch = { cwd, project: basename(cwd) };
  const transcript = nonEmpty(p.transcript_path);
  if (transcript) patch.enrichmentRef = transcript;

  let ledger = parseLedger(previous);
  const change = ledgerEvent(event, p);
  if (change) {
    ledger = applyEvent(ledger, change);
    const activity = visibleActivity(ledger);
    patch.state = activity.state;
    patch.activity = activity.activity;
    patch.file = activity.file;
  }
  if (change?.kind === 'session-start') patch.startedAt = now;
  return {
    translation: { kind: 'update', identity, patch, activityChanged: change !== null },
    ledger,
  };
}

/** The hook process boundary, plus where the neutral response goes. */
export interface GeminiHookRuntime extends HookRuntime<LedgerHookStore> {
  writeOutput: (text: string) => void;
}

const DEFAULT_HOOK_RUNTIME: GeminiHookRuntime = {
  ...defaultHookRuntime(() => ({
    sessionId: process.env.GEMINI_SESSION_ID,
    cwd: process.cwd(),
  })),
  writeOutput: (text) => {
    process.stdout.write(text);
  },
};

/** Hook entry for `vdp hook gemini-cli <event>`: never throws, always prints `{}`. */
export async function runHook(
  args: string[] = [],
  runtime: GeminiHookRuntime = DEFAULT_HOOK_RUNTIME,
): Promise<void> {
  try {
    await runLedgerHook(
      args,
      (event, raw, now, env) => {
        const payload = parsePayload<GeminiHookPayload>(raw);
        const identity = geminiIdentity(payload, env);
        if (!identity) return null;
        return { identity, step: (ledger) => translate(event, payload, now, env, ledger) };
      },
      runtime,
    );
  } finally {
    try {
      runtime.writeOutput(NEUTRAL_OUTPUT);
    } catch {
      // Nothing left to tell Gemini; it treats an empty response as neutral too.
    }
  }
}
