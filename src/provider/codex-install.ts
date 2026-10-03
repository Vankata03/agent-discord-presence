/**
 * Codex installer adapter.
 *
 * VDP registers user-level hooks in `$CODEX_HOME/hooks.json` (default
 * `~/.codex/hooks.json`), which Codex loads for every project. It never edits
 * Codex's `config.toml` and never creates project hooks. The file is shared
 * with the user and other tools, so it goes through SharedJsonFile: malformed
 * content and ownership collisions fail without writing, the original is
 * backed up before a change, and untouched entries keep their exact bytes.
 *
 * Each of our entries is a matcher-less group with one synchronous command,
 * `node "<entry>" hook codex <event>`, and a three-second timeout. Codex
 * accepts only `description` and `hooks` at the top level of the file, so any
 * other key makes the file malformed for Codex and for us.
 *
 * Codex runs unmanaged hooks only after the user reviews and trusts them once
 * in its `/hooks` view; install output says so. Trust is keyed by each hook's
 * position, so reinstall replaces our groups in place (core/hook-groups.ts)
 * and never shifts the user's other hooks. VDP never enables or recommends
 * `--dangerously-bypass-hook-trust`.
 *
 * Detection is `ready` when the `codex` executable resolves, or when the Codex
 * home holds data (the desktop app and IDE extensions bundle their own binary).
 */
import { join } from 'node:path';
import { findExecutable, probeVersion } from '../core/executable';
import {
  HookConfigError,
  countOwnedEvents,
  hookCommand,
  isPlainObject,
  mergeOwnedHooks,
  stripOwnedHooks,
  validateHookMap,
  type HookGroup,
  type HookMap,
  type HookOwnership,
} from '../core/hook-groups';
import { codexHome } from '../core/paths';
import { SharedJsonFile } from '../core/shared-json-file';
import { CODEX_HOOK_EVENTS } from './codex';
import type {
  Detection,
  HookInventory,
  InstallContext,
  InstallResult,
  ProviderInstaller,
  UninstallResult,
} from './installer';

/** Seconds; Codex caps SessionEnd and Interrupt hooks at three. */
export const CODEX_HOOK_TIMEOUT_SEC = 3;

export const CODEX_TRUST_NOTE =
  'Codex runs these hooks only after you approve them: open Codex and review them once with /hooks.';

interface HooksFile {
  description?: string;
  hooks?: HookMap;
  [key: string]: unknown;
}

const TOP_LEVEL_KEYS = new Set(['description', 'hooks']);
const OUR_COMMAND = /vdp\.js"?\s+hook\s+codex(\s|$)/;

function parseHooksFile(value: unknown): HooksFile {
  if (value === null) return {}; // a missing or empty file
  if (!isPlainObject(value)) throw new HookConfigError('hooks.json is not a JSON object');
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new HookConfigError(
      `hooks.json has keys Codex does not accept (${unknown.join(', ')}); only "description" and "hooks" are allowed`,
    );
  }
  validateHookMap(value.hooks, 'hooks.json');
  return value as HooksFile;
}

export function buildCodexGroup(entryPath: string, arg: string): HookGroup {
  return {
    hooks: [
      {
        type: 'command',
        command: hookCommand(entryPath, 'codex', arg),
        timeout: CODEX_HOOK_TIMEOUT_SEC,
      },
    ],
  };
}

function rules(entryPath = ''): HookOwnership {
  return {
    file: 'hooks.json',
    isOurCommand: (command) => OUR_COMMAND.test(command),
    groups: () =>
      CODEX_HOOK_EVENTS.map((e) => ({ event: e.name, group: buildCodexGroup(entryPath, e.arg) })),
  };
}

export interface CodexInstallerOptions {
  /** Codex's home directory (CODEX_HOME, else ~/.codex). */
  home?: string;
  findExecutable?: () => string | null;
  probeVersion?: (executable: string) => string | undefined;
  now?: () => Date;
}

export class CodexInstaller implements ProviderInstaller {
  readonly provider = 'codex' as const;
  readonly hooksPath: string;
  private readonly home: string;
  private readonly file: SharedJsonFile<HooksFile>;
  private readonly find: () => string | null;
  private readonly version: (executable: string) => string | undefined;

  constructor(options: CodexInstallerOptions = {}) {
    this.home = options.home ?? codexHome();
    this.hooksPath = join(this.home, 'hooks.json');
    this.file = new SharedJsonFile(this.hooksPath, parseHooksFile, options.now);
    this.find = options.findExecutable ?? (() => findExecutable('codex'));
    this.version = options.probeVersion ?? ((exe) => probeVersion(exe));
  }

  locations(): string[] {
    return [this.hooksPath];
  }

  async detect(): Promise<Detection> {
    const executable = this.find();
    if (executable) return { status: 'ready', version: this.version(executable) };
    if (this.file.dirHasForeignEntries()) return { status: 'ready' };
    return {
      status: 'absent',
      reason: `no \`codex\` executable on PATH and no Codex data in ${this.home}`,
    };
  }

  async install(context: InstallContext): Promise<InstallResult> {
    const snapshot = this.file.read();
    const hooks = mergeOwnedHooks(snapshot.value.hooks, rules(context.entryPath));
    const outcome = this.file.write(snapshot, { ...snapshot.value, hooks });
    return {
      ...outcome,
      registered: CODEX_HOOK_EVENTS.map((e) => e.name),
      notes: [CODEX_TRUST_NOTE],
    };
  }

  async inspect(): Promise<HookInventory> {
    const expected = CODEX_HOOK_EVENTS.length;
    try {
      return { present: countOwnedEvents(this.file.read().value.hooks, rules()), expected };
    } catch (err) {
      return { present: 0, expected, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async uninstall(): Promise<UninstallResult> {
    let snapshot;
    let stripped;
    try {
      snapshot = this.file.read();
      stripped = stripOwnedHooks(snapshot.value.hooks, rules());
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { removed: 0, backups: [], surviving: [{ location: this.hooksPath, reason }] };
    }
    if (stripped.removed === 0) return { removed: 0, backups: [], surviving: [] };
    const next: HooksFile = { ...snapshot.value };
    if (stripped.hooks) next.hooks = stripped.hooks;
    else delete next.hooks;
    // A file holding nothing but our hooks goes away with them.
    const { backups } = this.file.write(snapshot, next, { removeIfEmpty: true });
    return { removed: stripped.removed, backups, surviving: [] };
  }
}
