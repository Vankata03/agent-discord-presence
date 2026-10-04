/**
 * Gemini CLI activity ledger: what a Gemini CLI session is doing right now,
 * kept across hook processes so overlapping tools are shown correctly.
 *
 * Gemini CLI 0.62.0 was observed (test/fixtures/gemini-cli/README.md) to:
 *   - run the tools of one model response in parallel: every BeforeTool fires
 *     before any AfterTool, and they can complete in any order;
 *   - send no call id with either event, only the tool name and input, so a
 *     completion cannot be paired with the start it belongs to;
 *   - send a ToolPermission notification after the tool's own BeforeTool and
 *     before its AfterTool, interactively only;
 *   - send no AfterTool for a tool whose approval was denied or cancelled,
 *     and, when the user cancels the prompt (Esc), no AfterAgent either.
 *
 * So running tools are counted per normalized family (editing, running a
 * command, searching, …): BeforeTool increments its family and AfterTool
 * decrements only that family, so one tool finishing never hides another that
 * is still running. Each family remembers when it last started a tool (an
 * event counter, so "newest" never depends on clocks across processes) and
 * what that tool was doing. The counts are turn-scoped: AfterAgent clears what
 * a denied or cancelled tool leaked, and so does the next BeforeAgent.
 *
 * A permission wait is tied to the family it was raised for and ends when a
 * tool of that family completes, or with the turn. A cancelled prompt sends
 * nothing at all, so its wait lasts until the next prompt or the session end.
 *
 * Visible activity, highest first: a permission wait, the newest family still
 * running, thinking, idle.
 *
 * Pure: every function takes the previous ledger and returns a new one.
 */
import type { ActivityState } from '../types';

export interface Activity {
  state: ActivityState;
  activity: string;
  file?: string;
}

interface FamilyEntry {
  family: string;
  /** Tools of this family started and not yet completed. */
  count: number;
  /** Event counter of the family's newest start. */
  seq: number;
  /** What the family's newest start was doing. */
  activity: Activity;
  /** What the family is doing when its newest start's detail may be stale. */
  generic: Activity;
}

interface PermissionWait {
  seq: number;
  /** The family it was raised for, when known. */
  family?: string;
}

export interface GeminiLedger {
  version: 1;
  /** Event counter: orders "newest" without trusting clocks across processes. */
  seq: number;
  /** What the session is doing when no tool or wait outranks it. */
  phase: 'starting' | 'thinking' | 'idle';
  families: FamilyEntry[];
  permission: PermissionWait | null;
}

/** One normalized tool call, as the ledger needs it. */
export interface ToolCall {
  family: string;
  activity: Activity;
  generic: Activity;
}

/** One normalized hook event. */
export type LedgerEvent =
  | { kind: 'session-start' }
  | { kind: 'prompt' }
  | { kind: 'turn-end' }
  | ({ kind: 'before-tool' } & ToolCall)
  | ({ kind: 'after-tool' } & ToolCall)
  | { kind: 'permission'; family?: string };

/** Families never grow without bound, whatever the runtime sends. */
const MAX_FAMILIES = 64;

export const THINKING: Activity = { state: 'thinking', activity: 'Thinking' };
export const IDLE: Activity = { state: 'idle', activity: 'Idle' };
const STARTING: Activity = { state: 'idle', activity: 'Starting a session' };
const WAITING: Activity = { state: 'waiting', activity: 'Waiting for permission' };

/** A ledger with nothing running, in the given phase. */
export function emptyLedger(phase: GeminiLedger['phase'] = 'idle'): GeminiLedger {
  return { version: 1, seq: 0, phase, families: [], permission: null };
}

const isActivity = (value: unknown): value is Activity =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Activity).state === 'string' &&
  typeof (value as Activity).activity === 'string';

/** A stored ledger, or an empty one when it is missing or from another version. */
export function parseLedger(value: unknown): GeminiLedger {
  if (typeof value !== 'object' || value === null) return emptyLedger();
  const l = value as Partial<GeminiLedger>;
  if (
    l.version !== 1 ||
    !Number.isFinite(l.seq) ||
    !['starting', 'thinking', 'idle'].includes(l.phase as string) ||
    !Array.isArray(l.families)
  ) {
    return emptyLedger();
  }
  // Keep only well-formed entries, so a damaged one can never surface.
  const families = l.families.filter(
    (f): f is FamilyEntry =>
      typeof f === 'object' &&
      f !== null &&
      typeof f.family === 'string' &&
      Number.isInteger(f.count) &&
      f.count > 0 &&
      Number.isFinite(f.seq) &&
      isActivity(f.activity) &&
      isActivity(f.generic),
  );
  const p = l.permission;
  const permission =
    typeof p === 'object' && p !== null && Number.isFinite(p.seq)
      ? { seq: p.seq, ...(typeof p.family === 'string' ? { family: p.family } : {}) }
      : null;
  return {
    version: 1,
    seq: l.seq as number,
    phase: l.phase as GeminiLedger['phase'],
    families,
    permission,
  };
}

/** The family that started a tool most recently, if any is running. */
function newest(families: FamilyEntry[]): FamilyEntry | undefined {
  return families.reduce<FamilyEntry | undefined>(
    (a, b) => (a && a.seq > b.seq ? a : b),
    undefined,
  );
}

/** Apply one event and return the next ledger. */
export function applyEvent(previous: GeminiLedger, event: LedgerEvent): GeminiLedger {
  const seq = previous.seq + 1;
  let { phase, families, permission } = previous;

  switch (event.kind) {
    case 'session-start':
      return { ...emptyLedger('starting'), seq };

    case 'prompt':
    case 'turn-end':
      // The turn boundary: whatever a denied or cancelled tool left behind goes.
      families = [];
      permission = null;
      phase = event.kind === 'prompt' ? 'thinking' : 'idle';
      break;

    case 'before-tool': {
      const known = families.find((f) => f.family === event.family);
      const started: FamilyEntry = {
        family: event.family,
        count: (known?.count ?? 0) + 1,
        seq,
        activity: event.activity,
        generic: event.generic,
      };
      families = known
        ? families.map((f) => (f === known ? started : f))
        : [...families, started].slice(-MAX_FAMILIES);
      phase = 'thinking';
      break;
    }

    case 'after-tool': {
      const known = families.find((f) => f.family === event.family);
      if (known) {
        const count = known.count - 1;
        // Without call ids the finished tool may have been the one whose detail
        // (its file) the family shows; fall back to what the family does.
        const stale =
          known.activity.file !== undefined && known.activity.file === event.activity.file;
        families =
          count === 0
            ? families.filter((f) => f !== known)
            : families.map((f) =>
                f === known ? { ...f, count, activity: stale ? f.generic : f.activity } : f,
              );
      }
      if (permission && (permission.family === undefined || permission.family === event.family)) {
        permission = null;
      }
      phase = 'thinking';
      break;
    }

    case 'permission':
      permission = { seq, family: event.family ?? newest(families)?.family };
      break;
  }

  return { version: 1, seq, phase, families, permission };
}

/** What the session is visibly doing, by the documented priority. */
export function visibleActivity(ledger: GeminiLedger): Activity {
  if (ledger.permission) return WAITING;
  const family = newest(ledger.families);
  if (family) return family.activity;
  if (ledger.phase === 'thinking') return THINKING;
  return ledger.phase === 'starting' ? STARTING : IDLE;
}
