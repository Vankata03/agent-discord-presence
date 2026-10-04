/**
 * One ledger-backed hook process for the cross-process ledger tests. Waits for
 * the parent's barrier so every worker updates the same session at once, and
 * widens the read-to-write window so any unserialized update is lost.
 *
 * usage: node --import tsx ledger-hook-worker.ts <codex|gemini-cli> <root> <barrier> <worker-id> <locked|unlocked>
 */
import { existsSync, writeFileSync } from 'node:fs';
import { SessionStore } from '../../src/core/session-store';
import { runHook as runCodexHook } from '../../src/provider/codex';
import { runHook as runGeminiHook } from '../../src/provider/gemini-cli';
import type { HookRuntime, LedgerHookStore } from '../../src/provider/hook-runner';
import type { SessionIdentity } from '../../src/types';

const [provider, root, barrier, workerId, mode] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const pause = new Int32Array(new SharedArrayBuffer(4));
/** Block this worker without spinning. */
const sleep = (ms: number) => Atomics.wait(pause, 0, 0, ms);

class SlowStore extends SessionStore {
  /** Read, then hold the window open so an unserialized writer would race. */
  override readLedger(identity: SessionIdentity): unknown {
    const ledger = super.readLedger(identity);
    sleep(100);
    return ledger;
  }
  /** Bypass the lock in the `unlocked` control run. */
  override withLock<T>(identity: SessionIdentity, fn: () => T): T {
    return mode === 'unlocked' ? fn() : super.withLock(identity, fn);
  }
}

/** Each worker starts one tool in the shared session. */
const payload =
  provider === 'codex'
    ? { session_id: 'shared', cwd: root, tool_name: 'Bash', tool_use_id: workerId }
    : { session_id: 'shared', cwd: root, tool_name: 'run_shell_command' };
const event = provider === 'codex' ? 'pre-tool-use' : 'before-tool';

const runtime: HookRuntime<LedgerHookStore> = {
  readInput: () => JSON.stringify(payload),
  now: Date.now,
  environment: () => ({ cwd: root }),
  root: () => root,
  createStore: (r) => new SlowStore(r, { lock: { timeoutMs: 20_000, staleAfterMs: 20_000 } }),
  ensureDaemon: () => {},
};

writeFileSync(`${barrier}.${workerId}.ready`, '');
while (!existsSync(barrier)) sleep(1);

if (provider === 'codex') await runCodexHook([event], runtime);
else await runGeminiHook([event], { ...runtime, writeOutput: () => {} });
