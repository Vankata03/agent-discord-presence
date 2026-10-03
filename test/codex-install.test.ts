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
  CODEX_HOOK_TIMEOUT_SEC,
  CODEX_TRUST_NOTE,
  CodexInstaller,
  type CodexInstallerOptions,
} from '../src/provider/codex-install';
import { CODEX_HOOK_EVENTS } from '../src/provider/codex';

const ENTRY = '/opt/vdp/dist/vdp.js';
const CONTEXT = { entryPath: ENTRY };

let home: string;
let hooksPath: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vdp-codex-'));
  hooksPath = join(home, 'hooks.json');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

let tick = 0;
function installer(options: CodexInstallerOptions = {}): CodexInstaller {
  return new CodexInstaller({
    home,
    findExecutable: () => null,
    probeVersion: () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 3, 12, 0, 0, tick++)),
    ...options,
  });
}

const read = (): string => readFileSync(hooksPath, 'utf8');
const backups = (): string[] => readdirSync(home).filter((f) => f.endsWith('.bak'));
const command = (event: string): string => `node "${ENTRY}" hook codex ${event}`;

test('detect is ready with a version when the codex executable resolves', async () => {
  const found = installer({
    findExecutable: () => '/usr/bin/codex',
    probeVersion: () => '0.160.0',
  });
  assert.deepEqual(await found.detect(), { status: 'ready', version: '0.160.0' });
});

test('detect is ready from Codex data alone, and absent with neither', async () => {
  assert.equal((await installer().detect()).status, 'absent');
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.5-codex"\n');
  assert.deepEqual(await installer().detect(), { status: 'ready' });
});

test('install writes every lifecycle hook at user scope with the canonical route', async () => {
  const result = await installer().install(CONTEXT);
  assert.deepEqual(result.written, [hooksPath]);
  assert.deepEqual(result.backups, []);
  assert.deepEqual(result.notes, [CODEX_TRUST_NOTE]);
  assert.deepEqual(
    result.registered,
    CODEX_HOOK_EVENTS.map((e) => e.name),
  );

  const file = JSON.parse(read());
  assert.deepEqual(Object.keys(file), ['hooks']);
  for (const { name, arg } of CODEX_HOOK_EVENTS) {
    assert.deepEqual(file.hooks[name], [
      { hooks: [{ type: 'command', command: command(arg), timeout: CODEX_HOOK_TIMEOUT_SEC }] },
    ]);
  }
  assert.deepEqual(readdirSync(home), ['hooks.json'], 'no config.toml or project hooks');
});

test('the trust note never recommends the hook-trust bypass', () => {
  assert.match(CODEX_TRUST_NOTE, /\/hooks/);
  assert.doesNotMatch(CODEX_TRUST_NOTE, /bypass|dangerously/i);
});

test('paths with spaces and Windows separators stay one quoted argument', async () => {
  const windowsEntry =
    'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\vdp\\dist\\vdp.js';
  await installer().install({ entryPath: windowsEntry });
  const stop = JSON.parse(read()).hooks.Stop[0].hooks[0].command as string;
  assert.equal(stop, `node "${windowsEntry}" hook codex stop`);
  // Codex runs `cmd.exe /C "<command>"`; cmd strips only the outer pair of
  // quotes it adds, leaving exactly this command line.
  assert.equal(stop.split('"').length - 1, 2);
});

test('reinstall replaces our groups in place and keeps foreign hook positions', async () => {
  writeFileSync(
    hooksPath,
    JSON.stringify(
      {
        description: 'my hooks',
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node "/old/vdp.js" hook codex stop' }] },
            { hooks: [{ type: 'command', command: 'notify-send done' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        },
      },
      null,
      2,
    ),
  );
  await installer().install(CONTEXT);
  const file = JSON.parse(read());
  assert.equal(file.description, 'my hooks');
  assert.deepEqual(
    file.hooks.Stop.map((g: { hooks: Array<{ command: string }> }) => g.hooks[0]?.command),
    [command('stop'), 'notify-send done'],
    'ours replaced at index 0; the foreign group keeps index 1',
  );
  assert.deepEqual(
    file.hooks.PreToolUse.map((g: { hooks: Array<{ command: string }> }) => g.hooks[0]?.command),
    ['guard.sh', command('pre-tool-use')],
    'ours appended after the foreign group',
  );

  const before = read();
  const again = await installer().install(CONTEXT);
  assert.deepEqual(again.written, []);
  assert.equal(read(), before);
  assert.equal(backups().length, 1);
});

test('install then uninstall restores a foreign hooks.json byte-for-byte', async () => {
  const original =
    '{\n    "hooks": {\n        "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ]\n    }\n}\n';
  writeFileSync(hooksPath, original);
  await installer().install(CONTEXT);
  const result = await installer().uninstall();
  assert.equal(result.removed, CODEX_HOOK_EVENTS.length);
  assert.deepEqual(result.surviving, []);
  assert.equal(read(), original);
});

test('uninstall removes a hooks.json that only held our hooks', async () => {
  await installer().install(CONTEXT);
  const result = await installer().uninstall();
  assert.equal(result.removed, CODEX_HOOK_EVENTS.length);
  assert.equal(existsSync(hooksPath), false);
  assert.equal((await installer().detect()).status, 'absent', 'nothing VDP-owned remains');
});

test('uninstall leaves other VDP providers and foreign hooks alone', async () => {
  const claudeShaped = JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node "/x/vdp.js" hook claude-code stop' }] },
        { hooks: [{ type: 'command', command: command('stop') }] },
      ],
    },
  });
  writeFileSync(hooksPath, claudeShaped);
  const result = await installer().uninstall();
  assert.equal(result.removed, 1);
  assert.deepEqual(JSON.parse(read()).hooks.Stop, [
    { hooks: [{ type: 'command', command: 'node "/x/vdp.js" hook claude-code stop' }] },
  ]);
});

test('malformed hooks.json fails install without writing or backing up', async () => {
  for (const bad of [
    '{ "hooks": ',
    '[]',
    '{"hooks": {"Stop": {}}}',
    '{"hooks": {}, "extra": true}',
  ]) {
    writeFileSync(hooksPath, bad);
    await assert.rejects(installer().install(CONTEXT), Error, bad);
    assert.equal(read(), bad);
    assert.deepEqual(backups(), []);
  }
});

test('a group mixing our command with a foreign one is a collision', async () => {
  const mixed = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: command('stop') },
            { type: 'command', command: 'say done' },
          ],
        },
      ],
    },
  });
  writeFileSync(hooksPath, mixed);
  await assert.rejects(installer().install(CONTEXT), /mixes a vdp hook/);
  const result = await installer().uninstall();
  assert.equal(result.surviving[0]?.location, hooksPath);
  assert.equal(read(), mixed);
});

test('inspect counts our registered events', async () => {
  assert.deepEqual(await installer().inspect(), {
    present: 0,
    expected: CODEX_HOOK_EVENTS.length,
  });
  await installer().install(CONTEXT);
  assert.deepEqual(await installer().inspect(), {
    present: CODEX_HOOK_EVENTS.length,
    expected: CODEX_HOOK_EVENTS.length,
  });
  mkdirSync(join(home, 'sub'));
  writeFileSync(hooksPath, 'nope');
  assert.match((await installer().inspect()).error ?? '', /not valid JSON/);
});
