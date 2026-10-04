/**
 * Codex provider.
 *
 * User-level hooks in `$CODEX_HOME/hooks.json` call `vdp hook codex <event>`
 * with Codex's JSON payload on stdin (`session_id`, `cwd`, `model`,
 * `transcript_path`, and event-specific fields such as `source`, `tool_name`
 * and `tool_input`). The shared hook runner (hook-runner.ts) applies the pure
 * `translate` result: hooks never print, never fail, and only `SessionEnd`
 * skips starting the daemon.
 *
 * Codex reports the root session's `session_id` on every event, including
 * those from inside a subagent, which add `agent_id` (and carry the
 * subagent's own `turn_id`, `model` and rollout `transcript_path`).
 * Subagents fire `SubagentStart`/`SubagentStop` instead of their own session
 * start and end, so all of a session's work lands on one marker, and only
 * root events set the session's working directory, model and rollout.
 *
 * Overlapping tools, subagents and permission waits are tracked in the
 * session's ledger (codex-ledger.ts), which the hook updates under the
 * session lock (runLedgerHook), so one operation finishing never hides
 * another that is still running.
 */
import { basename } from 'node:path';
import type { SessionIdentity, SessionMarkerPatch } from '../types';
import {
  applyEvent,
  parseLedger,
  visibleActivity,
  type Activity,
  type LedgerEvent,
} from './codex-ledger';
import {
  defaultHookRuntime,
  parsePayload,
  runLedgerHook,
  type HookRuntime,
  type LedgerHookStore,
  type LedgerStep,
} from './hook-runner';
import type { TranslateEnv } from './types';

/** Codex event name and the normalized event argument passed to VDP. */
export const CODEX_HOOK_EVENTS: ReadonlyArray<{ name: string; arg: string }> = [
  { name: 'SessionStart', arg: 'session-start' },
  { name: 'UserPromptSubmit', arg: 'user-prompt-submit' },
  { name: 'PreToolUse', arg: 'pre-tool-use' },
  { name: 'PostToolUse', arg: 'post-tool-use' },
  { name: 'PermissionRequest', arg: 'permission-request' },
  { name: 'SubagentStart', arg: 'subagent-start' },
  { name: 'SubagentStop', arg: 'subagent-stop' },
  { name: 'PreCompact', arg: 'pre-compact' },
  { name: 'PostCompact', arg: 'post-compact' },
  { name: 'Stop', arg: 'stop' },
  { name: 'Interrupt', arg: 'interrupt' },
  { name: 'SessionEnd', arg: 'session-end' },
];

/** What Codex writes to the hook's stdin. Every field is treated as optional. */
export interface CodexHookPayload {
  session_id?: string;
  cwd?: string;
  model?: string;
  transcript_path?: string | null;
  hook_event_name?: string;
  /** SessionStart only: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'. */
  source?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** Pre/PostToolUse: pairs a tool's start with its completion. */
  tool_use_id?: string;
  /** Present on events from inside a subagent, and on SubagentStart/Stop. */
  agent_id?: string;
}

const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'write_stdin']);
const SEARCH_TOOLS = new Set(['read_file', 'Read', 'list_dir', 'LS', 'grep_files', 'Grep', 'Glob']);
const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'WebSearch', 'WebFetch']);
const AGENT_TOOLS = new Set(['spawn_agent', 'Agent', 'Task']);
/** Codex prefixes namespaced tools with the namespace, e.g. `collaborationspawn_agent`. */
const AGENT_NAMESPACE = 'collaboration';

/** The value when it is a non-empty string; payload fields are untrusted. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A filename only from an explicit path field — never parsed out of patch or command text. */
function explicitFile(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  const path = fields.file_path ?? fields.path;
  return typeof path === 'string' && path !== '' ? basename(path) : undefined;
}

/** What a tool call is visibly doing, by tool family, with an open-ended fallback. */
function toolActivity(payload: CodexHookPayload): Activity {
  const tool = nonEmpty(payload.tool_name) ?? '';
  if (EDIT_TOOLS.has(tool)) {
    const file = explicitFile(payload.tool_input);
    return { state: 'editing', activity: file ? `Editing ${file}` : 'Editing', file };
  }
  if (COMMAND_TOOLS.has(tool)) return { state: 'running', activity: 'Running a command' };
  if (SEARCH_TOOLS.has(tool)) {
    const file =
      tool === 'read_file' || tool === 'Read' ? explicitFile(payload.tool_input) : undefined;
    return file
      ? { state: 'searching', activity: `Reading ${file}`, file }
      : { state: 'searching', activity: 'Searching the codebase' };
  }
  if (WEB_TOOLS.has(tool) || tool.startsWith('browser')) {
    return { state: 'browsing', activity: 'Browsing the web' };
  }
  if (AGENT_TOOLS.has(tool) || tool === `${AGENT_NAMESPACE}spawn_agent`) {
    return { state: 'delegating', activity: 'Running a subagent' };
  }
  if (tool.startsWith(AGENT_NAMESPACE)) {
    return { state: 'delegating', activity: 'Coordinating subagents' };
  }
  if (tool === 'request_user_input') {
    return { state: 'waiting', activity: 'Waiting for your answer' };
  }
  if (tool === 'view_image') return { state: 'searching', activity: 'Viewing an image' };
  // MCP (`mcp__server__tool`) and anything new stay valid through the fallback.
  return { state: 'running', activity: tool ? `Using ${tool}` : 'Working' };
}

/** The ledger event a hook event implies, or null when it only proves liveness. */
function ledgerEvent(event: string, payload: CodexHookPayload): LedgerEvent | null {
  const agent = nonEmpty(payload.agent_id);
  const tool = {
    agent,
    toolUseId: nonEmpty(payload.tool_use_id),
    toolName: nonEmpty(payload.tool_name),
  };
  switch (event) {
    case 'session-start':
      return payload.source === 'compact' ? null : { kind: 'session-start' };
    case 'user-prompt-submit':
      return { kind: 'prompt', agent };
    case 'pre-tool-use':
      return { kind: 'pre-tool', ...tool, activity: toolActivity(payload) };
    case 'post-tool-use':
      return { kind: 'post-tool', ...tool };
    case 'permission-request':
      return { kind: 'permission', ...tool };
    case 'subagent-start':
      return { kind: 'subagent-start', agent };
    case 'subagent-stop':
      return { kind: 'subagent-stop', agent };
    case 'stop':
    case 'interrupt':
      return { kind: 'turn-end', agent };
    default:
      // Compaction and unknown events keep the session alive without
      // replacing what it is visibly doing.
      return null;
  }
}

/** The session an event belongs to, or null when it can't be attributed. */
export function codexIdentity(
  payload: CodexHookPayload | null,
  env: TranslateEnv,
): SessionIdentity | null {
  const id = nonEmpty(payload?.session_id) ?? env.sessionId;
  return id ? { provider: 'codex', sessionId: id } : null;
}

/**
 * Translate one Codex hook event against the session's previous ledger.
 * Pure: `now`, the environment and the ledger are passed in, and a malformed
 * (null) payload is treated as empty so the fallbacks decide.
 */
export function translate(
  event: string,
  payload: CodexHookPayload | null,
  now: number,
  env: TranslateEnv,
  previous: unknown = null,
): LedgerStep {
  const p = payload ?? {};
  const identity = codexIdentity(p, env);
  if (!identity) return { translation: null, ledger: previous }; // can't attribute it
  if (event === 'session-end') return { translation: { kind: 'end', identity }, ledger: null };

  const fromSubagent = nonEmpty(p.agent_id) !== undefined;
  // A subagent can still be finishing a hook after the root's SessionEnd
  // removed the session; that late event must not bring the session back.
  if (fromSubagent && (previous === null || previous === undefined)) {
    return { translation: null, ledger: null };
  }

  const patch: SessionMarkerPatch = {};
  // A subagent's events carry its own model and rollout; the card shows the root's.
  if (!fromSubagent) {
    const cwd = nonEmpty(p.cwd) ?? env.cwd;
    patch.cwd = cwd;
    patch.project = basename(cwd);
    const model = nonEmpty(p.model);
    if (model) patch.model = model;
    const rollout = nonEmpty(p.transcript_path);
    if (rollout) patch.enrichmentRef = rollout;
  }

  let ledger = parseLedger(previous);
  const change = ledgerEvent(event, p);
  if (change) {
    ledger = applyEvent(ledger, change, now);
    const activity: Activity = visibleActivity(ledger);
    patch.state = activity.state;
    patch.activity = activity.activity;
    patch.file = activity.file;
  }
  // startup, resume, clear and fork begin a session as far as the user is
  // concerned; a compaction is mid-session housekeeping and keeps the timer.
  if (change?.kind === 'session-start') patch.startedAt = now;
  return {
    translation: { kind: 'update', identity, patch, activityChanged: change !== null },
    ledger,
  };
}

const DEFAULT_HOOK_RUNTIME = defaultHookRuntime(() => ({ cwd: process.cwd() }));

/** Hook entry for `vdp hook codex <event>`: never throws, never prints. */
export async function runHook(
  args: string[] = [],
  runtime: HookRuntime<LedgerHookStore> = DEFAULT_HOOK_RUNTIME,
): Promise<void> {
  return runLedgerHook(
    args,
    (event, raw, now, env) => {
      const payload = parsePayload<CodexHookPayload>(raw);
      const identity = codexIdentity(payload, env);
      if (!identity) return null;
      return { identity, step: (ledger) => translate(event, payload, now, env, ledger) };
    },
    runtime,
  );
}
