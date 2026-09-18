import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CONFIG,
  UserConfigFile,
  resolveTheme,
} from '../src/core/user-config';
import { THEMES } from '../src/themes/index';

let root: string;
let file: UserConfigFile;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-config-'));
  file = new UserConfigFile(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run `fn` with VDP_DISCORD_CLIENT_ID set (or unset), restoring it afterwards. */
function withClientIdEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.VDP_DISCORD_CLIENT_ID;
  if (value === undefined) delete process.env.VDP_DISCORD_CLIENT_ID;
  else process.env.VDP_DISCORD_CLIENT_ID = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.VDP_DISCORD_CLIENT_ID;
    else process.env.VDP_DISCORD_CLIENT_ID = prev;
  }
}

test('the config file lives at <root>/config.json', () => {
  assert.equal(file.path, join(root, 'config.json'));
});

test('a missing file resolves to the privacy-safe default', () => {
  const { config, theme, clientId } = withClientIdEnv(undefined, () => file.load());
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(config.theme, 'minimal');
  assert.deepEqual(theme, THEMES['minimal']);
  assert.equal(clientId, DEFAULT_CLIENT_ID);
});

test('a corrupt file resolves to the default', () => {
  writeFileSync(file.path, '{"theme": "developer"');
  assert.deepEqual(file.load().config, DEFAULT_CONFIG);
});

test('a file that is valid JSON but not an object resolves to the default', () => {
  writeFileSync(file.path, '"developer"');
  assert.deepEqual(file.load().config, DEFAULT_CONFIG);
});

test('a partial file fills in the missing fields', () => {
  writeFileSync(file.path, '{"theme":"developer"}');
  assert.deepEqual(file.load().config, { theme: 'developer', overrides: {}, clientId: undefined });
});

test('theme resolution applies overrides a whole slot at a time', () => {
  file.save({
    theme: 'developer',
    overrides: { details: 'Hacking on {project}', largeImage: { key: 'focus', text: '' } },
  });
  const { theme } = file.load();
  assert.equal(theme.details, 'Hacking on {project}');
  assert.deepEqual(theme.largeImage, { key: 'focus', text: '' });
  assert.equal(theme.state, THEMES['developer']?.state, 'untouched slots come from the base');
});

test('an unknown theme name falls back to the default theme', () => {
  assert.deepEqual(resolveTheme({ theme: 'no-such-theme' as never }), THEMES['minimal']);
});

test('client id precedence: environment, then config, then the shared default', () => {
  assert.equal(
    withClientIdEnv(undefined, () => file.load().clientId),
    DEFAULT_CLIENT_ID,
  );
  file.save({ theme: 'minimal', clientId: '111' });
  assert.equal(
    withClientIdEnv(undefined, () => file.load().clientId),
    '111',
  );
  assert.equal(
    withClientIdEnv('222', () => file.load().clientId),
    '222',
  );
});

test('save then load round-trips, pretty-printed for hand editing', () => {
  const config = { theme: 'focus' as const, overrides: { state: 'zen' }, clientId: '9' };
  file.save(config);
  assert.deepEqual(file.load().config, config);
  assert.equal(readFileSync(file.path, 'utf8'), `${JSON.stringify(config, null, 2)}\n`);
});

test('save creates the root and leaves no temp file behind', () => {
  const nested = new UserConfigFile(join(root, 'deeper'));
  nested.save(DEFAULT_CONFIG);
  assert.deepEqual(readdirSync(join(root, 'deeper')), ['config.json']);
});

test('a BOM-prefixed file (Windows editors) still loads', () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(file.path, String.fromCharCode(0xfeff) + '{"theme":"chaos"}');
  assert.equal(file.load().config.theme, 'chaos');
});
