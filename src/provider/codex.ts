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
 * those from inside a subagent (which adds `agent_id`), and subagents fire
 * `SubagentStart`/`SubagentStop` instead of their own session start and end,
 * so all of a session's work lands on one marker.
 *
 * This is the basic, stateless mapping: each event sets the activity it
 * implies. Overlapping tools and subagents, where one finishing must not hide
 * another still running, need the per-session activity ledger (#15).
 */
import { basename } from 'node:path';
import type { ActivityState, SessionMarkerPatch } from '../types';
import { defaultHookRuntime, parsePayload, runProviderHook, type HookRuntime } from './hook-runner';
import type { TranslateEnv, Translation } from './types';

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
}

interface Activity {
  state: ActivityState;
  activity: string;
  file?: string;
}

const THINKING: Activity = { state: 'thinking', activity: 'Thinking' };
const IDLE: Activity = { state: 'idle', activity: 'Idle' };

const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'write_stdin']);
const SEARCH_TOOLS = new Set(['read_file', 'Read', 'list_dir', 'LS', 'grep_files', 'Grep', 'Glob']);
const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'WebSearch', 'WebFetch']);
const AGENT_TOOLS = new Set(['spawn_agent', 'Agent', 'Task']);

/** A filename only from an explicit path field — never parsed out of patch or command text. */
function explicitFile(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  const path = fields.file_path ?? fields.path;
  return typeof path === 'string' && path !== '' ? basename(path) : undefined;
}

function toolActivity(payload: CodexHookPayload): Activity {
  const tool = payload.tool_name ?? '';
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
  if (AGENT_TOOLS.has(tool)) return { state: 'delegating', activity: 'Running a subagent' };
  // MCP (`mcp__server__tool`) and anything new stay valid through the fallback.
  return { state: 'running', activity: tool ? `Using ${tool}` : 'Working' };
}

/** The visible activity an event implies, or null when it only proves liveness. */
function activityFor(event: string, payload: CodexHookPayload): Activity | null {
  switch (event) {
    case 'session-start':
      return payload.source === 'compact'
        ? null
        : { state: 'idle', activity: 'Starting a session' };
    case 'user-prompt-submit':
    case 'post-tool-use':
    case 'subagent-stop':
      return THINKING;
    case 'pre-tool-use':
      return toolActivity(payload);
    case 'permission-request':
      return { state: 'waiting', activity: 'Waiting for permission' };
    case 'subagent-start':
      return { state: 'delegating', activity: 'Running a subagent' };
    case 'stop':
    case 'interrupt':
      return IDLE;
    default:
      // Compaction and unknown events keep the session alive without
      // replacing what it is visibly doing.
      return null;
  }
}

/**
 * Translate one Codex hook event into a marker update. Pure: `now` and the
 * environment are passed in, and a malformed (null) payload is treated as
 * empty so the fallbacks decide.
 */
export function translate(
  event: string,
  payload: CodexHookPayload | null,
  now: number,
  env: TranslateEnv,
): Translation {
  const p = payload ?? {};
  const id = typeof p.session_id === 'string' && p.session_id ? p.session_id : env.sessionId;
  if (!id) return null; // can't attribute activity without a session id

  const identity = { provider: 'codex', sessionId: id } as const;
  if (event === 'session-end') return { kind: 'end', identity };

  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : env.cwd;
  const patch: SessionMarkerPatch = { cwd, project: basename(cwd) };
  if (typeof p.model === 'string' && p.model) patch.model = p.model;
  if (typeof p.transcript_path === 'string' && p.transcript_path) {
    patch.enrichmentRef = p.transcript_path;
  }

  const activity = activityFor(event, p);
  if (activity) {
    patch.state = activity.state;
    patch.activity = activity.activity;
    patch.file = activity.file;
  }
  // startup, resume, clear and fork begin a session as far as the user is
  // concerned; a compaction is mid-session housekeeping and keeps the timer.
  if (event === 'session-start' && p.source !== 'compact') patch.startedAt = now;
  return { kind: 'update', identity, patch, activityChanged: activity !== null };
}

const DEFAULT_HOOK_RUNTIME = defaultHookRuntime(() => ({ cwd: process.cwd() }));

export async function runHook(
  args: string[] = [],
  runtime: HookRuntime = DEFAULT_HOOK_RUNTIME,
): Promise<void> {
  return runProviderHook(
    args,
    (event, raw, now, env) => translate(event, parsePayload<CodexHookPayload>(raw), now, env),
    runtime,
  );
}
