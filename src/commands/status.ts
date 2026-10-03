/**
 * `vdp status`
 *
 * The primary troubleshooting command. Reports, with no side effects:
 *   - which coding tools have our hooks registered, and how completely,
 *   - whether a Discord application id is configured,
 *   - whether the daemon is running (live lock pid),
 *   - the Discord connection state (from the daemon's status file),
 *   - how many coding sessions are currently live.
 */
import { presenceDir } from '../core/paths';
import { UserConfigFile } from '../core/user-config';
import { defaultInstallers } from '../provider/installer';
import { PROVIDER_DISPLAY_NAMES } from '../types';
import { DAEMON_STATUS_STALE_MS, DaemonState, isProcessAlive } from '../core/daemon-state';
import { SessionStore } from '../core/session-store';
import { ui } from '../ui';

const mark = (b: boolean): string => (b ? ui.check : ui.cross);

export async function status(_args: string[] = []): Promise<void> {
  const root = presenceDir();

  // Hooks installed, per coding tool (only tools with something to report).
  const hooks = (
    await Promise.all(
      (await defaultInstallers()).map(async (i) => ({
        provider: i.provider,
        ...(await i.inspect()),
      })),
    )
  ).filter((h) => h.present > 0 || h.error);

  // Discord application id configured?
  const clientId = new UserConfigFile(root).load().clientId;
  const clientIdOk = clientId.length > 0;

  // Daemon running?
  const daemon = new DaemonState(root);
  const lock = daemon.readLock();
  const daemonRunning = lock !== null && isProcessAlive(lock.pid);

  // Discord connection + reported sessions (from the daemon's status file).
  const now = Date.now();
  const ds = daemon.readStatus();
  const dsFresh = ds !== null && now - ds.updatedAt <= DAEMON_STATUS_STALE_MS;
  const discordConnected = dsFresh && ds.connected;

  // Live sessions (independent of the daemon — read straight from markers).
  const live = new SessionStore(root).snapshot(now);
  const sessionCount = live?.sessionCount ?? 0;

  console.log(`${ui.title('vibecoder-discord-presence')} ${ui.dim('— status')}\n`);
  if (hooks.length === 0) {
    console.log(`  ${ui.cross} hooks installed   ${ui.warn('(none — run `vdp install`)')}`);
  }
  for (const h of hooks) {
    const ok = !h.error && h.present === h.expected;
    const detail = h.error
      ? ui.warn(`(${h.error})`)
      : ok
        ? ui.dim(`(${h.present}/${h.expected})`)
        : ui.warn(`(${h.present}/${h.expected} — run \`vdp install\`)`);
    const label = `${PROVIDER_DISPLAY_NAMES[h.provider]} hooks`.padEnd(18);
    console.log(`  ${mark(ok)} ${label}${detail}`);
  }
  console.log(
    `  ${mark(clientIdOk)} Discord app id    ${
      clientIdOk
        ? ui.dim('(configured)')
        : ui.warn('(not set — set VDP_DISCORD_CLIENT_ID or clientId in config.json)')
    }`,
  );
  console.log(
    `  ${mark(daemonRunning)} daemon running    ${
      daemonRunning ? ui.dim(`(pid ${lock?.pid})`) : ui.dim('(not running)')
    }`,
  );
  console.log(
    `  ${mark(discordConnected)} Discord connected ${
      discordConnected
        ? ''
        : ui.dim(dsFresh ? '(Discord not reachable)' : '(unknown — daemon idle)')
    }`,
  );
  console.log(`  ${ui.bullet} live sessions     ${ui.bold(String(sessionCount))}`);
  if (live?.activity) console.log(`  ${ui.bullet} current activity  ${ui.accent(live.activity)}`);
}
