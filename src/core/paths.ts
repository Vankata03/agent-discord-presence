/**
 * Central place for every filesystem path the tool uses.
 * Honors CLAUDE_CONFIG_DIR so it tracks Claude Code's own config location.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to our CLI entry (dist/vdp.js) — what we register in hook
 * commands and spawn for the daemon.
 *
 * We resolve it as the sibling `vdp.js` of the current module rather than
 * `import.meta.url` directly: with code-splitting this module may live in a
 * hash-named chunk, but the executable entry is always `vdp.js` next to it.
 */
export function entryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'vdp.js');
}

/** Claude Code's config directory (~/.claude unless overridden). */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Codex's home directory (~/.codex unless CODEX_HOME overrides it). */
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Gemini CLI's user config directory. GEMINI_CLI_HOME replaces the home
 * directory it lives in, not the directory itself: `<home>/.gemini`.
 */
export function geminiDir(): string {
  return path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

/** Claude Code's settings file we add hooks to. */
export function settingsPath(): string {
  return path.join(claudeDir(), 'settings.json');
}

/** Our own working directory under the Claude config dir. */
export function presenceDir(): string {
  return path.join(claudeDir(), 'discord-presence');
}

/** User config file (theme + overrides). */
export function configPath(): string {
  return path.join(presenceDir(), 'config.json');
}

/** Aggregated activity the daemon reads. */
export function statePath(): string {
  return path.join(presenceDir(), 'state.json');
}

/** Singleton lock so only one daemon runs. */
export function lockPath(): string {
  return path.join(presenceDir(), 'daemon.lock');
}

/** Per-session marker files (one per live Claude Code session). */
export function sessionsDir(): string {
  return path.join(presenceDir(), 'sessions');
}
