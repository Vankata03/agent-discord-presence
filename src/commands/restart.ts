/**
 * `vdp restart`
 *
 * Stops the running daemon (if any) and spawns a fresh one. Most useful after an
 * update: the daemon loads its code at spawn time, so a running daemon keeps the
 * old build until restarted (config changes hot-reload, but code doesn't).
 */
import { DaemonState, isProcessAlive, spawnDaemon } from '../core/daemon-state';
import { presenceDir } from '../core/paths';
import { ui } from '../ui';

export async function restart(_args: string[] = []): Promise<void> {
  const daemon = new DaemonState(presenceDir());
  const old = await daemon.stop();
  if (old) console.log(ui.dim(`  stopped daemon (pid ${old})`));

  spawnDaemon();

  // Give the fresh daemon a moment to acquire the lock, then report its pid.
  await new Promise((r) => setTimeout(r, 1000));
  const lock = daemon.readLock();
  if (lock && isProcessAlive(lock.pid)) {
    console.log(`${ui.check} ${ui.bold('daemon restarted')} ${ui.dim(`(pid ${lock.pid})`)}`);
  } else {
    // It spawns detached; if no session is live it may have already idle-exited.
    console.log(`${ui.check} ${ui.bold('daemon restart triggered')}`);
    console.log(ui.dim('  (it shows a card once a Claude Code session is active)'));
  }
}
