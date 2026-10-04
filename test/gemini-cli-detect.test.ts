import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectGeminiCli, type GeminiCliDetectOptions } from '../src/provider/gemini-cli-detect';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `gemini --help` as printed by Gemini CLI 0.62.0. */
const HELP = readFileSync(join(HERE, 'fixtures/gemini-cli/0.62.0/help.txt'), 'utf8');
/** The same help from a build without the command-hook API. */
const HELP_WITHOUT_HOOKS = HELP.split('\n')
  .filter((l) => !l.includes('gemini hooks'))
  .join('\n');

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-gemini-detect-'));
  dir = join(root, '.gemini');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const detect = (options: GeminiCliDetectOptions = {}) =>
  detectGeminiCli({
    dir,
    findExecutable: () => '/usr/bin/gemini',
    probeVersion: () => '0.62.0',
    probeHelp: () => HELP,
    ...options,
  });

test('ready with the version when the gemini executable offers hooks', async () => {
  assert.deepEqual(await detect(), { status: 'ready', version: '0.62.0' });
  assert.deepEqual(await detect({ probeVersion: () => undefined }), { status: 'ready' });
});

test('absent when no gemini executable resolves', async () => {
  const detection = await detect({ findExecutable: () => null });
  assert.equal(detection.status, 'absent');
  assert.match(detection.status === 'absent' ? detection.reason : '', /gemini/);
});

test('unsupported, without writing, when the runtime has no command-hook API', async () => {
  const detection = await detect({
    probeVersion: () => '0.10.0',
    probeHelp: () => HELP_WITHOUT_HOOKS,
  });
  assert.equal(detection.status, 'unsupported');
  assert.equal(detection.status === 'unsupported' && detection.version, '0.10.0');
  assert.match(detection.status === 'unsupported' ? detection.reason : '', /gemini hooks/);
  assert.deepEqual(readdirSync(root), [], 'detection wrote nothing');
});

test('unsupported when `gemini --help` cannot be run', async () => {
  const detection = await detect({ probeHelp: () => undefined });
  assert.equal(detection.status, 'unsupported');
  assert.match(detection.status === 'unsupported' ? detection.reason : '', /--help/);
});

test('unsupported, without writing, when the user settings turn hooks off', async () => {
  mkdirSync(dir);
  const settings = JSON.stringify({ hooksConfig: { enabled: false }, hooks: {} });
  writeFileSync(join(dir, 'settings.json'), settings);
  const detection = await detect();
  assert.equal(detection.status, 'unsupported');
  assert.match(detection.status === 'unsupported' ? detection.reason : '', /hooksConfig\.enabled/);
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), settings);
  assert.deepEqual(readdirSync(dir), ['settings.json'], 'detection wrote nothing else');
});

test('settings that leave hooks on, or cannot be parsed, do not block detection', async () => {
  mkdirSync(dir);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooksConfig: { enabled: true } }));
  assert.equal((await detect()).status, 'ready');
  // Gemini accepts comments in settings.json; the installer, not detection, deals with them.
  writeFileSync(
    join(dir, 'settings.json'),
    '{\n  // mine\n  "hooksConfig": { "enabled": true }\n}\n',
  );
  assert.equal((await detect()).status, 'ready');
});
