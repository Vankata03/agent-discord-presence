/**
 * `vdp install`
 *
 * Writes a default config (if absent), ensures our working dirs exist, backs up
 * the current ~/.claude/settings.json, then merges our hook entries in
 * non-destructively. Hook commands use the resolved absolute path to this
 * bundle, so they never pay npx resolution cost on every Claude Code event.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { entryPath, presenceDir, sessionsDir } from '../core/paths';
import { DEFAULT_CONFIG, UserConfigFile } from '../core/user-config';
import {
  HOOK_EVENTS,
  backupSettings,
  mergeHooks,
  readSettings,
  writeSettings,
} from '../core/settings';
import { ui } from '../ui';

export async function install(_args: string[] = []): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true });

  // Default config — only if the user doesn't already have one.
  const userConfig = new UserConfigFile(presenceDir());
  if (!existsSync(userConfig.path)) userConfig.save(DEFAULT_CONFIG);

  const existing = await readSettings();
  const backupPath = await backupSettings(existing);
  await writeSettings(mergeHooks(existing, entryPath()));

  console.log(`${ui.check} ${ui.bold('vibecoder-discord-presence installed')}`);
  console.log(`  ${ui.dim('hooks:')}  ${HOOK_EVENTS.map((e) => e.name).join(', ')}`);
  console.log(`  ${ui.dim('config:')} ${ui.accent(userConfig.path)}`);
  if (backupPath) console.log(`  ${ui.dim('backup:')} ${ui.accent(backupPath)}`);
  console.log(
    `\n${ui.dim('Open Claude Code with Discord running and your presence will appear.')}`,
  );
}
