// Runs VDP-style hook commands the way Gemini CLI 0.62.0 runs command hooks
// (hookRunner getShellConfiguration: on Windows `<pwsh> -NoProfile -Command
// "<command>; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"`, elsewhere
// `bash -c <command>`; payload on stdin, no shell: true) against entry paths with
// awkward characters, and reports whether the entry received the right argv,
// stdin and exit code for each quoting style.
// usage: node command-quoting.mjs <pwsh executable> <scratch dir>
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , pwsh, scratch] = process.argv;
const dirs = [
  'plain',
  'with space',
  "O'Brien",
  'cost$HOME',
  'tick`n',
  'Program Files (x86)',
  'a&b;c',
];
const args = 'hook gemini-cli BeforeTool';
const shells = {
  powershell: {
    run: (command) => [
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      ],
    ],
    styles: {
      // What core/hook-groups.ts hookCommand() generates for every provider today.
      double: (p) => `node "${p}" ${args}`,
      // PowerShell single-quoted literal: no expansion; ' is doubled.
      single: (p) => `node '${p.replace(/'/g, "''")}' ${args}`,
    },
  },
  bash: {
    run: (command) => ['bash', ['-c', command]],
    styles: {
      double: (p) => `node "${p}" ${args}`,
      // POSIX single-quoted literal: no expansion; ' becomes '\''.
      single: (p) => `node '${p.replace(/'/g, "'\\''")}' ${args}`,
    },
  },
};
const stub = `const c=[];process.stdin.on('data',d=>c.push(d)).on('end',()=>{console.error(JSON.stringify({argv:process.argv.slice(2),stdin:Buffer.concat(c).toString()}));process.stdout.write('{}')})`;
const payload = JSON.stringify({
  session_id: 's1',
  hook_event_name: 'BeforeTool',
  tool_name: 'read_file',
});
const rows = [];
for (const dir of dirs) {
  const base = join(scratch, dir);
  mkdirSync(base, { recursive: true });
  const entry = join(base, 'vdp.js');
  writeFileSync(entry, stub);
  for (const [shell, { run, styles }] of Object.entries(shells))
    for (const [style, build] of Object.entries(styles)) {
      const [exe, argv] = run(build(entry));
      const r = spawnSync(exe, argv, {
        input: payload,
        encoding: 'utf8',
        shell: false,
      });
      let seen;
      try {
        seen = JSON.parse(r.stderr.trim().split('\n').pop());
      } catch {
        seen = null;
      }
      const ok =
        r.status === 0 &&
        r.stdout.trim() === '{}' &&
        seen?.stdin === payload &&
        JSON.stringify(seen?.argv) === JSON.stringify(['hook', 'gemini-cli', 'BeforeTool']);
      rows.push({
        shell,
        dir,
        style,
        ok,
        status: r.status,
        stdout: r.stdout.trim().slice(0, 40),
        err: ok ? '' : r.stderr.trim().split('\n')[0].slice(0, 100),
      });
    }
}
console.log(JSON.stringify(rows, null, 1));
