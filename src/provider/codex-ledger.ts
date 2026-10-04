/**
 * Codex activity ledger: what a Codex session is doing right now, kept across
 * hook processes so overlapping work is shown correctly.
 *
 * Every hook event belongs to a scope: the root thread, or a subagent named by
 * the payload's `agent_id`. Codex 0.160.0 was observed to:
 *   - run a turn's parallel tool calls with one PreToolUse each, then finish
 *     them in any order with PostToolUse (both carry `tool_use_id`);
 *   - send no PostToolUse for a tool whose approval was denied or rejected;
 *   - send PermissionRequest after the tool's own PreToolUse, without a
 *     `tool_use_id`, so the wait is matched to the newest open tool of that
 *     name in its scope;
 *   - keep a subagent running after the root's Stop, and end it with
 *     SubagentStop (the subagent's own events carry `agent_id`).
 *
 * So tools are tracked by `tool_use_id` and permission waits by scope, and
 * both are turn-scoped: the root's Stop, Interrupt or next prompt clears the
 * root's, and a SubagentStop clears that subagent's. The next tool call in a
 * scope also settles its wait, dropping the denied tool it was raised for.
 * Subagents are tracked by `agent_id` until SubagentStop, a new session, or
 * SESSION_AGENT_STALE_MS without any event from them. Completing one operation
 * never removes another.
 *
 * Visible activity, highest first: a permission wait, the newest active tool,
 * an active subagent, thinking, idle.
 *
 * Pure: every function takes the previous ledger and returns a new one.
 */
import type { ActivityState } from '../types';

export interface Activity {
  state: ActivityState;
  activity: string;
  file?: string;
}

interface ToolEntry {
  id: string;
  name: string;
  seq: number;
  agent?: string;
  activity: Activity;
}

interface AgentEntry {
  id: string;
  seq: number;
  /** When an event last came from this subagent (epoch ms). */
  seenAt: number;
}

interface PermissionEntry {
  seq: number;
  agent?: string;
  /** The tool it was raised for, when one matched. */
  tool?: string;
}

export interface CodexLedger {
  version: 1;
  /** Event counter: orders "newest" without trusting clocks across processes. */
  seq: number;
  /** What the root thread is doing when no tool, subagent or wait outranks it. */
  phase: 'starting' | 'thinking' | 'idle';
  tools: ToolEntry[];
  agents: AgentEntry[];
  permissions: PermissionEntry[];
}

/** One normalized hook event, as the ledger needs it. */
export interface LedgerEvent {
  kind:
    | 'session-start'
    | 'prompt'
    | 'pre-tool'
    | 'post-tool'
    | 'permission'
    | 'subagent-start'
    | 'subagent-stop'
    | 'turn-end';
  /** The subagent the event came from; absent for the root thread. */
  agent?: string;
  toolUseId?: string;
  toolName?: string;
  /** pre-tool only: what the tool is doing. */
  activity?: Activity;
}

/** A subagent with no event for this long is assumed gone without a SubagentStop. */
export const SESSION_AGENT_STALE_MS = 30 * 60 * 1000;

/** Leaked entries (e.g. denied tools in a long subagent turn) never grow without bound. */
const MAX_ENTRIES = 64;

export const THINKING: Activity = { state: 'thinking', activity: 'Thinking' };
export const IDLE: Activity = { state: 'idle', activity: 'Idle' };
const STARTING: Activity = { state: 'idle', activity: 'Starting a session' };
const WAITING: Activity = { state: 'waiting', activity: 'Waiting for permission' };

/** A ledger with nothing running, in the given root phase. */
export function emptyLedger(phase: CodexLedger['phase'] = 'idle'): CodexLedger {
  return { version: 1, seq: 0, phase, tools: [], agents: [], permissions: [] };
}

/** A stored ledger, or an empty one when it is missing or from another version. */
export function parseLedger(value: unknown): CodexLedger {
  if (typeof value !== 'object' || value === null) return emptyLedger();
  const l = value as Partial<CodexLedger>;
  if (
    l.version !== 1 ||
    !Number.isFinite(l.seq) ||
    !['starting', 'thinking', 'idle'].includes(l.phase as string) ||
    !Array.isArray(l.tools) ||
    !Array.isArray(l.agents) ||
    !Array.isArray(l.permissions)
  ) {
    return emptyLedger();
  }
  // Keep only well-formed entries, so a damaged one can never surface.
  const isEntry = (e: unknown): e is Record<string, unknown> =>
    typeof e === 'object' && e !== null && Number.isFinite((e as { seq?: unknown }).seq);
  return {
    version: 1,
    seq: l.seq as number,
    phase: l.phase as CodexLedger['phase'],
    tools: l.tools.filter(
      (t): t is ToolEntry =>
        isEntry(t) &&
        typeof t.id === 'string' &&
        typeof t.name === 'string' &&
        typeof (t.activity as Activity | undefined)?.state === 'string' &&
        typeof (t.activity as Activity | undefined)?.activity === 'string',
    ),
    agents: l.agents.filter(
      (a): a is AgentEntry => isEntry(a) && typeof a.id === 'string' && Number.isFinite(a.seenAt),
    ),
    permissions: l.permissions.filter((p): p is PermissionEntry => isEntry(p)),
  };
}

/** Entries from the root (`undefined`) or from one subagent. */
const inScope = (agent: string | undefined) => (entry: { agent?: string }) => entry.agent === agent;
/** Entries from anywhere except the root (`undefined`) or one subagent. */
const outOfScope = (agent: string | undefined) => (entry: { agent?: string }) =>
  entry.agent !== agent;

/** The entry with the highest event counter, if any. */
function newest<T extends { seq: number }>(entries: T[]): T | undefined {
  return entries.reduce<T | undefined>((a, b) => (a && a.seq > b.seq ? a : b), undefined);
}

/** Keep only the newest MAX_ENTRIES entries. */
const capped = <T>(entries: T[]): T[] => entries.slice(-MAX_ENTRIES);

/** Apply one event and return the next ledger. */
export function applyEvent(previous: CodexLedger, event: LedgerEvent, now: number): CodexLedger {
  if (event.kind === 'session-start') return { ...emptyLedger('starting'), seq: previous.seq + 1 };

  const seq = previous.seq + 1;
  const scope = event.agent;
  let { phase, tools, agents, permissions } = previous;

  // Forget subagents that went quiet without a SubagentStop, with their work.
  const stale = new Set(
    agents.filter((a) => now - a.seenAt > SESSION_AGENT_STALE_MS).map((a) => a.id),
  );
  if (stale.size > 0) {
    agents = agents.filter((a) => !stale.has(a.id));
    tools = tools.filter((t) => t.agent === undefined || !stale.has(t.agent));
    permissions = permissions.filter((p) => p.agent === undefined || !stale.has(p.agent));
  }

  // Any event from a subagent proves it is still running.
  if (scope !== undefined && event.kind !== 'subagent-stop') {
    const known = agents.find((a) => a.id === scope);
    agents = known
      ? agents.map((a) => (a.id === scope ? { ...a, seenAt: now } : a))
      : capped([...agents, { id: scope, seq, seenAt: now }]);
  }

  switch (event.kind) {
    case 'prompt':
      tools = tools.filter(outOfScope(scope));
      permissions = permissions.filter(outOfScope(scope));
      if (scope === undefined) phase = 'thinking';
      break;

    case 'pre-tool': {
      // A new tool call in this scope means its earlier approval was settled.
      // An approved tool completes before the model moves on, so one still
      // open was denied and will never send PostToolUse.
      const settled = new Set(
        permissions
          .filter(inScope(scope))
          .map((p) => p.tool)
          .filter((t) => t !== undefined),
      );
      permissions = permissions.filter(outOfScope(scope));
      const id = event.toolUseId ?? `anonymous-${seq}`;
      tools = capped([
        ...tools.filter((t) => t.id !== id && !settled.has(t.id)),
        {
          id,
          name: event.toolName ?? '',
          seq,
          agent: scope,
          activity: event.activity ?? { state: 'running', activity: 'Working' },
        },
      ]);
      if (scope === undefined) phase = 'thinking';
      break;
    }

    case 'post-tool': {
      const done =
        event.toolUseId !== undefined
          ? tools.find((t) => t.id === event.toolUseId)
          : newest(tools.filter((t) => inScope(scope)(t) && t.name === (event.toolName ?? '')));
      if (done) {
        tools = tools.filter((t) => t !== done);
        permissions = permissions.filter((p) => p.tool !== done.id);
      }
      if (scope === undefined) phase = 'thinking';
      break;
    }

    case 'permission': {
      const tool = newest(
        tools.filter((t) => inScope(scope)(t) && t.name === (event.toolName ?? '')),
      );
      permissions = capped([
        ...permissions.filter((p) => !(p.agent === scope && p.tool === tool?.id)),
        { seq, agent: scope, tool: tool?.id },
      ]);
      break;
    }

    case 'subagent-start':
      if (scope === undefined) {
        agents = capped([...agents, { id: `anonymous-${seq}`, seq, seenAt: now }]);
      }
      break;

    case 'subagent-stop': {
      // Without an agent_id, end the oldest subagent that also arrived without one.
      const gone =
        scope ??
        agents.filter((a) => a.id.startsWith('anonymous-')).sort((a, b) => a.seq - b.seq)[0]?.id;
      if (gone === undefined) break;
      agents = agents.filter((a) => a.id !== gone);
      tools = tools.filter(outOfScope(gone));
      permissions = permissions.filter(outOfScope(gone));
      break;
    }

    case 'turn-end':
      tools = tools.filter(outOfScope(scope));
      permissions = permissions.filter(outOfScope(scope));
      if (scope === undefined) phase = 'idle';
      break;
  }

  return { version: 1, seq, phase, tools, agents, permissions };
}

/** What the session is visibly doing, by the documented priority. */
export function visibleActivity(ledger: CodexLedger): Activity {
  if (ledger.permissions.length > 0) return WAITING;
  const tool = newest(ledger.tools);
  if (tool) return tool.activity;
  const agents = ledger.agents.length;
  if (agents > 0) {
    return {
      state: 'delegating',
      activity: agents === 1 ? 'Running a subagent' : `Running ${agents} subagents`,
    };
  }
  if (ledger.phase === 'thinking') return THINKING;
  return ledger.phase === 'starting' ? STARTING : IDLE;
}
