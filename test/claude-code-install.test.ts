import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeInstaller,
  type ClaudeCodeInstallerOptions,
} from '../src/provider/claude-code-install';
import { HOOK_EVENTS } from '../src/core/settings';

const ENTRY = '/opt/vdp/dist/vdp.js';
const CONTEXT = { entryPath: ENTRY };

let dir: string;
let settingsPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vdp-claude-'));
  settingsPath = join(dir, 'settings.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let tick = 0;
function installer(options: ClaudeCodeInstallerOptions = {}): ClaudeCodeInstaller {
  return new ClaudeCodeInstaller({
    configDir: dir,
    findExecutable: () => null,
    probeVersion: () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 3, 12, 0, 0, tick++)),
    ...options,
  });
}

const backups = (): string[] => readdirSync(dir).filter((f) => f.endsWith('.bak'));
const read = (): string => readFileSync(settingsPath, 'utf8');

test('detect is ready with a version when the claude executable resolves', async () => {
  const found = installer({
    findExecutable: () => '/usr/local/bin/claude',
    probeVersion: (exe) => (exe === '/usr/local/bin/claude' ? '2.0.14' : undefined),
  });
  assert.deepEqual(await found.detect(), { status: 'ready', version: '2.0.14' });
});

test('detect is ready without an executable once Claude Code has used its config dir', async () => {
  mkdirSync(join(dir, 'projects'));
  assert.deepEqual(await installer().detect(), { status: 'ready' });
});

test('detect is absent when only VDP data or nothing is there', async () => {
  rmSync(dir, { recursive: true });
  assert.equal((await installer().detect()).status, 'absent');

  mkdirSync(join(dir, 'discord-presence'), { recursive: true });
  writeFileSync(join(dir, 'settings.json.2026-01-01T00-00-00-000Z.bak'), '{}');
  const detection = await installer().detect();
  assert.equal(detection.status, 'absent');
  assert.match(detection.status === 'absent' ? detection.reason : '', /claude/);
});

test('install into a missing settings file writes our hooks without a backup', async () => {
  const result = await installer().install(CONTEXT);
  assert.deepEqual(result.written, [settingsPath]);
  assert.deepEqual(result.backups, []);
  assert.deepEqual(
    result.registered,
    HOOK_EVENTS.map((e) => e.name),
  );
  const settings = JSON.parse(read());
  assert.equal(settings.hooks.Stop[0].hooks[0].command, `node "${ENTRY}" hook claude-code stop`);
  assert.ok(read().endsWith('}\n'));
});

test('install backs up the exact original bytes before changing a non-empty file', async () => {
  const original = '{\n    "model": "opus",\n    "env": { "A": "1" }\n}\n';
  writeFileSync(settingsPath, original);
  const result = await installer().install(CONTEXT);
  assert.equal(result.backups.length, 1);
  assert.equal(readFileSync(result.backups[0]!, 'utf8'), original);
});

test('reinstall is a no-op: no write and no new backup', async () => {
  writeFileSync(settingsPath, '{"model":"opus"}');
  await installer().install(CONTEXT);
  const before = read();
  const again = await installer().install(CONTEXT);
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.backups, []);
  assert.equal(read(), before);
  assert.equal(backups().length, 1);
});

test('install then uninstall restores unrelated settings byte-for-byte', async () => {
  const layouts = [
    '{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  }\n}\n',
    '{\n    "model": "opus",\n    "hooks": {\n        "Stop": [\n            {\n                "hooks": [\n                    {\n                        "type": "command",\n                        "command": "say done"\n                    }\n                ]\n            }\n        ]\n    }\n}',
    '\ufeff{\r\n\t"model": "opus",\r\n\t"hooks": {\r\n\t\t"PreCompact": []\r\n\t}\r\n}\r\n',
    '{"model":"opus","statusLine":{"type":"command","command":"x"}}',
  ];
  for (const original of layouts) {
    writeFileSync(settingsPath, original);
    await installer().install(CONTEXT);
    assert.notEqual(read(), original);
    const result = await installer().uninstall();
    assert.equal(result.removed, HOOK_EVENTS.length);
    assert.deepEqual(result.surviving, []);
    assert.equal(read(), original, JSON.stringify(original));
  }
});

test('malformed settings fail install without writing or backing up', async () => {
  for (const bad of ['{ "model": ', '[]', '{"hooks": {"Stop": {}}}']) {
    writeFileSync(settingsPath, bad);
    await assert.rejects(installer().install(CONTEXT));
    assert.equal(read(), bad);
    assert.deepEqual(backups(), []);
  }
});

test('an ownership collision fails install and is reported by uninstall without writes', async () => {
  const mixed = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: `node "${ENTRY}" hook claude-code stop` },
            { type: 'command', command: 'say done' },
          ],
        },
      ],
    },
  });
  writeFileSync(settingsPath, mixed);

  await assert.rejects(installer().install(CONTEXT), /mixes a vdp hook/);
  const result = await installer().uninstall();
  assert.equal(result.removed, 0);
  assert.equal(result.surviving.length, 1);
  assert.equal(result.surviving[0]?.location, settingsPath);
  assert.match(result.surviving[0]?.reason ?? '', /Stop/);
  assert.equal(read(), mixed);
  assert.deepEqual(backups(), []);
});

test('uninstall removes legacy and canonical entries but keeps foreign hooks', async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'node "/old/vdp.js" hook stop' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'say done' }] },
        ],
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: `node "${ENTRY}" hook claude-code session-start` }],
          },
        ],
      },
    }),
  );
  const result = await installer().uninstall();
  assert.equal(result.removed, 2);
  assert.equal(result.backups.length, 1);
  assert.deepEqual(JSON.parse(read()), {
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'say done' }] }] },
  });
});

test('uninstall works without the executable and with no settings file', async () => {
  rmSync(dir, { recursive: true });
  assert.deepEqual(await installer().uninstall(), { removed: 0, surviving: [], backups: [] });
});

test('uninstall reports unparseable settings as a surviving location', async () => {
  writeFileSync(settingsPath, 'not json');
  const result = await installer().uninstall();
  assert.equal(result.surviving[0]?.location, settingsPath);
  assert.match(result.surviving[0]?.reason ?? '', /not valid JSON/);
  assert.equal(read(), 'not json');
});
