import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installProviders,
  uninstallProviders,
  type Detection,
  type InstallResult,
  type ProviderInstaller,
  type UninstallResult,
} from '../src/provider/installer';
import type { ProviderKey } from '../src/types';

const CONTEXT = { entryPath: '/opt/vdp/dist/vdp.js' };

interface FakeOptions {
  detect?: Detection | Error;
  install?: InstallResult | Error;
  uninstall?: UninstallResult | Error;
}

/** A provider adapter whose outcomes are scripted, recording calls in `log`. */
function fake(provider: ProviderKey, log: string[], options: FakeOptions = {}): ProviderInstaller {
  const outcome = <T>(value: T | Error): T => {
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    provider,
    locations: () => [`/home/me/.${provider}/hooks.json`],
    detect: async () => {
      log.push(`detect:${provider}`);
      return outcome(options.detect ?? { status: 'ready', version: '1.0.0' });
    },
    install: async () => {
      log.push(`install:${provider}`);
      return outcome(
        options.install ?? { written: ['/w'], backups: [], registered: ['SessionStart'] },
      );
    },
    uninstall: async () => {
      log.push(`uninstall:${provider}`);
      return outcome(options.uninstall ?? { removed: 1, surviving: [], backups: [] });
    },
  };
}

test('install runs only for ready providers and reports absent and unsupported ones', async () => {
  const log: string[] = [];
  const report = await installProviders(
    [
      fake('claude-code', log),
      fake('codex', log, { detect: { status: 'absent', reason: 'codex not on PATH' } }),
      fake('grok-build', log, {
        detect: { status: 'unsupported', version: '0.9.0', reason: 'no global hooks' },
      }),
    ],
    CONTEXT,
  );

  assert.deepEqual(log, [
    'detect:claude-code',
    'install:claude-code',
    'detect:codex',
    'detect:grok-build',
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.providers.map((p) => [p.provider, p.status]),
    [
      ['claude-code', 'installed'],
      ['codex', 'absent'],
      ['grok-build', 'unsupported'],
    ],
  );
  assert.deepEqual(report.providers[2], {
    provider: 'grok-build',
    status: 'unsupported',
    detection: { status: 'unsupported', version: '0.9.0', reason: 'no global hooks' },
  });
});

test('one provider failing does not skip or undo the others, and fails the install', async () => {
  const log: string[] = [];
  const report = await installProviders(
    [
      fake('claude-code', log),
      fake('codex', log, { install: new Error('hooks.json is not valid JSON') }),
      fake('opencode', log, { detect: new Error('probe crashed') }),
      fake('gemini-cli', log),
    ],
    CONTEXT,
  );

  assert.equal(report.ok, false);
  assert.ok(log.includes('install:gemini-cli'), 'later providers are still attempted');
  assert.ok(!log.some((l) => l.startsWith('uninstall')), 'nothing is rolled back');
  assert.deepEqual(
    report.providers.map((p) => [p.provider, p.status, p.status === 'failed' ? p.error : '']),
    [
      ['claude-code', 'installed', ''],
      ['codex', 'failed', 'hooks.json is not valid JSON'],
      ['opencode', 'failed', 'detection failed: probe crashed'],
      ['gemini-cli', 'installed', ''],
    ],
  );
});

test('uninstall cleans every provider without detecting, then stops the daemon', async () => {
  const log: string[] = [];
  const report = await uninstallProviders([fake('claude-code', log), fake('codex', log)], {
    stopDaemon: async () => {
      log.push('stop');
      return 4242;
    },
  });

  assert.deepEqual(log, ['uninstall:claude-code', 'uninstall:codex', 'stop']);
  assert.equal(report.ok, true);
  assert.equal(report.stoppedPid, 4242);
  assert.equal(report.purge, 'not-requested');
});

test('uninstall reports every failure and surviving location and still stops the daemon', async () => {
  const log: string[] = [];
  const report = await uninstallProviders(
    [
      fake('claude-code', log, {
        uninstall: {
          removed: 0,
          backups: [],
          surviving: [{ location: '/s.json', reason: 'not valid JSON' }],
        },
      }),
      fake('codex', log, { uninstall: new Error('EACCES') }),
      fake('opencode', log),
    ],
    { stopDaemon: async () => (log.push('stop'), null) },
  );

  assert.deepEqual(log, ['uninstall:claude-code', 'uninstall:codex', 'uninstall:opencode', 'stop']);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.providers.map((p) => [p.provider, p.ok, p.surviving]),
    [
      ['claude-code', false, [{ location: '/s.json', reason: 'not valid JSON' }]],
      ['codex', false, [{ location: '/home/me/.codex/hooks.json', reason: 'EACCES' }]],
      ['opencode', true, []],
    ],
  );
});

test('purge runs only after every cleanup succeeded', async () => {
  const log: string[] = [];
  const done = await uninstallProviders([fake('claude-code', log)], {
    stopDaemon: async () => (log.push('stop'), null),
    purge: async () => void log.push('purge'),
  });
  assert.deepEqual(log, ['uninstall:claude-code', 'stop', 'purge']);
  assert.equal(done.purge, 'done');
  assert.equal(done.ok, true);
});

test('incomplete cleanup refuses purge, keeps data, stops the daemon and fails', async () => {
  const log: string[] = [];
  const refused = await uninstallProviders(
    [fake('claude-code', log, { uninstall: new Error('boom') }), fake('codex', log)],
    {
      stopDaemon: async () => (log.push('stop'), 7),
      purge: async () => void log.push('purge'),
    },
  );
  assert.deepEqual(log, ['uninstall:claude-code', 'uninstall:codex', 'stop']);
  assert.equal(refused.purge, 'refused');
  assert.equal(refused.stoppedPid, 7);
  assert.equal(refused.ok, false);
});

test('a purge that throws is reported as a failed uninstall', async () => {
  const report = await uninstallProviders([fake('claude-code', [])], {
    stopDaemon: async () => null,
    purge: async () => {
      throw new Error('EBUSY');
    },
  });
  assert.equal(report.purge, 'failed');
  assert.equal(report.purgeError, 'EBUSY');
  assert.equal(report.ok, false);
});
