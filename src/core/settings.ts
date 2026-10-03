/**
 * Claude Code's settings.json: the hook-entry shapes VDP owns there. The shared
 * merge/strip/collision rules live in core/hook-groups.ts; the Claude Code
 * installer adapter (provider/claude-code-install.ts) owns the file IO.
 *
 * Ownership: a hook command is ours when it runs our built entry (`vdp.js`)
 * with the `hook` subcommand and Claude Code's route. That covers both shapes
 * VDP has written:
 *   node "<dir>/vdp.js" hook <event>               (legacy, ≤ 1.1)
 *   node "<dir>/vdp.js" hook claude-code <event>   (canonical)
 * Another provider's VDP route (e.g. `hook codex …`) is never Claude Code's.
 */
import { readJsonIfExists } from './json-file';
import { settingsPath } from './paths';
import {
  HookConfigError,
  countOwnedEvents,
  hookCommand,
  isOwnedGroup,
  isPlainObject,
  mergeOwnedHooks,
  stripOwnedHooks,
  validateHookMap,
  type HookGroup,
  type HookOwnership,
} from './hook-groups';
import { CLAUDE_CODE_HOOK_EVENTS } from '../provider/claude-code-events';
import { PROVIDER_KEYS } from '../types';

export type { HookCommand, HookGroup as HookEntry } from './hook-groups';
export { HookConfigError as SettingsError } from './hook-groups';

export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** Claude Code event name -> the arg we pass to `vdp hook claude-code <arg>`. */
export const HOOK_EVENTS = CLAUDE_CODE_HOOK_EVENTS;

const OUR_COMMAND = /vdp\.js"?\s+hook\s+(\S+)/;
const OTHER_ROUTES = new Set<string>(PROVIDER_KEYS.filter((key) => key !== 'claude-code'));

function isOurCommand(command: string): boolean {
  const route = OUR_COMMAND.exec(command)?.[1];
  return route !== undefined && !OTHER_ROUTES.has(route);
}

export function buildEntry(entryPath: string, arg: string): HookGroup {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: hookCommand(entryPath, 'claude-code', arg) }],
  };
}

function rules(entryPath = ''): HookOwnership {
  return {
    file: 'settings.json',
    isOurCommand,
    groups: () => HOOK_EVENTS.map((e) => ({ event: e.name, group: buildEntry(entryPath, e.arg) })),
  };
}

/**
 * Check that a parsed settings.json has the shape Claude Code reads: an object
 * whose optional `hooks` maps event names to arrays. Anything else is
 * malformed and must fail before any write, never be silently replaced.
 */
export function parseSettings(value: unknown): Settings {
  if (value === null) return {}; // a missing file
  if (!isPlainObject(value)) throw new HookConfigError('settings.json is not a JSON object');
  validateHookMap(value.hooks, 'settings.json');
  return value as Settings;
}

/**
 * Read and validate settings.json. A missing file is an empty one; a corrupt
 * or malformed one is an error the caller must see.
 */
export function readSettings(path: string = settingsPath()): Settings {
  return parseSettings(readJsonIfExists<unknown>(path));
}

/** True when the entry is wholly Claude Code's VDP entry. */
export function isOurEntry(entry: HookGroup): boolean {
  return isOwnedGroup(entry, rules());
}

/**
 * Install one canonical entry per hook event, replacing legacy or canonical
 * entries of ours in place and removing ours under events we no longer use.
 * Idempotent, and preserves the order of existing keys and foreign entries.
 */
export function mergeHooks(settings: Settings, entryPath: string): Settings {
  return { ...settings, hooks: mergeOwnedHooks(settings.hooks, rules(entryPath)) };
}

/** How many Claude Code hook events have our entry registered. */
export function countOurHooks(settings: Settings): number {
  return countOwnedEvents(settings.hooks, rules());
}

/** Strip only our entries, leaving every other hook untouched. */
export function stripOurHooks(settings: Settings): { cleaned: Settings; removed: number } {
  const { hooks, removed } = stripOwnedHooks(settings.hooks, rules());
  if (removed === 0) return { cleaned: settings, removed };
  const cleaned: Settings = { ...settings };
  if (hooks) cleaned.hooks = hooks;
  else delete cleaned.hooks;
  return { cleaned, removed };
}
