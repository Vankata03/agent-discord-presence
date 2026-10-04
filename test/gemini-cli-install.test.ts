import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { GEMINI_CLI_HOOK_EVENTS } from '../src/provider/gemini-cli';
import {
  GEMINI_CLI_HOOK_NAME,
  GEMINI_CLI_HOOK_TIMEOUT_MS,
  GEMINI_CLI_TRUST_NOTE,
  GeminiCliInstaller,
  geminiHookCommand,
  type GeminiCliInstallerOptions,
} from '../src/provider/gemini-cli-install';

const ENTRY = '/opt/vdp/dist/vdp.js';
const CONTEXT = { entryPath: ENTRY };
const HELP = 'Commands:\n  gemini hooks <command>  Manage Gemini CLI hooks.\n';

let dir: string;
let settingsPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vdp-gemini-'));
  settingsPath = join(dir, 'settings.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let tick = 0;
function installer(options: GeminiCliInstallerOptions = {}): GeminiCliInstaller {
  return new GeminiCliInstaller({
    dir,
    platform: 'linux',
    findExecutable: () => '/usr/bin/gemini',
    probeVersion: () => '0.62.0',
    probeHelp: () => HELP,
    now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0, tick++)),
    ...options,
  });
}

const read = (): string => readFileSync(settingsPath, 'utf8');
const backups = (): string[] => readdirSync(dir).filter((f) => f.endsWith('.bak'));
const command = (event: string): string => `node '${ENTRY}' hook gemini-cli ${event}`;
const group = (event: string) => ({
  hooks: [
    {
      type: 'command',
      name: GEMINI_CLI_HOOK_NAME,
      command: command(event),
      timeout: GEMINI_CLI_HOOK_TIMEOUT_MS,
    },
  ],
});

test('detection is the runtime capability probe', async () => {
  assert.deepEqual(await installer().detect(), { status: 'ready', version: '0.62.0' });
  assert.equal((await installer({ findExecutable: () => null }).detect()).status, 'absent');
  assert.equal(
    (await installer({ probeHelp: () => 'Commands:\n' }).detect()).status,
    'unsupported',
  );
  writeFileSync(settingsPath, JSON.stringify({ hooksConfig: { enabled: false } }));
  assert.equal((await installer().detect()).status, 'unsupported');
});

test('install adds only the presence hooks at user scope, with a 3,000 ms timeout', async () => {
  const result = await installer().install(CONTEXT);
  assert.deepEqual(result.written, [settingsPath]);
  assert.deepEqual(result.backups, []);
  assert.deepEqual(result.notes, [GEMINI_CLI_TRUST_NOTE]);
  assert.deepEqual(
    result.registered,
    GEMINI_CLI_HOOK_EVENTS.map((e) => e.name),
  );

  const file = JSON.parse(read());
  assert.deepEqual(Object.keys(file), ['hooks'], 'no telemetry, checkpointing or hooksConfig');
  assert.deepEqual(
    Object.keys(file.hooks).sort(),
    [
      'AfterAgent',
      'AfterTool',
      'BeforeAgent',
      'BeforeTool',
      'Notification',
      'SessionEnd',
      'SessionStart',
    ],
    'no model, tool-selection or compression hooks',
  );
  for (const { name, arg } of GEMINI_CLI_HOOK_EVENTS) {
    assert.deepEqual(file.hooks[name], [group(arg)], name);
  }
  assert.deepEqual(readdirSync(dir), ['settings.json'], 'no project hooks or other files');
});

test('the trust note explains folder trust without suggesting a bypass', () => {
  assert.match(GEMINI_CLI_TRUST_NOTE, /trust/);
  assert.doesNotMatch(GEMINI_CLI_TRUST_NOTE, /skip-trust|TRUST_WORKSPACE|trustedFolders/i);
});

test('the entry path is single-quoted for the platform’s shell', () => {
  assert.equal(
    geminiHookCommand("/home/o'brien/$HOME/`x`/vdp.js", 'before-tool', 'linux'),
    `node '/home/o'\\''brien/$HOME/\`x\`/vdp.js' hook gemini-cli before-tool`,
  );
  assert.equal(
    geminiHookCommand("C:\\Users\\O'Brien\\cost$x\\vdp.js", 'after-tool', 'win32'),
    `node 'C:\\Users\\O''Brien\\cost$x\\vdp.js' hook gemini-cli after-tool`,
  );
  assert.equal(
    geminiHookCommand('C:\\Users\\Jo\u2019s\\vdp.js', 'stop', 'win32'),
    `node 'C:\\Users\\Jo\u2019\u2019s\\vdp.js' hook gemini-cli stop`,
    'PowerShell also ends a string at typographic quotes',
  );
});

test(
  'bash runs the command with the exact argv for awkward install paths',
  { skip: process.platform === 'win32' },
  () => {
    // How Gemini runs a command hook on Linux and macOS: `bash -c <command>`.
    const stub = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))';
    for (const name of ['plain', 'with space', "O'Brien", 'cost$HOME', 'tick`n', 'a&b;c']) {
      const entry = join(dir, name, 'vdp.js');
      mkdirSync(join(dir, name));
      writeFileSync(entry, stub);
      const run = spawnSync('bash', ['-c', geminiHookCommand(entry, 'before-tool', 'linux')], {
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
      assert.deepEqual(JSON.parse(run.stdout), ['hook', 'gemini-cli', 'before-tool'], name);
    }
  },
);

test('install keeps every other setting, the hook-system keys and foreign hooks', async () => {
  const original = {
    security: { auth: { selectedType: 'gemini-api-key' } },
    hooksConfig: { notifications: false },
    hooks: {
      enabled: true,
      disabled: ['my-guard'],
      BeforeTool: [
        { matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'guard.sh' }] },
      ],
      PreCompress: [{ hooks: [{ type: 'command', command: 'log.sh' }] }],
    },
    general: { vimMode: true },
  };
  writeFileSync(settingsPath, JSON.stringify(original, null, 2));
  const result = await installer().install(CONTEXT);
  assert.equal(result.backups.length, 1);

  const file = JSON.parse(read());
  assert.deepEqual(file.security, original.security);
  assert.deepEqual(file.hooksConfig, original.hooksConfig);
  assert.deepEqual(file.general, original.general);
  assert.equal(file.hooks.enabled, true);
  assert.deepEqual(file.hooks.disabled, ['my-guard']);
  assert.deepEqual(file.hooks.PreCompress, original.hooks.PreCompress);
  assert.deepEqual(file.hooks.BeforeTool, [original.hooks.BeforeTool[0], group('before-tool')]);
});

test('reinstall replaces our groups in place, from either quoting style', async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          AfterAgent: [
            {
              hooks: [
                { type: 'command', command: 'node "/old/vdp.js" hook gemini-cli after-agent' },
              ],
            },
            { hooks: [{ type: 'command', command: 'notify-send done' }] },
          ],
          BeforeAgent: [
            {
              hooks: [
                { type: 'command', command: "node '/old/vdp.js' hook gemini-cli before-agent" },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  await installer().install(CONTEXT);
  const file = JSON.parse(read());
  assert.deepEqual(file.hooks.AfterAgent, [
    group('after-agent'),
    { hooks: [{ type: 'command', command: 'notify-send done' }] },
  ]);
  assert.deepEqual(file.hooks.BeforeAgent, [group('before-agent')]);

  const before = read();
  const again = await installer().install(CONTEXT);
  assert.deepEqual(again.written, []);
  assert.equal(read(), before);
  assert.equal(backups().length, 1);
});

test('install then uninstall restores the settings byte-for-byte', async () => {
  const original =
    '{\n\t"theme": "Default",\n\t"hooks": { "enabled": true, "AfterAgent": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ] }\n}';
  writeFileSync(settingsPath, original);
  await installer().install(CONTEXT);
  const result = await installer().uninstall();
  assert.equal(result.removed, GEMINI_CLI_HOOK_EVENTS.length);
  assert.deepEqual(result.surviving, []);
  assert.equal(read(), original);
});

test('uninstall removes a settings file that only held our hooks', async () => {
  await installer().install(CONTEXT);
  const result = await installer().uninstall();
  assert.equal(result.removed, GEMINI_CLI_HOOK_EVENTS.length);
  assert.equal(existsSync(settingsPath), false);
});

test('uninstall works without the gemini executable and leaves other VDP routes alone', async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        AfterAgent: [
          { hooks: [{ type: 'command', command: 'node "/x/vdp.js" hook codex stop' }] },
          group('after-agent'),
        ],
      },
    }),
  );
  const result = await installer({ findExecutable: () => null }).uninstall();
  assert.equal(result.removed, 1);
  assert.deepEqual(JSON.parse(read()).hooks.AfterAgent, [
    { hooks: [{ type: 'command', command: 'node "/x/vdp.js" hook codex stop' }] },
  ]);
});

test('malformed or commented settings fail install without writing or backing up', async () => {
  for (const bad of [
    '{ "hooks": ',
    '[]',
    '{"hooks": []}',
    '{"hooks": {"AfterAgent": {}}}',
    '{\n  // Gemini accepts comments; strict JSON refuses to rewrite them\n  "theme": "Default"\n}',
  ]) {
    writeFileSync(settingsPath, bad);
    await assert.rejects(installer().install(CONTEXT), Error, bad);
    assert.equal(read(), bad);
    assert.deepEqual(backups(), []);
    const result = await installer().uninstall();
    assert.equal(result.surviving[0]?.location, settingsPath, bad);
  }
});

test('a group mixing our command with a foreign one is a collision', async () => {
  const mixed = JSON.stringify({
    hooks: {
      AfterAgent: [
        {
          hooks: [
            { type: 'command', command: command('after-agent') },
            { type: 'command', command: 'say done' },
          ],
        },
      ],
    },
  });
  writeFileSync(settingsPath, mixed);
  await assert.rejects(installer().install(CONTEXT), /mixes a vdp hook/);
  const result = await installer().uninstall();
  assert.equal(result.surviving[0]?.location, settingsPath);
  assert.equal(read(), mixed);
});

test('inspect counts our registered events', async () => {
  const expected = GEMINI_CLI_HOOK_EVENTS.length;
  assert.deepEqual(await installer().inspect(), { present: 0, expected });
  await installer().install(CONTEXT);
  assert.deepEqual(await installer().inspect(), { present: expected, expected });
  writeFileSync(settingsPath, 'nope');
  assert.match((await installer().inspect()).error ?? '', /not valid JSON/);
});
