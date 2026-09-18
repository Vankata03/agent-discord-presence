/**
 * `vdp status`
 *
 * The primary troubleshooting command. Reports, with no side effects:
 *   - whether our hooks are installed in settings.json,
 *   - whether a Discord application id is configured,
 *   - whether the daemon is running (live lock pid),
 *   - the Discord connection state (from the daemon's status file),
 *   - how many Claude Code sessions are currently live.
 */
import { presenceDir } from '../core/paths';
import { UserConfigFile } from '../core/user-config';
import { HOOK_EVENTS, isOurEntry, readSettings } from '../core/settings';
import {
  DAEMON_STATUS_STALE_MS,
  isProcessAlive,
  readDaemonStatus,
  readLock,
} from '../core/daemon-state';
import { SessionStore } from '../core/session-store';
import { ui } from '../ui';

const mark = (b: boolean): string => (b ? ui.check : ui.cross);

export async function status(_args: string[] = []): Promise<void> {
  // Hooks installed?
  const settings = await readSettings();
  const installed = HOOK_EVENTS.filter((e) => (settings.hooks?.[e.name] ?? []).some(isOurEntry));
  const hooksOk = installed.length === HOOK_EVENTS.length;

  // Discord application id configured?
  const clientId = new UserConfigFile(presenceDir()).load().clientId;
  const clientIdOk = clientId.length > 0;

  // Daemon running?
  const lock = readLock();
  const daemonRunning = lock !== null && isProcessAlive(lock.pid);

  // Discord connection + reported sessions (from the daemon's status file).
  const now = Date.now();
  const ds = readDaemonStatus();
  const dsFresh = ds !== null && now - ds.updatedAt <= DAEMON_STATUS_STALE_MS;
  const discordConnected = dsFresh && ds.connected;

  // Live sessions (independent of the daemon — read straight from markers).
  const live = new SessionStore(presenceDir()).snapshot(now);
  const sessionCount = live?.sessionCount ?? 0;

  console.log(`${ui.title('vibecoder-discord-presence')} ${ui.dim('— status')}\n`);
  console.log(
    `  ${mark(hooksOk)} hooks installed   ${
      hooksOk
        ? ui.dim(`(${installed.length}/${HOOK_EVENTS.length})`)
        : ui.warn(`(${installed.length}/${HOOK_EVENTS.length} — run \`vdp install\`)`)
    }`,
  );
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
