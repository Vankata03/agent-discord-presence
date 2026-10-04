/**
 * OpenCode installer adapter.
 *
 * VDP installs one dedicated, self-contained plugin file into OpenCode's
 * global `plugins/` directory, which OpenCode auto-discovers for every
 * project (opencode-plugin.ts). It never edits `opencode.json`, the user's
 * `plugin` array, project `.opencode/` directories, OpenCode's storage, or
 * anything else OpenCode writes into its config directory.
 *
 * The file is VDP's alone: its first line is a stable ownership header, and
 * VDP replaces or deletes the file only when that header is present. A file
 * of the same name without it is someone else's, so install fails without
 * writing and uninstall leaves it alone.
 *
 * Install takes the config directory from `opencode debug paths`, which
 * detection already required. Uninstall must work after OpenCode itself is
 * gone, so it also inspects the default location (`$XDG_CONFIG_HOME/opencode`,
 * else `~/.config/opencode`).
 *
 * The plugin starts `vdp hook opencode` with a fixed argument vector: the
 * absolute path of the Node.js running this install, then the VDP entry. No
 * shell is involved, so neither path needs quoting.
 *
 * Detection is opencode-detect.ts: ready only when the runtime offers the
 * global-plugin contract.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findExecutable, probeOutput } from '../core/executable';
import { writeTextAtomic } from '../core/json-file';
import { openCodeConfigDir } from '../core/paths';
import { detectOpenCode, parseConfigDir, type OpenCodeDetectOptions } from './opencode-detect';
import { isOwnedPlugin, OPENCODE_PLUGIN_FILE, renderOpenCodePlugin } from './opencode-plugin';
import type {
  Detection,
  HookInventory,
  InstallContext,
  InstallResult,
  ProviderInstaller,
  UninstallResult,
} from './installer';

export const OPENCODE_RESTART_NOTE =
  'OpenCode loads plugins at startup, so restart any OpenCode that is already running.';

export interface OpenCodeInstallerOptions extends OpenCodeDetectOptions {
  /** OpenCode's default global config directory, for when OpenCode can't say. */
  defaultConfigDir?: string;
  /** The Node.js executable the plugin starts VDP with. */
  nodePath?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** File content, or null when there is no file. Other read errors are thrown. */
function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class OpenCodeInstaller implements ProviderInstaller {
  readonly provider = 'opencode' as const;
  private probedDir: string | null | undefined;

  constructor(private readonly options: OpenCodeInstallerOptions = {}) {}

  /** The global config directory the installed OpenCode reports, if it can say. */
  private reportedConfigDir(): string | undefined {
    if (this.probedDir === undefined) {
      const executable = (this.options.findExecutable ?? (() => findExecutable('opencode')))();
      const paths = executable
        ? (this.options.probePaths ?? ((exe) => probeOutput(exe, ['debug', 'paths'], 10_000)))(
            executable,
          )
        : undefined;
      this.probedDir = (paths !== undefined && parseConfigDir(paths)) || null;
    }
    return this.probedDir ?? undefined;
  }

  /** Every place a VDP plugin may live: the reported directory and the default one. */
  private pluginPaths(): string[] {
    const dirs = [this.reportedConfigDir(), this.options.defaultConfigDir ?? openCodeConfigDir()];
    const paths = dirs
      .filter((dir): dir is string => dir !== undefined)
      .map((dir) => join(dir, 'plugins', OPENCODE_PLUGIN_FILE));
    return [...new Set(paths)];
  }

  locations(): string[] {
    return this.pluginPaths();
  }

  detect(): Promise<Detection> {
    return detectOpenCode(this.options);
  }

  async install(context: InstallContext): Promise<InstallResult> {
    const dir = this.reportedConfigDir();
    if (!dir) {
      throw new Error(
        'could not find the OpenCode global config directory (`opencode debug paths`)',
      );
    }
    const path = join(dir, 'plugins', OPENCODE_PLUGIN_FILE);
    const content = renderOpenCodePlugin({
      command: [this.options.nodePath ?? process.execPath, context.entryPath, 'hook', 'opencode'],
    });
    const existing = readIfExists(path);
    if (existing !== null && !isOwnedPlugin(existing)) {
      throw new Error(
        `${path} exists and was not created by vdp; move it away and run vdp install again`,
      );
    }
    const written = existing === content ? [] : (writeTextAtomic(path, content), [path]);
    return {
      written,
      backups: [],
      registered: [`global plugin ${OPENCODE_PLUGIN_FILE}`],
      notes: [OPENCODE_RESTART_NOTE],
    };
  }

  async inspect(): Promise<HookInventory> {
    try {
      const present = this.pluginPaths().some((path) => {
        const content = readIfExists(path);
        return content !== null && isOwnedPlugin(content);
      });
      return { present: present ? 1 : 0, expected: 1 };
    } catch (err) {
      return { present: 0, expected: 1, error: message(err) };
    }
  }

  async uninstall(): Promise<UninstallResult> {
    let removed = 0;
    const surviving: UninstallResult['surviving'] = [];
    for (const path of this.pluginPaths()) {
      try {
        const content = readIfExists(path);
        // Someone else's file of the same name is not ours to delete.
        if (content === null || !isOwnedPlugin(content)) continue;
        rmSync(path);
        removed++;
      } catch (err) {
        surviving.push({ location: path, reason: message(err) });
      }
    }
    return { removed, backups: [], surviving };
  }
}
