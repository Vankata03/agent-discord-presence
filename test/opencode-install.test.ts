import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENCODE_RESTART_NOTE,
  OpenCodeInstaller,
  type OpenCodeInstallerOptions,
} from '../src/provider/opencode-install';
import {
  OPENCODE_PLUGIN_FILE,
  OPENCODE_PLUGIN_HEADER,
  isOwnedPlugin,
} from '../src/provider/opencode-plugin';

const ENTRY = '/opt/vdp/dist/vdp.js';
const NODE = '/usr/local/bin/node';
const CONTEXT = { entryPath: ENTRY };

let home: string;
let configDir: string;
let defaultDir: string;
const debugPaths = (dir: string) =>
  `home       ${home}\nconfig     ${dir}\nstate      ${home}/state\n`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vdp-opencode-home-'));
  configDir = join(home, 'xdg', 'opencode');
  defaultDir = join(home, '.config', 'opencode');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function installer(options: OpenCodeInstallerOptions = {}): OpenCodeInstaller {
  return new OpenCodeInstaller({
    findExecutable: () => '/usr/bin/opencode',
    probeVersion: () => '1.18.34',
    probePaths: () => debugPaths(configDir),
    defaultConfigDir: defaultDir,
    nodePath: NODE,
    ...options,
  });
}
const pluginIn = (dir: string) => join(dir, 'plugins', OPENCODE_PLUGIN_FILE);

test('detection is the runtime capability probe', async () => {
  assert.deepEqual(await installer().detect(), { status: 'ready', version: '1.18.34' });
  assert.equal((await installer({ findExecutable: () => null }).detect()).status, 'absent');
  assert.equal((await installer({ probeVersion: () => '1.15.10' }).detect()).status, 'unsupported');
  assert.equal((await installer({ probePaths: () => undefined }).detect()).status, 'unsupported');
  // Detection never writes anything.
  assert.equal(existsSync(configDir), false);
});

test('install writes one auto-discovered global plugin in the reported config directory', async () => {
  const result = await installer().install(CONTEXT);
  const path = pluginIn(configDir);
  assert.deepEqual(result.written, [path]);
  assert.deepEqual(result.backups, []);
  assert.deepEqual(result.registered, [`global plugin ${OPENCODE_PLUGIN_FILE}`]);
  assert.deepEqual(result.notes, [OPENCODE_RESTART_NOTE]);
  const source = readFileSync(path, 'utf8');
  assert.ok(source.startsWith(`${OPENCODE_PLUGIN_HEADER}\n`));
  // The VDP process is a fixed argument vector: absolute node, the entry, the route.
  assert.ok(
    source.includes(`const COMMAND = ${JSON.stringify([NODE, ENTRY, 'hook', 'opencode'])};`),
  );
  // Nothing else in OpenCode's config directory is created or edited.
  assert.deepEqual(readdirSync(configDir), ['plugins']);
  assert.deepEqual(readdirSync(join(configDir, 'plugins')), [OPENCODE_PLUGIN_FILE]);
  assert.equal(existsSync(defaultDir), false);
});

test('install leaves opencode.json, other plugins and OpenCode files byte for byte', async () => {
  mkdirSync(join(configDir, 'plugins'), { recursive: true });
  const files: Record<string, string> = {
    'opencode.json': '{\n  // mine\n  "plugin": ["some-plugin"],\n}\n',
    'package.json': '{"dependencies":{"@opencode-ai/plugin":"1.18.34"}}',
    'plugins/mine.ts': 'export const Mine = async () => ({})\n',
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(configDir, name), body);
  await installer().install(CONTEXT);
  await installer().uninstall();
  for (const [name, body] of Object.entries(files)) {
    assert.equal(readFileSync(join(configDir, name), 'utf8'), body, name);
  }
});

test('reinstall is idempotent, and an outdated VDP plugin is replaced', async () => {
  await installer().install(CONTEXT);
  const again = await installer().install(CONTEXT);
  assert.deepEqual(again.written, []);

  writeFileSync(pluginIn(configDir), `${OPENCODE_PLUGIN_HEADER}\n// an older vdp\n`);
  const upgraded = await installer({ nodePath: '/new/node' }).install(CONTEXT);
  assert.deepEqual(upgraded.written, [pluginIn(configDir)]);
  assert.match(readFileSync(pluginIn(configDir), 'utf8'), /"\/new\/node"/);
});

test('a same-named file VDP does not own fails install without writing', async () => {
  mkdirSync(join(configDir, 'plugins'), { recursive: true });
  const foreign = '// someone else\nexport const X = async () => ({})\n';
  writeFileSync(pluginIn(configDir), foreign);
  await assert.rejects(() => installer().install(CONTEXT), /not created by vdp/);
  assert.equal(readFileSync(pluginIn(configDir), 'utf8'), foreign);
  // ...and uninstall leaves it alone.
  const removed = await installer().uninstall();
  assert.deepEqual(removed, { removed: 0, backups: [], surviving: [] });
  assert.equal(readFileSync(pluginIn(configDir), 'utf8'), foreign);
});

test('install fails without writing when OpenCode cannot name its config directory', async () => {
  await assert.rejects(
    () => installer({ probePaths: () => 'home  /x\n' }).install(CONTEXT),
    /debug paths/,
  );
  assert.equal(existsSync(configDir), false);
  assert.equal(existsSync(defaultDir), false);
});

test('uninstall removes the owned plugin, and inspect reports it', async () => {
  assert.deepEqual(await installer().inspect(), { present: 0, expected: 1 });
  await installer().install(CONTEXT);
  assert.deepEqual(await installer().inspect(), { present: 1, expected: 1 });
  assert.deepEqual(await installer().uninstall(), { removed: 1, backups: [], surviving: [] });
  assert.equal(existsSync(pluginIn(configDir)), false);
  assert.deepEqual(await installer().inspect(), { present: 0, expected: 1 });
  assert.deepEqual(await installer().uninstall(), { removed: 0, backups: [], surviving: [] });
});

test('uninstall still finds the plugin in the default location after OpenCode is gone', async () => {
  // Installed where OpenCode said, which here is the default location.
  await installer({ probePaths: () => debugPaths(defaultDir) }).install(CONTEXT);
  const gone = installer({ findExecutable: () => null });
  assert.deepEqual(gone.locations(), [pluginIn(defaultDir)]);
  assert.deepEqual(await gone.uninstall(), { removed: 1, backups: [], surviving: [] });
  assert.equal(existsSync(pluginIn(defaultDir)), false);
});

test('uninstall inspects both the reported and the default location', async () => {
  await installer().install(CONTEXT);
  await installer({ probePaths: () => debugPaths(defaultDir) }).install(CONTEXT);
  assert.deepEqual(installer().locations(), [pluginIn(configDir), pluginIn(defaultDir)]);
  assert.deepEqual(await installer().uninstall(), { removed: 2, backups: [], surviving: [] });
});

test('an owned plugin that cannot be removed is reported as surviving', async () => {
  await installer().install(CONTEXT);
  // Replace the file with a directory of the same name: reading it fails.
  rmSync(pluginIn(configDir));
  mkdirSync(pluginIn(configDir));
  const result = await installer().uninstall();
  assert.equal(result.removed, 0);
  assert.equal(result.surviving.length, 1);
  assert.equal(result.surviving[0]?.location, pluginIn(configDir));
  assert.ok((await installer().inspect()).error);
});

test('the generated plugin is recognized by its header alone', async () => {
  await installer().install(CONTEXT);
  assert.ok(isOwnedPlugin(readFileSync(pluginIn(configDir), 'utf8')));
});
