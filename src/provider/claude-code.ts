/**
 * Claude Code provider.
 *
 * Hook entries call `vdp hook claude-code <event>`. Legacy `vdp hook <event>`
 * routes remain accepted by the dispatcher for one compatibility window. Each
 * call is a short-lived process that
 * reads the hook payload from stdin, translates it into a session-marker update
 * (refreshing the session's heartbeat) and exits. Any non-end event lazily
 * spawns the daemon if one isn't already running.
 *
 * The translation rules are the pure, exported `translate`; the shared hook
 * runner (hook-runner.ts) wraps it: stdin → translate → store → ensure daemon,
 * never throwing or hanging inside Claude Code's hook execution.
 *
 * This module is the only Claude-Code-specific part of the system. Other tools
 * get their own provider that produces the same marker contract (see
 * `Translation`).
 *
 * Hook payload shapes are documented from a live session — see claupit's
 * hooks-findings.md (session_id, cwd, transcript_path, tool_name, tool_input…).
 */
import { basename } from 'node:path';
import type { ActivityState, SessionMarkerPatch } from '../types';
import { defaultHookRuntime, parsePayload, runProviderHook, type HookRuntime } from './hook-runner';
import type { TranslateEnv, Translation } from './types';

export type { TranslateEnv, Translation } from './types';
export type { HookRuntime, HookStore } from './hook-runner';

/** What Claude Code writes to the hook's stdin. Every field is optional. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** SessionStart only: 'startup' | 'resume' | 'clear' | 'compact'. */
  source?: string;
  /** Notification only: the notification text (permission request vs idle wait). */
  message?: string;
}

interface Activity {
  state: ActivityState;
  activity: string;
  file?: string;
}

function fileFromInput(input: Record<string, unknown> | undefined): string | undefined {
  const fp = input?.file_path;
  return typeof fp === 'string' ? basename(fp) : undefined;
}

function toolActivity(payload: HookPayload): Activity {
  const tool = payload.tool_name ?? '';
  const file = fileFromInput(payload.tool_input);
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { state: 'editing', activity: file ? `Editing ${file}` : 'Editing', file };
    case 'Read':
      return { state: 'searching', activity: file ? `Reading ${file}` : 'Reading', file };
    case 'Bash':
      return { state: 'running', activity: 'Running a command' };
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { state: 'searching', activity: 'Searching the codebase' };
    case 'WebFetch':
    case 'WebSearch':
      return { state: 'browsing', activity: 'Browsing the web' };
    case 'Task':
    case 'Agent':
      return { state: 'delegating', activity: 'Running a subagent' };
    default:
      return { state: 'running', activity: tool ? `Using ${tool}` : 'Working' };
  }
}

function activityFor(event: string, payload: HookPayload): Activity {
  switch (event) {
    case 'session-start':
      return { state: 'idle', activity: 'Starting a session' };
    case 'user-prompt-submit':
      return { state: 'thinking', activity: 'Thinking' };
    case 'pre-tool-use':
      return toolActivity(payload);
    case 'notification':
      // Notification fires both for permission prompts and the 60s idle wait;
      // only the former is really "waiting for permission".
      return payload.message?.toLowerCase().includes('permission')
        ? { state: 'waiting', activity: 'Waiting for permission' }
        : { state: 'idle', activity: 'Idle' };
    case 'stop':
      return { state: 'idle', activity: 'Idle' };
    default:
      return { state: 'idle', activity: 'Working' };
  }
}

/**
 * Translate one Claude Code hook event into a marker update. Pure: `now` and
 * the environment are passed in, and a malformed (null) payload is treated as
 * empty so the fallbacks decide.
 */
export function translate(
  event: string,
  payload: HookPayload | null,
  now: number,
  env: TranslateEnv,
): Translation {
  const p = payload ?? {};
  const id = p.session_id ?? env.sessionId;
  if (!id) return null; // can't attribute activity without a session id

  const identity = { provider: 'claude-code', sessionId: id } as const;
  if (event === 'session-end') return { kind: 'end', identity };

  const cwd = p.cwd ?? env.cwd;
  const isCompaction = event === 'session-start' && p.source === 'compact';
  const patch: SessionMarkerPatch = {
    cwd,
    project: basename(cwd),
    enrichmentRef: p.transcript_path,
  };
  if (!isCompaction) {
    const activity = activityFor(event, p);
    patch.state = activity.state;
    patch.activity = activity.activity;
    patch.file = activity.file;
  }
  // A genuine (re)start resets the elapsed timer so it counts from when you
  // opened Claude Code — but an auto-compaction is mid-session housekeeping
  // and must keep the original start time.
  if (event === 'session-start' && p.source !== 'compact') {
    patch.startedAt = now;
  }
  return { kind: 'update', identity, patch, activityChanged: !isCompaction };
}

const DEFAULT_HOOK_RUNTIME = defaultHookRuntime(() => ({
  sessionId: process.env.CLAUDE_CODE_SESSION_ID,
  cwd: process.cwd(),
}));

export async function runHook(
  args: string[] = [],
  runtime: HookRuntime = DEFAULT_HOOK_RUNTIME,
): Promise<void> {
  return runProviderHook(
    args,
    (event, raw, now, env) => translate(event, parsePayload<HookPayload>(raw), now, env),
    runtime,
  );
}
