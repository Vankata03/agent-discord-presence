/**
 * User config: the user's saved theme choice, optional slot overrides and
 * optional Discord application id, stored as config.json under the presence
 * directory.
 *
 * `load()` returns the file resolved for use: the active theme (built-in plus
 * overrides) and the client id. Anything missing or invalid falls back to
 * DEFAULT_CONFIG (the privacy-safe `minimal` theme) so the daemon always has
 * something sane to render. `save()` writes atomically because the daemon
 * hot-reads this file every tick and must never see a half-written one.
 *
 * Overrides are merged shallowly: providing `largeImage` in overrides replaces
 * the whole slot, it does not deep-merge individual fields. That keeps the model
 * obvious — a key you set wins outright.
 */
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './json-file';
import { DEFAULT_THEME, THEMES } from '../themes/index';
import type { Theme, UserConfig } from '../types';

/** What a brand-new install runs with until the user changes anything. */
export const DEFAULT_CONFIG: UserConfig = {
  theme: DEFAULT_THEME as UserConfig['theme'],
  overrides: {},
};

/**
 * Discord application id the presence is published under. The image asset keys
 * the themes reference (`logo`, `status-editing`, …) live on this application.
 *
 * This is the shared "ClaudeCode" application every install publishes under by
 * default. A client id is a public identifier, not a secret. Override per-machine
 * with the VDP_DISCORD_CLIENT_ID env var or a `clientId` field in config.json.
 */
export const DEFAULT_CLIENT_ID = '1511730102499541123';

/** The config file as the rest of the tool consumes it. */
export interface ResolvedConfig {
  /** The parsed file, shallow-validated, defaults filled in. */
  config: UserConfig;
  /** Base theme with the user's overrides applied. */
  theme: Theme;
  /** Which Discord application to publish under (env > config > default). */
  clientId: string;
}

/** Resolve the effective theme (base theme + overrides) from a parsed config. */
export function resolveTheme(config: UserConfig): Theme {
  const base = THEMES[config.theme] ?? THEMES[DEFAULT_THEME];
  return { ...base, ...(config.overrides ?? {}) } as Theme;
}

function resolveClientId(config: UserConfig): string {
  return process.env.VDP_DISCORD_CLIENT_ID || config.clientId || DEFAULT_CLIENT_ID;
}

function validate(parsed: unknown): UserConfig {
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_CONFIG;
  const p = parsed as Partial<UserConfig>;
  return {
    theme: typeof p.theme === 'string' ? (p.theme as UserConfig['theme']) : DEFAULT_CONFIG.theme,
    overrides: typeof p.overrides === 'object' && p.overrides !== null ? p.overrides : {},
    clientId: typeof p.clientId === 'string' ? p.clientId : undefined,
  };
}

export class UserConfigFile {
  readonly path: string;

  /** `root` is the presence directory, the same one the session store uses. */
  constructor(root: string) {
    this.path = join(root, 'config.json');
  }

  load(): ResolvedConfig {
    const config = validate(readJson(this.path));
    return { config, theme: resolveTheme(config), clientId: resolveClientId(config) };
  }

  save(config: UserConfig): void {
    writeJsonAtomic(this.path, config, { pretty: true });
  }
}
