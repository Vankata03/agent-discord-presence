import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectOpenCode,
  MIN_OPENCODE_VERSION,
  parseConfigDir,
  type OpenCodeDetectOptions,
} from '../src/provider/opencode-detect';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (version: string, name: string) =>
  readFileSync(join(HERE, 'fixtures/opencode', version, name), 'utf8');
/** `opencode debug paths` as printed by OpenCode 1.18.34. */
const PATHS = fixture('1.18.34', 'debug-paths.txt');

const detect = (options: OpenCodeDetectOptions = {}) =>
  detectOpenCode({
    findExecutable: () => '/usr/bin/opencode',
    probeVersion: () => '1.18.34',
    probePaths: () => PATHS,
    ...options,
  });
const reason = (d: Awaited<ReturnType<typeof detectOpenCode>>) =>
  d.status === 'ready' ? '' : d.reason;

test('ready with the version for the verified runtime', async () => {
  assert.deepEqual(await detect(), { status: 'ready', version: '1.18.34' });
});

test('the version the runtime prints is what probeVersion reads', () => {
  assert.equal(fixture('1.18.34', 'version.txt').trim(), '1.18.34');
});

test('ready from the first release that awaits plugin dispose', async () => {
  for (const version of [MIN_OPENCODE_VERSION, '1.16.0', '2.0.0', '1.15.100']) {
    assert.equal((await detect({ probeVersion: () => version })).status, 'ready', version);
  }
});

test('absent when no opencode executable resolves', async () => {
  const detection = await detect({ findExecutable: () => null });
  assert.equal(detection.status, 'absent');
  assert.match(reason(detection), /opencode/);
});

test('unsupported, without probing further, before the plugin dispose contract', async () => {
  let probed = false;
  for (const version of ['1.15.10', '1.0.223', '0.15.31', '1.9.99']) {
    const detection = await detect({
      probeVersion: () => version,
      probePaths: () => ((probed = true), PATHS),
    });
    assert.equal(detection.status, 'unsupported', version);
    assert.equal(detection.status === 'unsupported' && detection.version, version);
    assert.match(reason(detection), new RegExp(`upgrade to ${MIN_OPENCODE_VERSION}`));
  }
  assert.equal(probed, false);
});

test('unsupported when the version cannot be read or is not a release', async () => {
  const unknown = await detect({ probeVersion: () => undefined });
  assert.equal(unknown.status, 'unsupported');
  assert.match(reason(unknown), /--version/);

  const snapshot = await detect({ probeVersion: () => '0.0.0-dev-202610030456' });
  assert.equal(snapshot.status, 'unsupported');
  assert.match(reason(snapshot), /pre-release/);
});

test('unsupported when `opencode debug paths` cannot name the global config directory', async () => {
  for (const paths of [undefined, '', 'home       /home/me\n']) {
    const detection = await detect({ probePaths: () => paths });
    assert.equal(detection.status, 'unsupported');
    assert.match(reason(detection), /debug paths/);
  }
});

test('parseConfigDir reads the config line from every captured runtime', () => {
  assert.equal(parseConfigDir(PATHS), '/home/me/.config/opencode');
  assert.equal(parseConfigDir(fixture('1.0.223', 'debug-paths.txt')), '/home/me/.config/opencode');
});

test('parseConfigDir keeps spaces and Windows paths, and ignores other keys', () => {
  assert.equal(
    parseConfigDir(
      'cache      C:\\Users\\Me Too\\.cache\\opencode\r\nconfig     C:\\Users\\Me Too\\.config\\opencode\r\n',
    ),
    'C:\\Users\\Me Too\\.config\\opencode',
  );
  assert.equal(parseConfigDir('configs    /nope\n'), undefined);
  assert.equal(parseConfigDir('config\n'), undefined);
});
