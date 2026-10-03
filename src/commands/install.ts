/**
 * `vdp install`
 *
 * Detects every supported coding tool and installs VDP's integration into each
 * ready one, independently: a failure in one tool is reported without undoing
 * or skipping the others. Absent and unsupported tools are reported and left
 * untouched. Hook commands use the resolved absolute path to this bundle, so
 * they never pay npx resolution cost on every event.
 *
 * VDP's own data dir and default config are created only once at least one
 * tool is installed. The command fails (exit code 1) when any ready tool failed
 * or when no tool could be installed at all.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { entryPath, presenceDir, sessionsDir } from '../core/paths';
import { DEFAULT_CONFIG, UserConfigFile } from '../core/user-config';
import {
  defaultInstallers,
  installProviders,
  type ProviderInstallReport,
} from '../provider/installer';
import { PROVIDER_DISPLAY_NAMES } from '../types';
import { ui } from '../ui';

function printProvider(report: ProviderInstallReport): void {
  const name = PROVIDER_DISPLAY_NAMES[report.provider];
  const version =
    report.detection && 'version' in report.detection ? report.detection.version : undefined;
  const label = version ? `${name} ${ui.dim(version)}` : name;
  switch (report.status) {
    case 'installed': {
      const { result } = report;
      console.log(`  ${ui.check} ${label}`);
      console.log(`      ${ui.dim('hooks:')}  ${result.registered.join(', ')}`);
      for (const path of result.written) {
        console.log(`      ${ui.dim('wrote:')}  ${ui.accent(path)}`);
      }
      if (result.written.length === 0) console.log(`      ${ui.dim('already up to date')}`);
      for (const path of result.backups) {
        console.log(`      ${ui.dim('backup:')} ${ui.accent(path)}`);
      }
      for (const note of result.notes ?? []) console.log(`      ${ui.warn(note)}`);
      return;
    }
    case 'absent':
    case 'unsupported': {
      const why = report.detection.status === 'ready' ? '' : `: ${report.detection.reason}`;
      const what = report.status === 'absent' ? 'not found' : 'unsupported';
      console.log(`  ${ui.bullet} ${label} ${ui.dim(`— ${what}${why}`)}`);
      return;
    }
    case 'failed':
      console.log(`  ${ui.cross} ${label} ${ui.err(`— failed: ${report.error}`)}`);
      console.log(`      ${ui.dim('nothing was written for this tool')}`);
      return;
  }
}

export async function install(_args: string[] = []): Promise<void> {
  const report = await installProviders(await defaultInstallers(), { entryPath: entryPath() });
  const installed = report.providers.filter((p) => p.status === 'installed').length;

  if (installed > 0) {
    await mkdir(sessionsDir(), { recursive: true });
    // Default config — only if the user doesn't already have one.
    const userConfig = new UserConfigFile(presenceDir());
    if (!existsSync(userConfig.path)) userConfig.save(DEFAULT_CONFIG);
  }

  const headline =
    report.ok && installed > 0
      ? `${ui.check} ${ui.bold('vibecoder-discord-presence installed')}`
      : installed > 0
        ? `${ui.cross} ${ui.bold('vibecoder-discord-presence partially installed')}`
        : `${ui.cross} ${ui.bold('vibecoder-discord-presence not installed')}`;
  console.log(headline);
  for (const provider of report.providers) printProvider(provider);

  if (installed > 0) {
    console.log(`  ${ui.dim('config:')} ${ui.accent(new UserConfigFile(presenceDir()).path)}`);
    console.log(
      `\n${ui.dim('Open your coding tool with Discord running and your presence will appear.')}`,
    );
  } else if (report.ok) {
    console.log(
      `\n${ui.dim('No supported coding tool found. Install one, then run `vdp install` again.')}`,
    );
  }
  if (!report.ok || installed === 0) process.exitCode = 1;
}
