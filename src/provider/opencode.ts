/**
 * OpenCode provider.
 *
 * OpenCode has no command hooks; it loads plugins. VDP installs one global
 * plugin (opencode-plugin.ts) that snapshots the few fields presence needs
 * from each bus event, resolves the session to its root, and hands batches of
 * snapshots to `vdp hook opencode` on stdin, one JSON object per line, in bus
 * order. This module is that hook process: each line is translated against
 * the root session's ledger (opencode-ledger.ts) under the root's session lock
 * (runLedgerBatch), so a child session's work always lands on its root's one
 * marker.
 *
 * A snapshot line is `{ v: 1, type, root, session, cwd, ... }`, where `type`
 * is the OpenCode event type, or `vdp.end` when the plugin is disposed and
 * every root it reported ends (a reload or exit ends a root with no event of
 * its own). The plugin, not this process, owns root resolution: a line always
 * names its root, and activity it could not attribute never arrives.
 *
 * A root with no ledger is only started by events that show work (a root's
 * `session.created`, a busy or retrying status, a running tool, a permission
 * request); housekeeping and end events for an untracked root are dropped, so
 * a late event during shutdown never revives a session that has ended.
 *
 * Model, output tokens and cost come from the events themselves
 * (`message.updated`, `session.updated`); OpenCode's storage is never read.
 */
import { basename } from 'node:path';
import type { SessionIdentity, SessionMarkerPatch } from '../types';
import {
  applyEvent,
  changesActivity,
  emptyLedger,
  opensSession,
  parseLedger,
  usage,
  visibleActivity,
  type Activity,
  type LedgerEvent,
} from './opencode-ledger';
import {
  defaultHookRuntime,
  runLedgerBatch,
  type HookRuntime,
  type LedgerHookStore,
  type LedgerStep,
  type PendingLedgerStep,
} from './hook-runner';
import type { TranslateEnv } from './types';

/** The `type` of the line the plugin sends for each root when it is disposed. */
export const END_TYPE = 'vdp.end';

/** One plugin snapshot. Every field but the version and root is optional. */
export interface OpenCodeSnapshot {
  v: 1;
  type: string;
  /** The root session the plugin attributed this event to. */
  root: string;
  /** The session the event is about: the root or one of its children. */
  session?: string;
  /** The plugin instance's project directory. */
  cwd?: string;
  /** session.*: the session's parent, when it is a child. */
  parent?: string;
  /** session.status: `busy`, `idle` or `retry`. */
  status?: string;
  /** message.updated: the message id and role. */
  message?: string;
  role?: string;
  /** message.updated (modelID) or session.updated (model.id). */
  model?: string;
  /** message.updated or session.updated usage. */
  output?: number;
  cost?: number;
  /** message.part.updated (tool parts only). */
  call?: string;
  tool?: string;
  /** The tool part's status: `pending`, `running`, `completed` or `error`. */
  state?: string;
  /** The tool's explicit `filePath` argument, when it has one. */
  file?: string;
  /** permission.asked / permission.updated id, or permission.replied requestID / permissionID. */
  request?: string;
}

const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit']);
const COMMAND_TOOLS = new Set(['bash']);
const READ_TOOLS = new Set(['read']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'list', 'codesearch', 'lsp']);
const WEB_TOOLS = new Set(['webfetch', 'websearch']);
const AGENT_TOOLS = new Set(['task']);
const PLAN_TOOLS = new Set(['todowrite', 'todoread', 'plan_enter', 'plan_exit']);
const ASK_TOOLS = new Set(['question']);

const EDITING: Activity = { state: 'editing', activity: 'Editing' };
const RUNNING: Activity = { state: 'running', activity: 'Running a command' };
const SEARCHING: Activity = { state: 'searching', activity: 'Searching the codebase' };
const BROWSING: Activity = { state: 'browsing', activity: 'Browsing the web' };
const DELEGATING: Activity = { state: 'delegating', activity: 'Running a subagent' };
const PLANNING: Activity = { state: 'thinking', activity: 'Planning' };
const ASKING: Activity = { state: 'waiting', activity: 'Waiting for your answer' };

/** The value when it is a non-empty string; snapshot fields are untrusted. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The value when it is a finite, non-negative number. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * What a tool call is visibly doing. The filename comes only from the tool's
 * explicit `filePath` argument, never from a command or patch text. MCP tools
 * (`<server>_<tool>`) and anything new are shown by name.
 */
export function toolActivity(toolName: unknown, filePath?: unknown): Activity {
  const tool = nonEmpty(toolName) ?? '';
  const path = nonEmpty(filePath);
  const file = path ? basename(path) : undefined;
  if (EDIT_TOOLS.has(tool))
    return file ? { ...EDITING, activity: `Editing ${file}`, file } : EDITING;
  if (COMMAND_TOOLS.has(tool)) return RUNNING;
  if (READ_TOOLS.has(tool)) {
    return file ? { ...SEARCHING, activity: `Reading ${file}`, file } : SEARCHING;
  }
  if (SEARCH_TOOLS.has(tool)) return SEARCHING;
  if (WEB_TOOLS.has(tool)) return BROWSING;
  if (AGENT_TOOLS.has(tool)) return DELEGATING;
  if (PLAN_TOOLS.has(tool)) return PLANNING;
  if (ASK_TOOLS.has(tool)) return ASKING;
  return { state: 'running', activity: tool ? `Using ${tool}` : 'Working' };
}

const TOOL_STATES = new Set(['pending', 'running', 'completed', 'error']);

/** The ledger event a snapshot implies, or null when presence ignores it. */
export function ledgerEvent(s: OpenCodeSnapshot): LedgerEvent | null {
  const session = nonEmpty(s.session);
  if (!session) return null;
  switch (s.type) {
    case 'session.created':
      return { kind: 'session-created', session };
    case 'session.updated':
      return {
        kind: 'session-usage',
        session,
        output: count(s.output),
        cost: count(s.cost),
        model: nonEmpty(s.model),
      };
    case 'session.status':
      if (s.status === 'busy' || s.status === 'retry') {
        return { kind: 'status', session, status: s.status };
      }
      return s.status === 'idle' ? { kind: 'idle', session } : null;
    case 'session.idle':
      return { kind: 'idle', session };
    case 'session.error':
      return { kind: 'error', session };
    case 'session.deleted':
      return { kind: 'deleted', session };
    case 'message.updated': {
      const message = nonEmpty(s.message);
      if (!message) return null;
      return {
        kind: 'message',
        session,
        message,
        role: nonEmpty(s.role),
        model: nonEmpty(s.model),
        output: count(s.output),
        cost: count(s.cost),
      };
    }
    case 'message.part.updated': {
      const call = nonEmpty(s.call);
      if (!call || !TOOL_STATES.has(s.state as string)) return null;
      return {
        kind: 'tool',
        session,
        call,
        state: s.state as 'pending' | 'running' | 'completed' | 'error',
        activity: toolActivity(s.tool, s.file),
      };
    }
    // `permission.updated` until OpenCode 1.0.223, `permission.asked` since.
    case 'permission.asked':
    case 'permission.updated':
      return { kind: 'permission-asked', session, request: nonEmpty(s.request) };
    case 'permission.replied':
      return { kind: 'permission-replied', session, request: nonEmpty(s.request) };
    default:
      return null;
  }
}

/** The root session a snapshot belongs to, or null when it names none. */
export function openCodeIdentity(snapshot: OpenCodeSnapshot): SessionIdentity | null {
  const root = nonEmpty(snapshot.root);
  return root ? { provider: 'opencode', sessionId: root } : null;
}

/**
 * Translate one snapshot against its root's previous ledger. Pure: `now`, the
 * environment and the ledger are passed in.
 */
export function translate(
  snapshot: OpenCodeSnapshot,
  now: number,
  env: TranslateEnv,
  previous: unknown = null,
): LedgerStep {
  const identity = openCodeIdentity(snapshot);
  if (!identity) return { translation: null, ledger: previous };
  const root = identity.sessionId;
  if (
    snapshot.type === END_TYPE ||
    (snapshot.type === 'session.deleted' && snapshot.session === root)
  ) {
    return { translation: { kind: 'end', identity }, ledger: null };
  }

  const event = ledgerEvent(snapshot);
  if (!event) return { translation: null, ledger: previous };
  const prior = parseLedger(previous, root);
  // An untracked root starts only with visible work, never with housekeeping.
  if (!prior && !opensSession(event, root)) return { translation: null, ledger: previous };

  const ledger = applyEvent(prior ?? emptyLedger(root), event);
  const cwd = nonEmpty(snapshot.cwd) ?? env.cwd;
  const activity = visibleActivity(ledger);
  const { tokens, cost } = usage(ledger);
  const patch: SessionMarkerPatch = {
    cwd,
    project: basename(cwd),
    state: activity.state,
    activity: activity.activity,
    file: activity.file,
  };
  if (ledger.model !== undefined) patch.model = ledger.model;
  if (tokens !== undefined) patch.tokens = tokens;
  if (cost !== undefined) patch.cost = cost;
  if (event.kind === 'session-created' && event.session === root) patch.startedAt = now;
  return {
    translation: {
      kind: 'update',
      identity,
      patch,
      activityChanged: changesActivity(event, root),
    },
    ledger,
  };
}

/** Every well-formed snapshot in a stdin batch, in order. */
export function parseSnapshots(raw: string): OpenCodeSnapshot[] {
  const out: OpenCodeSnapshot[] = [];
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null) continue;
      const s = value as Partial<OpenCodeSnapshot>;
      if (s.v === 1 && nonEmpty(s.type) && nonEmpty(s.root)) out.push(s as OpenCodeSnapshot);
    } catch {
      // A broken line never hides the lines after it.
    }
  }
  return out;
}

/** Turn a stdin batch into ledger steps, one per snapshot, in order. */
export function batchSteps(raw: string, now: number, env: TranslateEnv): PendingLedgerStep[] {
  const steps: PendingLedgerStep[] = [];
  for (const snapshot of parseSnapshots(raw)) {
    const identity = openCodeIdentity(snapshot);
    if (!identity) continue;
    steps.push({ identity, step: (ledger) => translate(snapshot, now, env, ledger) });
  }
  return steps;
}

const DEFAULT_HOOK_RUNTIME = defaultHookRuntime(() => ({ cwd: process.cwd() }));

/** Hook entry for `vdp hook opencode`: never throws, prints nothing. */
export async function runHook(
  _args: string[] = [],
  runtime: HookRuntime<LedgerHookStore> = DEFAULT_HOOK_RUNTIME,
): Promise<void> {
  await runLedgerBatch(batchSteps, runtime);
}
