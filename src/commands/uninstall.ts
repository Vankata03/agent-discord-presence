/**
 * `vdp uninstall`
 *
 * Removes our hook entries (other hooks preserved), restores a clean
 * settings.json, and stops the running daemon — with the hooks gone it has
 * nothing left to do. Config and markers are kept, so a reinstall keeps the
 * user's theme.
 *
 * `vdp uninstall --purge` goes further: it also deletes all vdp data
 * (~/.claude/discord-presence). Settings backups (*.bak) are intentionally left
 * behind as a safety net.
 */
import { rm } from 'node:fs/promises';
import { presenceDir } from '../core/paths';
import { readSettings, stripOurHooks, writeSettings } from '../core/settings';
import { DaemonState } from '../core/daemon-state';
import { ui } from '../ui';

export async function uninstall(args: string[] = []): Promise<void> {
  const purge = args.includes('--purge') || args.includes('--all');

  // Remove hooks first so a stray in-session event can't respawn the daemon
  // after we stop it.
  const settings = await readSettings();
  const { cleaned, removed } = stripOurHooks(settings);
  await writeSettings(cleaned);

  console.log(`${ui.check} ${ui.bold('vibecoder-discord-presence uninstalled')}`);
  console.log(
    ui.dim(`  removed ${removed} hook ${removed === 1 ? 'entry' : 'entries'} from settings.json`),
  );

  // Always stop the daemon — there are no hooks left to feed it.
  const stopped = await new DaemonState(presenceDir()).stop();
  console.log(ui.dim(stopped ? `  stopped daemon (pid ${stopped})` : '  daemon not running'));

  if (!purge) {
    console.log(ui.dim('  (config kept; run `vdp uninstall --purge` to also delete all vdp data)'));
    return;
  }

  await rm(presenceDir(), { recursive: true, force: true });
  console.log(ui.dim(`  deleted ${presenceDir()}`));
  console.log(
    `\n${ui.check} ${ui.bold('fully purged')} ${ui.dim('— settings backups (*.bak) were left as a safety net.')}`,
  );
}
