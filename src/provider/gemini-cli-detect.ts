/**
 * Gemini CLI detection: whether the installed runtime offers the public
 * command-hook contract VDP's Gemini CLI provider is built on.
 *
 * Verified against Gemini CLI 0.62.0 (test/fixtures/gemini-cli/README.md).
 * Detection never writes configuration, and it asks the runtime for a
 * capability instead of enforcing a version floor:
 *   - `absent` when no `gemini` executable resolves on PATH;
 *   - `unsupported` when `gemini --help` cannot be run, or lists no `hooks`
 *     command (the command-hook API and `gemini hooks` shipped together), or
 *     when the user settings turn the whole hook system off
 *     (`hooksConfig.enabled: false`), since installed hooks would never run;
 *   - `ready` otherwise, with the version when `--version` reports one.
 *
 * Transcript support is not part of detection: a runtime whose hooks are
 * compatible stays ready even when its transcript format is not, and
 * enrichment then simply stays empty (gemini-cli-transcript.ts).
 */
import { join } from 'node:path';
import { findExecutable, probeOutput, probeVersion } from '../core/executable';
import { readJson } from '../core/json-file';
import { geminiDir } from '../core/paths';
import type { Detection } from './installer';

/** `gemini --help` lists one line per command, e.g. `  gemini hooks <command>  Manage …`. */
const HOOKS_COMMAND = /^\s*gemini hooks\b/m;

export interface GeminiCliDetectOptions {
  /** Gemini CLI's user config directory (GEMINI_CLI_HOME/.gemini, else ~/.gemini). */
  dir?: string;
  findExecutable?: () => string | null;
  probeVersion?: (executable: string) => string | undefined;
  /** stdout of `gemini --help`, or undefined when it could not be run. */
  probeHelp?: (executable: string) => string | undefined;
}

function hooksTurnedOff(settingsPath: string): boolean {
  // A missing or unparsable file (Gemini also accepts comments) does not say
  // hooks are off; the installer refuses to edit a file it cannot parse.
  const settings = readJson<{ hooksConfig?: { enabled?: unknown } }>(settingsPath);
  return settings?.hooksConfig?.enabled === false;
}

export async function detectGeminiCli(options: GeminiCliDetectOptions = {}): Promise<Detection> {
  const executable = (options.findExecutable ?? (() => findExecutable('gemini')))();
  if (!executable) return { status: 'absent', reason: 'no `gemini` executable on PATH' };

  const version = (options.probeVersion ?? ((exe) => probeVersion(exe, 10_000)))(executable);
  const known = version ? { version } : {};

  const help = (options.probeHelp ?? ((exe) => probeOutput(exe, ['--help'], 10_000)))(executable);
  if (help === undefined) {
    return {
      status: 'unsupported',
      ...known,
      reason: 'could not run `gemini --help` to confirm hook support',
    };
  }
  if (!HOOKS_COMMAND.test(help)) {
    return {
      status: 'unsupported',
      ...known,
      reason: 'this Gemini CLI has no command-hook support (no `gemini hooks` command); upgrade it',
    };
  }

  const settingsPath = join(options.dir ?? geminiDir(), 'settings.json');
  if (hooksTurnedOff(settingsPath)) {
    return {
      status: 'unsupported',
      ...known,
      reason: `hooks are turned off in ${settingsPath} (hooksConfig.enabled is false)`,
    };
  }
  return { status: 'ready', ...known };
}
