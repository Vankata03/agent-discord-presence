/**
 * OpenCode detection: whether the installed runtime offers the global-plugin
 * contract VDP's OpenCode provider is built on.
 *
 * Verified against OpenCode 1.18.34, with 1.0.223, 1.15.10 and 1.15.11 probed
 * for the boundaries below (test/fixtures/opencode/README.md). Detection never
 * writes anything, including OpenCode's config directory:
 *   - `absent` when no `opencode` executable resolves on PATH;
 *   - `unsupported` when `opencode --version` reports no release version, or
 *     reports one before 1.15.11. Older runtimes never call a plugin's
 *     `dispose`, so `opencode run` exits with presence events still queued:
 *     1.15.10 lost the session's idle events on every normal exit. Nothing on
 *     the command line reveals that capability, so the boundary is a version;
 *   - `unsupported` when `opencode debug paths` cannot name the global config
 *     directory, whose `plugins/` folder OpenCode auto-discovers;
 *   - `ready` otherwise, with the version.
 */
import { findExecutable, probeOutput, probeVersion } from '../core/executable';
import type { Detection } from './installer';

/** The first OpenCode release that awaits plugin `dispose` before exiting. */
export const MIN_OPENCODE_VERSION = '1.15.11';

/** A release version: `1.18.34`. Snapshot and dev builds print `0.0.0-<channel>-<stamp>`. */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Negative, zero or positive as release `a` is older than, equal to or newer than `b`. */
function compareRelease(a: RegExpExecArray, b: RegExpExecArray): number {
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The global config directory from `opencode debug paths`, which prints one
 * `<key padded to 10> <path>` line per OpenCode path, e.g.
 * `config     /home/me/.config/opencode`.
 */
export function parseConfigDir(debugPaths: string): string | undefined {
  return /^config[ \t]+(\S.*?)[ \t]*\r?$/m.exec(debugPaths)?.[1];
}

export interface OpenCodeDetectOptions {
  findExecutable?: () => string | null;
  probeVersion?: (executable: string) => string | undefined;
  /** stdout of `opencode debug paths`, or undefined when it could not be run. */
  probePaths?: (executable: string) => string | undefined;
}

export async function detectOpenCode(options: OpenCodeDetectOptions = {}): Promise<Detection> {
  const executable = (options.findExecutable ?? (() => findExecutable('opencode')))();
  if (!executable) return { status: 'absent', reason: 'no `opencode` executable on PATH' };

  const version = (options.probeVersion ?? ((exe) => probeVersion(exe, 10_000)))(executable);
  if (!version) {
    return {
      status: 'unsupported',
      reason: 'could not read the OpenCode version (`opencode --version`)',
    };
  }
  const release = RELEASE.exec(version);
  const floor = RELEASE.exec(MIN_OPENCODE_VERSION);
  if (!release || !floor) {
    return {
      status: 'unsupported',
      version,
      reason: `OpenCode ${version} is a pre-release build whose plugin contract VDP cannot confirm; use a release`,
    };
  }
  if (compareRelease(release, floor) < 0) {
    return {
      status: 'unsupported',
      version,
      reason: `OpenCode ${version} exits without waiting for plugins to finish, which loses presence updates; upgrade to ${MIN_OPENCODE_VERSION} or newer`,
    };
  }

  const paths = (options.probePaths ?? ((exe) => probeOutput(exe, ['debug', 'paths'], 10_000)))(
    executable,
  );
  if (paths === undefined || !parseConfigDir(paths)) {
    return {
      status: 'unsupported',
      version,
      reason: 'could not find the OpenCode global config directory (`opencode debug paths`)',
    };
  }
  return { status: 'ready', version };
}
