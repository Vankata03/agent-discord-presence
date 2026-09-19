/**
 * CLI entry point. Parses argv and routes to a command handler.
 * Contains no business logic itself — just dispatch.
 *
 * Handlers are loaded with dynamic import() on purpose: the hot `hook` path
 * must not pull in the Discord library (only `daemon` does). esbuild defers a
 * bundled module's evaluation until it's actually imported, so `vdp hook` stays
 * lean.
 */
import { ui } from './ui';

const VERSION = '1.1.0';

function helpText(): string {
  const row = (cmd: string, desc: string): string =>
    `  ${ui.accent(`vdp ${cmd}`.padEnd(16))} ${ui.dim(desc)}`;
  return [
    `${ui.title('vdp')} ${ui.dim('— vibecoder-discord-presence')}`,
    '',
    ui.bold('Usage:'),
    row('install', 'Add Claude Code hooks (~/.claude/settings.json)'),
    row('stop', 'Stop the running daemon'),
    row('restart', 'Restart the daemon'),
    row('uninstall', 'Remove hooks, stop the daemon, restore settings'),
    row('uninstall --purge', 'Also delete all vdp data (config, markers)'),
    row('config', 'Customize your Discord presence (interactive)'),
    row('status', 'Show install, daemon, and Discord connection state'),
    row('--version', 'Print version'),
    row('--help', 'Show this help'),
    '',
  ].join('\n');
}

export async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'install':
      return (await import('./commands/install')).install(rest);
    case 'stop':
      return (await import('./commands/stop')).stop(rest);
    case 'restart':
      return (await import('./commands/restart')).restart(rest);
    case 'uninstall':
      return (await import('./commands/uninstall')).uninstall(rest);
    case 'config':
      return (await import('./commands/config')).config(rest);
    case 'status':
      return (await import('./commands/status')).status(rest);
    case 'hook':
      return (await import('./provider/dispatch')).dispatchHook(rest);
    case 'daemon':
      return (await import('./daemon/index')).startDaemon(rest);
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case undefined:
    case '--help':
    case '-h':
      console.log(helpText());
      return;
    default:
      console.error(`${ui.err('Unknown command:')} ${command}\n`);
      console.log(helpText());
      process.exitCode = 1;
  }
}
