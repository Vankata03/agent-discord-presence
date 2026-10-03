/**
 * `vdp uninstall`
 *
 * Asks every provider adapter to remove VDP's integration (other hooks and
 * settings preserved), even for tools whose executable is already gone, and
 * only then stops the daemon — with the hooks gone it has nothing left to do.
 * Config and markers are kept, so a reinstall keeps the user's theme.
 *
 * `vdp uninstall --purge` goes further: once every cleanup has succeeded it
 * also deletes all vdp data (~/.claude/discord-presence). If any cleanup
 * failed, purge is refused and the data kept, so surviving hooks never point
 * at deleted data. Settings backups (*.bak) are intentionally left behind as a
 * safety net. Incomplete cleanup exits with code 1.
 */
import { rm } from 'node:fs/promises';
import { presenceDir } from '../core/paths';
import { DaemonState } from '../core/daemon-state';
import { defaultInstallers, uninstallProviders } from '../provider/installer';
import { PROVIDER_DISPLAY_NAMES } from '../types';
import { ui } from '../ui';

export async function uninstall(args: string[] = []): Promise<void> {
  const purge = args.includes('--purge') || args.includes('--all');
  const root = presenceDir();

  const report = await uninstallProviders(await defaultInstallers(), {
    stopDaemon: () => new DaemonState(root).stop(),
    purge: purge ? () => rm(root, { recursive: true, force: true }) : undefined,
  });

  const cleanedUp = report.providers.every((p) => p.ok);
  console.log(
    cleanedUp
      ? `${ui.check} ${ui.bold('vibecoder-discord-presence uninstalled')}`
      : `${ui.cross} ${ui.bold('vibecoder-discord-presence uninstall incomplete')}`,
  );
  for (const p of report.providers) {
    const name = PROVIDER_DISPLAY_NAMES[p.provider];
    const entries = `${p.removed} hook ${p.removed === 1 ? 'entry' : 'entries'}`;
    console.log(`  ${p.ok ? ui.check : ui.cross} ${name} ${ui.dim(`— removed ${entries}`)}`);
    for (const path of p.backups) console.log(`      ${ui.dim('backup:')} ${ui.accent(path)}`);
    for (const s of p.surviving) {
      console.log(
        `      ${ui.err('still present:')} ${ui.accent(s.location)} ${ui.dim(`(${s.reason})`)}`,
      );
    }
  }

  // The daemon is always stopped — even after incomplete cleanup.
  console.log(
    ui.dim(
      report.stoppedPid ? `  stopped daemon (pid ${report.stoppedPid})` : '  daemon not running',
    ),
  );

  switch (report.purge) {
    case 'not-requested':
      console.log(
        ui.dim('  (config kept; run `vdp uninstall --purge` to also delete all vdp data)'),
      );
      break;
    case 'refused':
      console.log(
        ui.warn(`  purge refused: fix the cleanup above and rerun; vdp data kept in ${root}`),
      );
      break;
    case 'failed':
      console.log(ui.err(`  purge failed: ${report.purgeError}`));
      break;
    case 'done':
      console.log(ui.dim(`  deleted ${root}`));
      console.log(
        `\n${ui.check} ${ui.bold('fully purged')} ${ui.dim('— settings backups (*.bak) were left as a safety net.')}`,
      );
      break;
  }
  if (!report.ok) process.exitCode = 1;
}
