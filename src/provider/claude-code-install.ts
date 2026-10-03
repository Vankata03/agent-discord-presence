/**
 * Claude Code installer adapter.
 *
 * Claude Code reads hooks from the user's shared settings.json, so this adapter
 * edits a file other tools and the user also own. It therefore:
 *   - fails without writing when the file is malformed or an entry mixes our
 *     command with a foreign one (see core/settings.ts for ownership rules);
 *   - writes only when the merged result differs, and backs up the original
 *     bytes of a non-empty file first;
 *   - edits the file's text in place (core/json-text.ts), so every setting it
 *     did not change keeps its exact bytes.
 *
 * Detection is `ready` when the `claude` executable resolves, or when the
 * config dir shows Claude Code has run (the IDE and desktop builds bundle their
 * own binary and may leave nothing on PATH). VDP's own data dir and settings
 * backups don't count, so a previous install alone never makes it look ready.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findExecutable, probeVersion } from '../core/executable';
import { writeTextAtomic } from '../core/json-file';
import { formatJson, rewriteJson } from '../core/json-text';
import { claudeDir } from '../core/paths';
import {
  HOOK_EVENTS,
  mergeHooks,
  parseSettings,
  stripOurHooks,
  type Settings,
} from '../core/settings';
import type {
  Detection,
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

interface SettingsFile {
  /** Original bytes, or null when the file does not exist. */
  bytes: Buffer | null;
  raw: string;
  settings: Settings;
}

export class ClaudeCodeInstaller implements ProviderInstaller {
  readonly provider = 'claude-code' as const;
  readonly settingsPath: string;
  private readonly configDir: string;
  private readonly find: () => string | null;
  private readonly version: (executable: string) => string | undefined;
  private readonly now: () => Date;

  constructor(options: ClaudeCodeInstallerOptions = {}) {
    this.configDir = options.configDir ?? claudeDir();
    this.settingsPath = join(this.configDir, 'settings.json');
    this.find =
      options.findExecutable ??
      (() => findExecutable('claude', [join(this.configDir, 'local', 'claude')]));
    this.version = options.probeVersion ?? ((exe) => probeVersion(exe));
    this.now = options.now ?? (() => new Date());
  }

  locations(): string[] {
    return [this.settingsPath];
  }

  async detect(): Promise<Detection> {
    const executable = this.find();
    if (executable) return { status: 'ready', version: this.version(executable) };
    if (this.hasBeenUsed()) return { status: 'ready' };
    return {
      status: 'absent',
      reason: `no \`claude\` executable on PATH and no Claude Code data in ${this.configDir}`,
    };
  }

  async install(context: InstallContext): Promise<InstallResult> {
    const file = this.read();
    const merged = mergeHooks(file.settings, context.entryPath);
    const registered = HOOK_EVENTS.map((e) => e.name);
    const written = this.write(file, merged);
    return { ...written, registered };
  }

  async uninstall(): Promise<UninstallResult> {
    let file: SettingsFile;
    let cleaned: Settings;
    let removed: number;
    try {
      file = this.read();
      ({ cleaned, removed } = stripOurHooks(file.settings));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { removed: 0, backups: [], surviving: [{ location: this.settingsPath, reason }] };
    }
    if (removed === 0) return { removed: 0, backups: [], surviving: [] };
    const { backups } = this.write(file, cleaned);
    return { removed, backups, surviving: [] };
  }

  /** Claude Code has run here: the config dir holds something besides VDP's own files. */
  private hasBeenUsed(): boolean {
    try {
      return readdirSync(this.configDir).some(
        (name) =>
          name !== 'discord-presence' &&
          !/^settings\.json\..*\.bak$/.test(name) &&
          !name.endsWith('.tmp'),
      );
    } catch {
      return false;
    }
  }

  /** Read and validate settings.json. Throws on unreadable or malformed content. */
  private read(): SettingsFile {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.settingsPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { bytes: null, raw: '', settings: {} };
      }
      throw err;
    }
    const raw = bytes.toString('utf8');
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    let parsed: unknown;
    try {
      parsed = body.trim() === '' ? {} : JSON.parse(body);
    } catch (err) {
      throw new Error(`settings.json is not valid JSON (${(err as Error).message})`);
    }
    return { bytes, raw, settings: parseSettings(parsed) };
  }

  /** Write `next` if it changes the file, backing up non-empty originals first. */
  private write(file: SettingsFile, next: Settings): { written: string[]; backups: string[] } {
    const text = file.bytes ? rewriteJson(file.raw, file.settings, next) : formatJson(next);
    if (file.bytes && text === file.raw) return { written: [], backups: [] };
    const backups =
      file.bytes && Object.keys(file.settings).length > 0 ? [this.backup(file.bytes)] : [];
    writeTextAtomic(this.settingsPath, text);
    return { written: [this.settingsPath], backups };
  }

  /** Copy the original bytes aside; never overwrite an earlier backup. */
  private backup(bytes: Buffer): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    for (let n = 0; ; n++) {
      const path = `${this.settingsPath}.${stamp}${n === 0 ? '' : `-${n}`}.bak`;
      try {
        writeFileSync(path, bytes, { flag: 'wx' });
        return path;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }
}
