import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/core/session-store';
import { parseLedger } from '../src/provider/gemini-cli-ledger';

const HERE = dirname(fileURLToPath(import.meta.url));

const WORKERS = 6;
const WORKER = join(HERE, 'helpers/ledger-hook-worker.ts');
const ID = { provider: 'gemini-cli', sessionId: 'shared' } as const;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-gemini-race-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Start WORKERS BeforeTool hook processes, release them together, and wait for all. */
async function race(mode: 'locked' | 'unlocked'): Promise<void> {
  const barrier = join(root, `go-${mode}`);
  const ids = Array.from({ length: WORKERS }, (_, i) => `${mode}-${i}`);
  const exits = ids.map(
    (id) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', WORKER, 'gemini-cli', root, barrier, id, mode],
          { stdio: 'inherit' },
        );
        child.on('error', reject);
        child.on('exit', resolve);
      }),
  );
  while (!ids.every((id) => existsSync(`${barrier}.${id}.ready`))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(barrier, '');
  assert.deepEqual(
    await Promise.all(exits),
    ids.map(() => 0),
  );
}

/** How many running commands the session's ledger counts. */
function runningCommands(): number {
  const ledger = parseLedger(new SessionStore(root).readLedger(ID));
  return ledger.families.find((f) => f.family === 'command')?.count ?? 0;
}

test(
  'concurrent hook processes never lose each other’s tool counts',
  { timeout: 60_000 },
  async () => {
    await race('locked');
    assert.equal(runningCommands(), WORKERS);
    assert.equal(new SessionStore(root).snapshot(Date.now())?.activity, 'Running a command');
  },
);

test(
  'the same race loses counts when only atomic replacement protects the ledger',
  { timeout: 60_000 },
  async () => {
    // The control for the test above: it proves the race really overlaps, so the
    // lock (not timing) is what keeps every count.
    await race('unlocked');
    assert.ok(runningCommands() < WORKERS, `lost no updates: ${runningCommands()}`);
  },
);
