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
 * The translation rules are the pure, exported `translate`; the hook runner
 * around it is a thin adapter (stdin → translate → store → ensure daemon).
 *
 * Hard rule: the hook path must NEVER throw or hang — it runs inside Claude
 * Code's hook execution. Everything is wrapped; errors are swallowed and we
 * still succeed.
 *
 * This module is the only Claude-Code-specific part of the system. Other tools
 * get their own provider that produces the same marker contract (see
 * `Translation`).
 *
 * Hook payload shapes are documented from a live session — see claupit's
 * hooks-findings.md (session_id, cwd, transcript_path, tool_name, tool_input…).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DaemonState, isProcessAlive, spawnDaemon } from '../core/daemon-state';
import { presenceDir } from '../core/paths';
import { SessionStore } from '../core/session-store';
import type { ActivityState, SessionIdentity, SessionMarkerPatch } from '../types';
import type { TranslateEnv, Translation } from './types';

export type { TranslateEnv, Translation } from './types';

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

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw: string): HookPayload | null {
  if (!raw) return null;
  try {
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(clean) as HookPayload;
  } catch {
    return null;
  }
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
 * What the hook runner learned from the environment when the payload is
 * silent: the session id Claude Code exports, and the process cwd.
 */
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

/**
 * Spawn the daemon detached unless a live one is already running. Best-effort,
 * never throws.
 *
 * The check is liveness-aware (not just "does the lock file exist"): a stale
 * lock left by a crashed daemon must NOT block a respawn. If the lock is stale
 * we still spawn — the daemon's own acquireLock takes the stale lock over
 * atomically, and if two hooks race here only one daemon wins the lock.
 */
function ensureDaemon(root: string): void {
  const lock = new DaemonState(root).readLock();
  if (lock && isProcessAlive(lock.pid)) return; // a live daemon already owns it
  spawnDaemon(); // no lock, or a stale one — the daemon's acquireLock settles races
}

export interface HookStore {
  record(
    identity: SessionIdentity,
    patch: SessionMarkerPatch,
    now: number,
    activityChanged: boolean,
  ): void;
  end(identity: SessionIdentity): void;
}

/** Runtime boundary for the short-lived Claude Code hook process. */
export interface HookRuntime {
  readInput: () => string;
  now: () => number;
  environment: () => TranslateEnv;
  root: () => string;
  createStore: (root: string) => HookStore;
  ensureDaemon: (root: string) => void;
}

const DEFAULT_HOOK_RUNTIME: HookRuntime = {
  readInput: readStdin,
  now: Date.now,
  environment: () => ({
    sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    cwd: process.cwd(),
  }),
  root: presenceDir,
  createStore: (root) => new SessionStore(root),
  ensureDaemon,
};

export async function runHook(
  args: string[] = [],
  runtime: HookRuntime = DEFAULT_HOOK_RUNTIME,
): Promise<void> {
  try {
    const event = args[0] ?? 'unknown';
    const now = runtime.now();
    const result = translate(event, parsePayload(runtime.readInput()), now, runtime.environment());
    if (!result) return;

    const root = runtime.root();
    const store = runtime.createStore(root);
    if (result.kind === 'end') {
      store.end(result.identity);
      return;
    }
    store.record(result.identity, result.patch, now, result.activityChanged);

    // Any non-end event means the session is active, so make sure a daemon is
    // up — this self-heals after idle, a mid-session install, or a daemon crash.
    // (session-end returned above, so we never resurrect a daemon for a dying one.)
    runtime.ensureDaemon(root);
  } catch {
    // A broken presence tool must never break Claude Code.
  }
}
