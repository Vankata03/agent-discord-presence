/**
 * Claude Code's settings.json: the hook-entry shapes VDP owns and the pure
 * merge/strip rules over them. The Claude Code installer adapter
 * (provider/claude-code-install.ts) owns the file IO around these rules.
 *
 * Ownership: a hook command is ours when it runs our built entry (`vdp.js`)
 * with the `hook` subcommand. That covers both shapes VDP has written:
 *   node "<dir>/vdp.js" hook <event>               (legacy, ≤ 1.1)
 *   node "<dir>/vdp.js" hook claude-code <event>   (canonical)
 * An entry is ours only when every command in it is ours. An entry that mixes
 * our command with someone else's is an ownership collision: removing it would
 * delete a foreign hook and keeping it would leave ours behind, so both merge
 * and strip refuse it and the user resolves it by hand.
 */
import { readJsonIfExists } from './json-file';
import { settingsPath } from './paths';
import { CLAUDE_CODE_HOOK_EVENTS } from '../provider/claude-code-events';

export interface HookCommand {
  type?: string;
  command?: string;
}

export interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

export interface Settings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

/** Claude Code event name -> the arg we pass to `vdp hook claude-code <arg>`. */
export const HOOK_EVENTS = CLAUDE_CODE_HOOK_EVENTS;

/** A settings file VDP must not rewrite: malformed, or an ownership collision. */
export class SettingsError extends Error {
  override name = 'SettingsError';
}

const OUR_COMMAND = /vdp\.js"?\s+hook(\s|$)/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check that a parsed settings.json has the shape Claude Code reads: an object
 * whose optional `hooks` maps event names to arrays. Anything else is
 * malformed and must fail before any write, never be silently replaced.
 */
export function parseSettings(value: unknown): Settings {
  if (value === null) return {}; // a missing file
  if (!isPlainObject(value)) throw new SettingsError('settings.json is not a JSON object');
  const hooks = value.hooks;
  if (hooks === undefined) return value as Settings;
  if (!isPlainObject(hooks)) throw new SettingsError('settings.json "hooks" is not an object');
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      throw new SettingsError(`settings.json "hooks.${event}" is not an array`);
    }
  }
  return value as Settings;
}

/**
 * Read and validate settings.json. A missing file is an empty one; a corrupt
 * or malformed one is an error the caller must see.
 */
export function readSettings(path: string = settingsPath()): Settings {
  return parseSettings(readJsonIfExists<unknown>(path));
}

function isOurCommand(hook: unknown): boolean {
  return isPlainObject(hook) && typeof hook.command === 'string' && OUR_COMMAND.test(hook.command);
}

type Ownership = 'ours' | 'foreign' | 'mixed';

function ownership(entry: unknown): Ownership {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return 'foreign';
  const ours = entry.hooks.filter(isOurCommand).length;
  if (ours === 0) return 'foreign';
  return ours === entry.hooks.length ? 'ours' : 'mixed';
}

/** True when the entry is wholly VDP's (every command in it is ours). */
export function isOurEntry(entry: HookEntry): boolean {
  return ownership(entry) === 'ours';
}

function assertNoCollision(settings: Settings): void {
  const events = Object.entries(settings.hooks ?? {})
    .filter(([, entries]) => entries.some((e) => ownership(e) === 'mixed'))
    .map(([event]) => event);
  if (events.length > 0) {
    throw new SettingsError(
      `settings.json mixes a vdp hook with another command in one entry (${events.join(', ')}); ` +
        'split that entry by hand so each tool owns its own entry',
    );
  }
}

export function buildEntry(entryPath: string, arg: string): HookEntry {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: `node "${entryPath}" hook claude-code ${arg}` }],
  };
}

/**
 * Remove every entry of ours (legacy or canonical, under any event), then add
 * one canonical entry per hook event. Idempotent, and preserves the order of
 * existing keys so unrelated settings serialize exactly as before.
 */
export function mergeHooks(settings: Settings, entryPath: string): Settings {
  assertNoCollision(settings);
  const ourEvents = new Set(HOOK_EVENTS.map((e) => e.name));
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries.filter((e) => !isOurEntry(e));
    // Drop an event we emptied, unless we are about to refill it in place.
    if (kept.length > 0 || entries.length === 0 || ourEvents.has(event)) hooks[event] = kept;
  }
  for (const event of HOOK_EVENTS) {
    (hooks[event.name] ??= []).push(buildEntry(entryPath, event.arg));
  }
  return { ...settings, hooks };
}

/** Strip only our entries, leaving every other hook untouched. */
export function stripOurHooks(settings: Settings): { cleaned: Settings; removed: number } {
  const inHooks = settings.hooks;
  if (inHooks === undefined) return { cleaned: settings, removed: 0 };
  assertNoCollision(settings);

  let removed = 0;
  const outHooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(inHooks)) {
    const kept = entries.filter((e) => !isOurEntry(e));
    removed += entries.length - kept.length;
    if (kept.length > 0 || entries.length === 0) outHooks[event] = kept;
  }
  if (removed === 0) return { cleaned: settings, removed };

  const cleaned: Settings = { ...settings };
  if (Object.keys(outHooks).length > 0) cleaned.hooks = outHooks;
  else delete cleaned.hooks;

  return { cleaned, removed };
}
