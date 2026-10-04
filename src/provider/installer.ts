/**
 * Provider installers: how `vdp install` and `vdp uninstall` reach every coding
 * tool without knowing any tool's configuration format.
 *
 * Each adapter owns its tool's executable discovery, capability probes,
 * configuration paths and shapes, backups, atomic writes and ownership rules.
 * This module only orchestrates them:
 *   - install detects every provider and installs only the ready ones, each in
 *     isolation, so one failure never undoes or skips another provider;
 *   - uninstall asks every adapter to clean up whether or not its tool is still
 *     present, then stops the daemon, then purges VDP data only if every
 *     cleanup succeeded (live hooks must never point at deleted data).
 */
import type { ProviderKey } from '../types';

export type Detection =
  | { status: 'ready'; version?: string }
  | { status: 'unsupported'; version?: string; reason: string }
  | { status: 'absent'; reason: string };

export interface InstallContext {
  /** Absolute path of the built CLI entry that hook commands run. */
  entryPath: string;
}

export interface InstallResult {
  /** Configuration files written; empty when everything was already current. */
  written: string[];
  /** Backups taken of non-empty shared files before they were changed. */
  backups: string[];
  /** Integration points registered (hook events, plugin names, …). */
  registered: string[];
  /** Follow-up the user must do in the tool itself (e.g. a trust review). */
  notes?: string[];
}

/** An owned artifact cleanup could not remove, or could not prove was removed. */
export interface SurvivingArtifact {
  location: string;
  reason: string;
}

export interface UninstallResult {
  /** Owned artifacts removed (hook entries, files, …). */
  removed: number;
  surviving: SurvivingArtifact[];
  backups: string[];
}

/** What `vdp status` shows for one provider: how many of our hooks are registered. */
export interface HookInventory {
  present: number;
  expected: number;
  /** Set when the configuration could not be read. */
  error?: string;
}

export interface ProviderInstaller {
  readonly provider: ProviderKey;
  /** Every location this adapter may own; reported if cleanup fails outright. */
  locations(): string[];
  detect(): Promise<Detection>;
  /** Called only after detect() reported ready. Throws on failure, without partial writes. */
  install(context: InstallContext): Promise<InstallResult>;
  /** Called regardless of detection; inspects every location this adapter may own. */
  uninstall(): Promise<UninstallResult>;
  /** Read-only count of our registered hooks, for `vdp status`. */
  inspect(): Promise<HookInventory>;
}

export type ProviderInstallReport =
  | { provider: ProviderKey; status: 'installed'; detection: Detection; result: InstallResult }
  | { provider: ProviderKey; status: 'absent' | 'unsupported'; detection: Detection }
  | { provider: ProviderKey; status: 'failed'; detection?: Detection; error: string };

export interface InstallReport {
  providers: ProviderInstallReport[];
  /** False when any ready provider (or its detection) failed. */
  ok: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function installProviders(
  installers: readonly ProviderInstaller[],
  context: InstallContext,
): Promise<InstallReport> {
  const providers: ProviderInstallReport[] = [];
  for (const installer of installers) {
    const { provider } = installer;
    let detection: Detection;
    try {
      detection = await installer.detect();
    } catch (err) {
      providers.push({ provider, status: 'failed', error: `detection failed: ${message(err)}` });
      continue;
    }
    if (detection.status !== 'ready') {
      providers.push({ provider, status: detection.status, detection });
      continue;
    }
    try {
      const result = await installer.install(context);
      providers.push({ provider, status: 'installed', detection, result });
    } catch (err) {
      providers.push({ provider, status: 'failed', detection, error: message(err) });
    }
  }
  return { providers, ok: providers.every((p) => p.status !== 'failed') };
}

export interface ProviderUninstallReport extends UninstallResult {
  provider: ProviderKey;
  /** True when every owned artifact is gone. */
  ok: boolean;
  error?: string;
}

export interface UninstallOptions {
  /** Stop the daemon; resolves to the stopped pid, or null if none ran. */
  stopDaemon: () => Promise<number | null>;
  /** Delete all VDP data. Omit to keep it. */
  purge?: () => Promise<void>;
}

export interface UninstallReport {
  providers: ProviderUninstallReport[];
  stoppedPid: number | null;
  purge: 'not-requested' | 'done' | 'refused' | 'failed';
  purgeError?: string;
  /** False when any cleanup (or a requested purge) did not complete. */
  ok: boolean;
}

export async function uninstallProviders(
  installers: readonly ProviderInstaller[],
  options: UninstallOptions,
): Promise<UninstallReport> {
  // Every cleanup runs before the daemon stops, so a stray hook event cannot
  // respawn it after we stop it.
  const providers: ProviderUninstallReport[] = [];
  for (const installer of installers) {
    const { provider } = installer;
    try {
      const result = await installer.uninstall();
      providers.push({ provider, ...result, ok: result.surviving.length === 0 });
    } catch (err) {
      const reason = message(err);
      providers.push({
        provider,
        removed: 0,
        backups: [],
        surviving: installer.locations().map((location) => ({ location, reason })),
        ok: false,
        error: reason,
      });
    }
  }
  const cleanedUp = providers.every((p) => p.ok);

  const stoppedPid = await options.stopDaemon();

  if (!options.purge) return { providers, stoppedPid, purge: 'not-requested', ok: cleanedUp };
  if (!cleanedUp) return { providers, stoppedPid, purge: 'refused', ok: false };
  try {
    await options.purge();
    return { providers, stoppedPid, purge: 'done', ok: true };
  } catch (err) {
    return { providers, stoppedPid, purge: 'failed', purgeError: message(err), ok: false };
  }
}

/** Every shipped provider adapter, in report order. */
export async function defaultInstallers(): Promise<ProviderInstaller[]> {
  const [
    { ClaudeCodeInstaller },
    { CodexInstaller },
    { GeminiCliInstaller },
    { OpenCodeInstaller },
  ] = await Promise.all([
    import('./claude-code-install'),
    import('./codex-install'),
    import('./gemini-cli-install'),
    import('./opencode-install'),
  ]);
  return [
    new ClaudeCodeInstaller(),
    new CodexInstaller(),
    new GeminiCliInstaller(),
    new OpenCodeInstaller(),
  ];
}
