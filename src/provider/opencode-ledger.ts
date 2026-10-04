/**
 * OpenCode activity ledger: what one OpenCode root session, and every child
 * session attributed to it, is doing right now, plus the usage needed for its
 * model, token and cost facts. Kept across hook processes under the root's
 * session lock.
 *
 * OpenCode 1.18.34 was observed (test/fixtures/opencode/README.md) to:
 *   - give every tool call a stable `callID`, whose tool part moves through
 *     `pending` → `running` → `completed` or `error`; tools from one response
 *     run in parallel and complete in any order, and a rejected call ends in
 *     `error` with no other completion;
 *   - run a subagent as a child session with its own id, whose tools and
 *     permission requests carry the child's id;
 *   - answer a permission request with `permission.replied` naming it, except
 *     when the turn is aborted: then only the session's `error` and `idle`
 *     end the wait;
 *   - repeat `message.updated` for one assistant message several times with
 *     the same or growing usage, so only the latest value per message id is
 *     true; `session.updated` carries the session's own aggregate, which also
 *     covers turns from before a resume. A child's usage is not in its root's.
 *
 * So tools are tracked by call id, permission waits by request id, and session
 * status per session. Usage keeps the latest value per message id; a session's
 * total is the larger of its own aggregate and the sum of its messages (both
 * only ever undercount the truth), and the root's total adds its children's.
 *
 * Visible activity, highest first: a permission wait, a retry wait, the newest
 * running child tool, the newest running root tool, an active child session,
 * a busy root, then the root's starting or idle state.
 *
 * Pure: every function takes the previous ledger and returns a new one.
 */
import type { ActivityState } from '../types';

export interface Activity {
  state: ActivityState;
  activity: string;
  file?: string;
}

export type SessionStatus = 'starting' | 'busy' | 'retry' | 'idle';

interface SessionEntry {
  id: string;
  /** Unset until the session reports a status. */
  status?: SessionStatus;
  /** Event counter of the last status change. */
  seq: number;
  /** OpenCode's own aggregate for the session, from `session.updated`. */
  output?: number;
  cost?: number;
  /** Usage folded from messages no longer tracked one by one. */
  settledOutput?: number;
  settledCost?: number;
}

interface ToolEntry {
  call: string;
  session: string;
  /** Event counter of the call's first sighting: newest start wins. */
  seq: number;
  activity: Activity;
}

interface PermissionEntry {
  request: string;
  session: string;
  seq: number;
}

interface MessageEntry {
  id: string;
  session: string;
  output?: number;
  cost?: number;
}

export interface OpenCodeLedger {
  version: 1;
  /** The root session this ledger belongs to. */
  root: string;
  /** Event counter: orders "newest" without trusting clocks across processes. */
  seq: number;
  sessions: SessionEntry[];
  tools: ToolEntry[];
  permissions: PermissionEntry[];
  messages: MessageEntry[];
  model?: string;
}

/** One normalized OpenCode event. `session` is the root or one of its children. */
export type LedgerEvent =
  | { kind: 'session-created'; session: string }
  | { kind: 'session-usage'; session: string; output?: number; cost?: number; model?: string }
  | { kind: 'status'; session: string; status: 'busy' | 'retry' }
  | { kind: 'idle'; session: string }
  | { kind: 'error'; session: string }
  | { kind: 'deleted'; session: string }
  | {
      kind: 'message';
      session: string;
      message: string;
      role?: string;
      model?: string;
      output?: number;
      cost?: number;
    }
  | {
      kind: 'tool';
      session: string;
      call: string;
      state: 'pending' | 'running' | 'completed' | 'error';
      activity: Activity;
    }
  | { kind: 'permission-asked'; session: string; request?: string }
  | { kind: 'permission-replied'; session: string; request?: string };

/** Nothing grows without bound, whatever the runtime sends. */
const MAX_SESSIONS = 64;
const MAX_TOOLS = 64;
const MAX_PERMISSIONS = 32;
/** Older messages are folded into their session's settled usage. */
const MAX_MESSAGES = 256;

export const THINKING: Activity = { state: 'thinking', activity: 'Thinking' };
export const IDLE: Activity = { state: 'idle', activity: 'Idle' };
const STARTING: Activity = { state: 'idle', activity: 'Starting a session' };
const WAITING: Activity = { state: 'waiting', activity: 'Waiting for permission' };
const RETRYING: Activity = { state: 'waiting', activity: 'Waiting to retry' };
const DELEGATING: Activity = { state: 'delegating', activity: 'Running a subagent' };

/** A ledger for `root` with nothing known yet. */
export function emptyLedger(root: string): OpenCodeLedger {
  return { version: 1, root, seq: 0, sessions: [], tools: [], permissions: [], messages: [] };
}

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const optionalCount = (value: unknown): value is number | undefined =>
  value === undefined || isCount(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isActivity = (value: unknown): value is Activity =>
  isRecord(value) && isString(value.state) && isString(value.activity);
const STATUSES = new Set<unknown>(['starting', 'busy', 'retry', 'idle']);

function entries<T>(value: unknown, valid: (entry: Record<string, unknown>) => boolean): T[] {
  return Array.isArray(value) ? (value.filter((e) => isRecord(e) && valid(e)) as T[]) : [];
}

/**
 * The stored ledger for `root`, or null when there is none, or it is from
 * another version or root. Damaged entries are dropped so they never surface.
 */
export function parseLedger(value: unknown, root: string): OpenCodeLedger | null {
  if (!isRecord(value) || value.version !== 1 || value.root !== root || !isCount(value.seq)) {
    return null;
  }
  return {
    version: 1,
    root,
    seq: value.seq,
    sessions: entries<SessionEntry>(
      value.sessions,
      (e) =>
        isString(e.id) &&
        (e.status === undefined || STATUSES.has(e.status)) &&
        isCount(e.seq) &&
        optionalCount(e.output) &&
        optionalCount(e.cost) &&
        optionalCount(e.settledOutput) &&
        optionalCount(e.settledCost),
    ),
    tools: entries<ToolEntry>(
      value.tools,
      (e) => isString(e.call) && isString(e.session) && isCount(e.seq) && isActivity(e.activity),
    ),
    permissions: entries<PermissionEntry>(
      value.permissions,
      (e) => isString(e.request) && isString(e.session) && isCount(e.seq),
    ),
    messages: entries<MessageEntry>(
      value.messages,
      (e) =>
        isString(e.id) && isString(e.session) && optionalCount(e.output) && optionalCount(e.cost),
    ),
    ...(isString(value.model) ? { model: value.model } : {}),
  };
}

/** Whether an event may start tracking a root that has no ledger yet. */
export function opensSession(event: LedgerEvent, root: string): boolean {
  switch (event.kind) {
    case 'session-created':
      return event.session === root;
    case 'status':
    case 'permission-asked':
      return true;
    case 'tool':
      return event.state === 'pending' || event.state === 'running';
    default:
      return false;
  }
}

/** Whether an event changes what the session is visibly doing (else it only proves liveness). */
export function changesActivity(event: LedgerEvent, root: string): boolean {
  switch (event.kind) {
    case 'session-usage':
    case 'message':
      return false;
    case 'session-created':
      return event.session === root;
    default:
      return true;
  }
}

/** `a + b`, where unknown plus unknown stays unknown. */
const add = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : a + b;
/** The larger known value, or unknown when neither is known. */
const larger = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/** Keep at most `max` entries, dropping the ones with the oldest `seq`. */
function newestOnly<T extends { seq: number }>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  return [...list].sort((a, b) => a.seq - b.seq).slice(list.length - max);
}

/** Apply one event and return the next ledger. */
export function applyEvent(previous: OpenCodeLedger, event: LedgerEvent): OpenCodeLedger {
  const seq = previous.seq + 1;
  const { root } = previous;
  let { sessions, tools, permissions, messages, model } = previous;

  /** Replace (or add) one session entry. */
  const updateSession = (id: string, change: Partial<SessionEntry>) => {
    const known = sessions.find((s) => s.id === id);
    const next: SessionEntry = { ...(known ?? { id, seq }), ...change };
    sessions = known ? sessions.map((s) => (s === known ? next : s)) : [...sessions, next];
  };
  const ofSession = (entry: { session: string }) => entry.session === event.session;

  switch (event.kind) {
    case 'session-created':
      // A new root starts from nothing; a child is only noted until it works.
      if (event.session === root) {
        return { ...emptyLedger(root), seq, sessions: [{ id: root, status: 'starting', seq }] };
      }
      if (!sessions.some((s) => s.id === event.session)) updateSession(event.session, {});
      break;

    case 'session-usage':
      updateSession(event.session, {
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.cost !== undefined ? { cost: event.cost } : {}),
      });
      if (event.model && (event.session === root || model === undefined)) model = event.model;
      break;

    case 'status':
      updateSession(event.session, { status: event.status, seq });
      break;

    case 'idle':
      if (event.session === root) {
        // The turn is over: whatever a rejected or aborted call left goes.
        tools = [];
        permissions = [];
        sessions = sessions.map((s) => (s.status ? { ...s, status: 'idle', seq } : s));
        updateSession(root, { status: 'idle', seq });
      } else {
        tools = tools.filter((t) => !ofSession(t));
        permissions = permissions.filter((p) => !ofSession(p));
        updateSession(event.session, { status: 'idle', seq });
      }
      break;

    case 'error':
      // An aborted request gets no reply; the error is the end of its wait.
      permissions = permissions.filter((p) => !ofSession(p));
      break;

    case 'deleted':
      sessions = sessions.filter((s) => s.id !== event.session);
      tools = tools.filter((t) => !ofSession(t));
      permissions = permissions.filter((p) => !ofSession(p));
      messages = messages.filter((m) => !ofSession(m));
      break;

    case 'message': {
      if (event.model && (event.session === root || model === undefined)) model = event.model;
      if (event.role !== 'assistant') break;
      // The latest update for a message replaces every earlier one.
      const next: MessageEntry = {
        id: event.message,
        session: event.session,
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.cost !== undefined ? { cost: event.cost } : {}),
      };
      messages = [...messages.filter((m) => m.id !== event.message), next];
      while (messages.length > MAX_MESSAGES) {
        const [oldest, ...rest] = messages as [MessageEntry, ...MessageEntry[]];
        messages = rest;
        const owner = sessions.find((s) => s.id === oldest.session);
        updateSession(oldest.session, {
          settledOutput: add(owner?.settledOutput, oldest.output),
          settledCost: add(owner?.settledCost, oldest.cost),
        });
      }
      break;
    }

    case 'tool': {
      const known = tools.find((t) => t.call === event.call);
      if (event.state === 'completed' || event.state === 'error') {
        tools = tools.filter((t) => t !== known);
        break;
      }
      const next: ToolEntry = {
        call: event.call,
        session: event.session,
        seq: known?.seq ?? seq,
        activity: event.activity,
      };
      tools = newestOnly(
        known ? tools.map((t) => (t === known ? next : t)) : [...tools, next],
        MAX_TOOLS,
      );
      break;
    }

    case 'permission-asked': {
      const request = event.request ?? `${event.session}#${seq}`;
      permissions = newestOnly(
        [
          ...permissions.filter((p) => p.request !== request),
          { request, session: event.session, seq },
        ],
        MAX_PERMISSIONS,
      );
      break;
    }

    case 'permission-replied': {
      const answered = permissions.filter((p) => p.request === event.request);
      // A reply that names no known request still ends its session's waits.
      permissions =
        answered.length > 0
          ? permissions.filter((p) => !answered.includes(p))
          : permissions.filter((p) => !ofSession(p));
      break;
    }
  }

  // Never drop the root's own entry to make room for children.
  if (sessions.length > MAX_SESSIONS) {
    const rootEntry = sessions.filter((s) => s.id === root);
    sessions = [
      ...rootEntry,
      ...newestOnly(
        sessions.filter((s) => s.id !== root),
        MAX_SESSIONS - rootEntry.length,
      ),
    ];
  }

  return {
    version: 1,
    root,
    seq,
    sessions,
    tools,
    permissions,
    messages,
    ...(model !== undefined ? { model } : {}),
  };
}

/** The tool that started most recently, if any. */
function newest(tools: ToolEntry[]): ToolEntry | undefined {
  return tools.reduce<ToolEntry | undefined>((a, b) => (a && a.seq > b.seq ? a : b), undefined);
}

/** What the root session is visibly doing, by the documented priority. */
export function visibleActivity(ledger: OpenCodeLedger): Activity {
  if (ledger.permissions.length > 0) return WAITING;
  if (ledger.sessions.some((s) => s.status === 'retry')) return RETRYING;
  const childTool = newest(ledger.tools.filter((t) => t.session !== ledger.root));
  if (childTool) return childTool.activity;
  const rootTool = newest(ledger.tools.filter((t) => t.session === ledger.root));
  if (rootTool) return rootTool.activity;
  if (ledger.sessions.some((s) => s.id !== ledger.root && s.status === 'busy')) return DELEGATING;
  const root = ledger.sessions.find((s) => s.id === ledger.root);
  if (root?.status === 'busy') return THINKING;
  return root?.status === 'starting' ? STARTING : IDLE;
}

/** The root's output tokens and cost, its children's included; unknown stays undefined. */
export function usage(ledger: OpenCodeLedger): { tokens?: number; cost?: number } {
  const ids = new Set([
    ...ledger.sessions.map((s) => s.id),
    ...ledger.messages.map((m) => m.session),
  ]);
  let tokens: number | undefined;
  let cost: number | undefined;
  for (const id of ids) {
    const session = ledger.sessions.find((s) => s.id === id);
    let output = session?.settledOutput;
    let spent = session?.settledCost;
    for (const m of ledger.messages) {
      if (m.session !== id) continue;
      output = add(output, m.output);
      spent = add(spent, m.cost);
    }
    tokens = add(tokens, larger(session?.output, output));
    cost = add(cost, larger(session?.cost, spent));
  }
  return { tokens, cost };
}
