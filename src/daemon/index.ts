/**
 * Background daemon: lifecycle only.
 *
 * Singleton (guarded by the lockfile). Owns the Discord connection, installs
 * the signal and crash handlers, and loops `tick → sleep` until the reconcile
 * tick (see ./reconcile) says the idle grace has elapsed. Every decision about
 * what to show lives in the tick; this file only wires the production
 * dependencies together.
 *
 * It's spawned detached by the SessionStart hook, so there's no console to talk
 * to; health is surfaced through the status file (see core/daemon-state) which
 * `vdp status` reads.
 */
import { DaemonState } from '../core/daemon-state';
import { presenceDir } from '../core/paths';
import { SessionStore } from '../core/session-store';
import { UserConfigFile } from '../core/user-config';
import { readTranscriptMeta } from '../provider/transcript';
import { DiscordPresence } from './discord';
import { createReconcileTick } from './reconcile';

/** How often we reconcile markers -> Discord. */
const TICK_MS = 15 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startDaemon(_args: string[] = []): Promise<void> {
  const root = presenceDir();
  const daemon = new DaemonState(root);
  if (!daemon.acquireLock(Date.now())) return; // another daemon already owns the lock

  // The Discord app id is fixed for the connection's lifetime (changing it needs
  // a reconnect), so resolve it once. The theme, by contrast, is re-read every
  // tick so `vdp config` edits apply to the live card without a restart.
  const userConfig = new UserConfigFile(root);
  const discord = new DiscordPresence(userConfig.load().clientId);
  const tick = createReconcileTick({
    store: new SessionStore(root),
    loadConfig: () => userConfig.load(),
    enrich: (state) => readTranscriptMeta(state.enrichmentRef),
    sink: discord,
    writeStatus: (status) => daemon.writeStatus(status),
    pid: process.pid,
  });

  let running = true;
  const shutdown = async (): Promise<void> => {
    running = false;
    await discord.clearActivity();
    await discord.destroy();
    daemon.clearStatus();
    daemon.releaseLock();
  };

  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('exit', () => daemon.releaseLock()); // last-ditch synchronous cleanup

  // Backstop: the discord-rpc IPC transport can let a socket 'error' (rejected
  // handshake, ECONNRESET) go unhandled during the connect window before our
  // own listener is attached — that would crash the daemon. A background
  // presence daemon must survive a flaky Discord connection, so swallow known
  // connection errors and let the loop reconnect. Anything else is a real
  // fault: shut down cleanly rather than keep running in a bad state.
  const RECOVERABLE = new Set([
    'ECONNRESET',
    'EPIPE',
    'ECONNREFUSED',
    'ENOENT',
    'EBADF',
    'ERR_STREAM_DESTROYED',
  ]);
  process.on('uncaughtException', (err) => {
    if (RECOVERABLE.has((err as NodeJS.ErrnoException).code ?? '')) return;
    void shutdown().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', () => {
    // In-flight RPC rejections are already handled by the Discord layer.
  });

  while (running) {
    if ((await tick(Date.now())) === 'idle-exit') break;
    await sleep(TICK_MS);
  }

  await shutdown();
}
