/**
 * Locating a coding tool's executable and asking it for its version.
 *
 * Provider installers use these to decide whether their tool is present before
 * touching its configuration. Both are best-effort and never throw: a missing
 * PATH, an unreadable directory or a hung `--version` just means "not found" or
 * "version unknown".
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function isExecutableFile(path: string, windows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!windows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `name` against PATH the way the shell would (honoring PATHEXT on
 * Windows), then fall back to `extraPaths`. Returns the first match.
 */
export function findExecutable(
  name: string,
  extraPaths: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const windows = platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = windows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate, windows)) return candidate;
    }
  }
  return extraPaths.find((p) => isExecutableFile(p, windows)) ?? null;
}

/**
 * Run `<executable> --version` and return the first semver-looking token of
 * its output, or undefined when it fails, times out or prints nothing usable.
 */
export function probeVersion(executable: string, timeoutMs = 5000): string | undefined {
  // Windows can only start .cmd/.bat shims through a shell; quote the path and
  // pass a single command string so no argument is ever shell-interpolated.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  try {
    const result = viaShell
      ? spawnSync(`"${executable}" --version`, {
          shell: true,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
        })
      : spawnSync(executable, ['--version'], {
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
        });
    if (result.status !== 0) return undefined;
    return /\d+\.\d+\.\d+[^\s)]*/.exec(`${result.stdout ?? ''}`)?.[0];
  } catch {
    return undefined;
  }
}
