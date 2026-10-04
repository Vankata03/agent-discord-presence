/**
 * Gemini CLI installer adapter.
 *
 * VDP registers user-level command hooks in Gemini CLI's user settings
 * (`~/.gemini/settings.json`, `$GEMINI_CLI_HOME/.gemini/` when set), which
 * Gemini loads for every trusted project. The file is the user's main Gemini
 * configuration, so it goes through SharedJsonFile: malformed content and
 * ownership collisions fail without writing, the original is backed up before
 * a change, and untouched settings keep their exact bytes. Gemini also accepts
 * comments in this file; strict JSON parsing refuses to edit such a file
 * rather than rewrite it.
 *
 * Only the session start/end, before/after agent, before/after tool and
 * notification events are registered, each as a matcher-less group with one
 * command hook and `timeout: 3000` (milliseconds, Gemini's unit). VDP never
 * touches `hooksConfig`, telemetry, checkpointing, or the model,
 * tool-selection and compression hooks.
 *
 * Gemini runs the command through `bash -c` (PowerShell on Windows) after
 * substituting its own variables, so the entry path is single-quoted for the
 * platform's shell: a double-quoted path breaks on `$` or a backtick, and a
 * backtick under bash exits 2, which Gemini treats as a deny.
 *
 * Gemini skips every hook in an untrusted folder, user-level ones included;
 * install output says so, and VDP never bypasses folder trust.
 *
 * Detection is gemini-cli-detect.ts: ready only when the runtime offers the
 * command-hook contract.
 */
import { join } from 'node:path';
import {
  HookConfigError,
  countOwnedEvents,
  isPlainObject,
  mergeOwnedHooks,
  stripOwnedHooks,
  validateHookMap,
  type HookGroup,
  type HookMap,
  type HookOwnership,
} from '../core/hook-groups';
import { geminiDir } from '../core/paths';
import { SharedJsonFile } from '../core/shared-json-file';
import { GEMINI_CLI_HOOK_EVENTS } from './gemini-cli';
import { detectGeminiCli, type GeminiCliDetectOptions } from './gemini-cli-detect';
import type {
  Detection,
  HookInventory,
  InstallContext,
  InstallResult,
  ProviderInstaller,
  UninstallResult,
} from './installer';

/** Milliseconds: Gemini CLI hook timeouts are in ms. */
export const GEMINI_CLI_HOOK_TIMEOUT_MS = 3000;

/** The hook name Gemini shows while it runs, and `hooksConfig.disabled` can list. */
export const GEMINI_CLI_HOOK_NAME = 'vibecoder-discord-presence';

export const GEMINI_CLI_TRUST_NOTE =
  'Gemini CLI runs hooks only in folders you trust, so your presence stays off in untrusted folders.';

/** Keys of `hooks` that configure the hook system rather than name an event. */
const HOOK_SETTINGS_KEYS = new Set(['enabled', 'disabled', 'notifications']);
const OUR_COMMAND = /vdp\.js['"]?\s+hook\s+gemini-cli(\s|$)/;

interface Settings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Split `hooks` into its event map and the hook-system keys Gemini skips. */
function eventHooks(hooks: Record<string, unknown> | undefined): HookMap | undefined {
  if (hooks === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(hooks).filter(([key]) => !HOOK_SETTINGS_KEYS.has(key)),
  ) as HookMap;
}

/** Put a changed event map back, keeping the hook-system keys and key order. */
function withEventHooks(
  hooks: Record<string, unknown> | undefined,
  events: HookMap | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks ?? {})) {
    if (HOOK_SETTINGS_KEYS.has(key)) out[key] = value;
    else if (events && key in events) out[key] = events[key];
  }
  for (const [key, value] of Object.entries(events ?? {})) {
    if (!(key in out)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSettings(value: unknown): Settings {
  if (value === null) return {}; // a missing or empty file
  if (!isPlainObject(value)) throw new HookConfigError('settings.json is not a JSON object');
  if (value.hooks !== undefined && !isPlainObject(value.hooks)) {
    throw new HookConfigError('settings.json "hooks" is not an object');
  }
  validateHookMap(eventHooks(value.hooks as Record<string, unknown> | undefined), 'settings.json');
  return value as Settings;
}

/** Quote a path as one literal word for the shell Gemini runs hooks with. */
export function quoteForShell(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // PowerShell single-quoted string: no expansion, and every quote character
    // PowerShell accepts as one (including the typographic ones) is doubled.
    return `'${path.replace(/['‘’‚‛]/g, '$&$&')}'`;
  }
  // POSIX single-quoted string: no expansion; a quote closes, escapes, reopens.
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Our command: `node '<entry>' hook gemini-cli <event>`, quoted for the platform's shell. */
export function geminiHookCommand(
  entryPath: string,
  event: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `node ${quoteForShell(entryPath, platform)} hook gemini-cli ${event}`;
}

export function buildGeminiGroup(
  entryPath: string,
  arg: string,
  platform: NodeJS.Platform = process.platform,
): HookGroup {
  return {
    hooks: [
      {
        type: 'command',
        name: GEMINI_CLI_HOOK_NAME,
        command: geminiHookCommand(entryPath, arg, platform),
        timeout: GEMINI_CLI_HOOK_TIMEOUT_MS,
      },
    ],
  };
}

function rules(entryPath = '', platform: NodeJS.Platform = process.platform): HookOwnership {
  return {
    file: 'settings.json',
    isOurCommand: (command) => OUR_COMMAND.test(command),
    groups: () =>
      GEMINI_CLI_HOOK_EVENTS.map((e) => ({
        event: e.name,
        group: buildGeminiGroup(entryPath, e.arg, platform),
      })),
  };
}

export interface GeminiCliInstallerOptions extends GeminiCliDetectOptions {
  /** The shell flavour hook commands are quoted for. */
  platform?: NodeJS.Platform;
  now?: () => Date;
}

export class GeminiCliInstaller implements ProviderInstaller {
  readonly provider = 'gemini-cli' as const;
  readonly settingsPath: string;
  private readonly settings: SharedJsonFile<Settings>;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: GeminiCliInstallerOptions = {}) {
    const dir = options.dir ?? geminiDir();
    this.settingsPath = join(dir, 'settings.json');
    this.settings = new SharedJsonFile(this.settingsPath, parseSettings, options.now);
    this.platform = options.platform ?? process.platform;
    this.options = { ...options, dir };
  }

  locations(): string[] {
    return [this.settingsPath];
  }

  detect(): Promise<Detection> {
    return detectGeminiCli(this.options);
  }

  async install(context: InstallContext): Promise<InstallResult> {
    const snapshot = this.settings.read();
    const merged = mergeOwnedHooks(
      eventHooks(snapshot.value.hooks),
      rules(context.entryPath, this.platform),
    );
    const outcome = this.settings.write(snapshot, {
      ...snapshot.value,
      hooks: withEventHooks(snapshot.value.hooks, merged),
    });
    return {
      ...outcome,
      registered: GEMINI_CLI_HOOK_EVENTS.map((e) => e.name),
      notes: [GEMINI_CLI_TRUST_NOTE],
    };
  }

  async inspect(): Promise<HookInventory> {
    const expected = GEMINI_CLI_HOOK_EVENTS.length;
    try {
      const hooks = eventHooks(this.settings.read().value.hooks);
      return { present: countOwnedEvents(hooks, rules()), expected };
    } catch (err) {
      return { present: 0, expected, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async uninstall(): Promise<UninstallResult> {
    let snapshot;
    let stripped;
    try {
      snapshot = this.settings.read();
      stripped = stripOwnedHooks(eventHooks(snapshot.value.hooks), rules());
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { removed: 0, backups: [], surviving: [{ location: this.settingsPath, reason }] };
    }
    if (stripped.removed === 0) return { removed: 0, backups: [], surviving: [] };
    const next: Settings = { ...snapshot.value };
    const hooks = withEventHooks(snapshot.value.hooks, stripped.hooks);
    if (hooks) next.hooks = hooks;
    else delete next.hooks;
    // A file holding nothing but our hooks goes away with them.
    const { backups } = this.settings.write(snapshot, next, { removeIfEmpty: true });
    return { removed: stripped.removed, backups, surviving: [] };
  }
}
