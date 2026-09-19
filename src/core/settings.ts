/**
 * Read/merge/write ~/.claude/settings.json. Centralized so install and
 * uninstall agree on the marker convention and the merge shape.
 *
 * Our hook entries are tagged by the command containing the built entry file
 * name (`vdp.js`), so we can find and remove exactly our own entries without
 * touching anyone else's hooks.
 */
import { readJsonIfExists, writeJsonAtomic } from './json-file';
import { settingsPath } from './paths';
import { CLAUDE_CODE_HOOK_EVENTS } from '../provider/claude-code-events';

/** Substring that identifies one of our hook commands. */
export const HOOK_MARKER = 'vdp.js';

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

/** Claude Code event name -> the arg we pass to `vdp hook <arg>`. */
export const HOOK_EVENTS = CLAUDE_CODE_HOOK_EVENTS;

/**
 * A missing settings file is an empty one; a corrupt one is an error the
 * caller must see (silently replacing a user's broken settings would lose
 * their other hooks).
 */
export async function readSettings(): Promise<Settings> {
  const parsed = readJsonIfExists<unknown>(settingsPath());
  if (typeof parsed !== 'object' || parsed === null) return {};
  return parsed as Settings;
}

export async function writeSettings(settings: Settings): Promise<void> {
  writeJsonAtomic(settingsPath(), settings, { pretty: true });
}

/** Back up non-empty settings before we touch them. Returns the backup path. */
export async function backupSettings(settings: Settings): Promise<string | null> {
  if (Object.keys(settings).length === 0) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${settingsPath()}.${ts}.bak`;
  writeJsonAtomic(path, settings, { pretty: true });
  return path;
}

export function isOurEntry(entry: HookEntry): boolean {
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
}

export function buildEntry(entryPath: string, arg: string): HookEntry {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: `node "${entryPath}" hook claude-code ${arg}` }],
  };
}

/** Remove any prior entries of ours, then add fresh ones. Idempotent. */
export function mergeHooks(settings: Settings, entryPath: string): Settings {
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const existing = (hooks[event.name] ?? []).filter((e) => !isOurEntry(e));
    existing.push(buildEntry(entryPath, event.arg));
    hooks[event.name] = existing;
  }
  return { ...settings, hooks };
}

/** Strip only our entries, leaving every other hook untouched. */
export function stripOurHooks(settings: Settings): { cleaned: Settings; removed: number } {
  const inHooks = settings.hooks;
  if (inHooks === undefined) return { cleaned: settings, removed: 0 };

  let removed = 0;
  const outHooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(inHooks)) {
    const kept = entries.filter((e) => {
      if (isOurEntry(e)) {
        removed++;
        return false;
      }
      return true;
    });
    if (kept.length > 0) outHooks[event] = kept;
  }

  const cleaned: Settings = { ...settings };
  if (Object.keys(outHooks).length > 0) cleaned.hooks = outHooks;
  else delete cleaned.hooks;

  return { cleaned, removed };
}
