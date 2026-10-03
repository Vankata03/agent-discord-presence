/**
 * Claude Code installer adapter.
 *
 * Claude Code reads hooks from the user's shared settings.json, so this adapter
 * edits a file other tools and the user also own through SharedJsonFile:
 * malformed files and ownership collisions fail without writing, the original
 * is backed up before a change, and untouched settings keep their exact bytes.
 * Ownership rules for the hook entries live in core/settings.ts.
 *
 * Detection is `ready` when the `claude` executable resolves, or when the
 * config dir shows Claude Code has run (the IDE and desktop builds bundle their
 * own binary and may leave nothing on PATH). VDP's own data dir and settings
 * backups don't count, so a previous install alone never makes it look ready.
 */
import { join } from 'node:path';
import { findExecutable, probeVersion } from '../core/executable';
import { claudeDir } from '../core/paths';
import {
  HOOK_EVENTS,
  countOurHooks,
  mergeHooks,
  parseSettings,
  stripOurHooks,
  type Settings,
} from '../core/settings';
import { SharedJsonFile } from '../core/shared-json-file';
import type {
  Detection,
  HookInventory,
  InstallContext,
  InstallResult,
  ProviderInstaller,
  UninstallResult,
} from './installer';

export interface ClaudeCodeInstallerOptions {
  /** Claude Code's config dir (CLAUDE_CONFIG_DIR, else ~/.claude). */
  configDir?: string;
  findExecutable?: () => string | null;
  probeVersion?: (executable: string) => string | undefined;
  now?: () => Date;
}

export class ClaudeCodeInstaller implements ProviderInstaller {
  readonly provider = 'claude-code' as const;
  readonly settingsPath: string;
  private readonly configDir: string;
  private readonly settings: SharedJsonFile<Settings>;
  private readonly find: () => string | null;
  private readonly version: (executable: string) => string | undefined;

  constructor(options: ClaudeCodeInstallerOptions = {}) {
    this.configDir = options.configDir ?? claudeDir();
    this.settingsPath = join(this.configDir, 'settings.json');
    this.settings = new SharedJsonFile(this.settingsPath, parseSettings, options.now);
    this.find =
      options.findExecutable ??
      (() => findExecutable('claude', [join(this.configDir, 'local', 'claude')]));
    this.version = options.probeVersion ?? ((exe) => probeVersion(exe));
  }

  locations(): string[] {
    return [this.settingsPath];
  }

  async detect(): Promise<Detection> {
    const executable = this.find();
    if (executable) return { status: 'ready', version: this.version(executable) };
    if (this.settings.dirHasForeignEntries(['discord-presence'])) return { status: 'ready' };
    return {
      status: 'absent',
      reason: `no \`claude\` executable on PATH and no Claude Code data in ${this.configDir}`,
    };
  }

  async install(context: InstallContext): Promise<InstallResult> {
    const snapshot = this.settings.read();
    const merged = mergeHooks(snapshot.value, context.entryPath);
    const outcome = this.settings.write(snapshot, merged);
    return { ...outcome, registered: HOOK_EVENTS.map((e) => e.name) };
  }

  async inspect(): Promise<HookInventory> {
    const expected = HOOK_EVENTS.length;
    try {
      return { present: countOurHooks(this.settings.read().value), expected };
    } catch (err) {
      return { present: 0, expected, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async uninstall(): Promise<UninstallResult> {
    let snapshot;
    let stripped;
    try {
      snapshot = this.settings.read();
      stripped = stripOurHooks(snapshot.value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { removed: 0, backups: [], surviving: [{ location: this.settingsPath, reason }] };
    }
    const { cleaned, removed } = stripped;
    if (removed === 0) return { removed: 0, backups: [], surviving: [] };
    const { backups } = this.settings.write(snapshot, cleaned);
    return { removed, backups, surviving: [] };
  }
}
