/**
 * One Codex hook process for the cross-process ledger test. Waits for the
 * parent's barrier so every worker updates the same session at once, and
 * widens the read-to-write window so any unserialized update is lost.
 *
 * usage: node --import tsx codex-hook-worker.ts <root> <barrier> <tool-use-id> <locked|unlocked>
 */
import { existsSync, writeFileSync } from 'node:fs';
import { SessionStore } from '../../src/core/session-store';
import { runHook } from '../../src/provider/codex';
import type { SessionIdentity } from '../../src/types';

const [root, barrier, toolUseId, mode] = process.argv.slice(2) as [string, string, string, string];
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

writeFileSync(`${barrier}.${toolUseId}.ready`, '');
while (!existsSync(barrier)) sleep(1);

await runHook(['pre-tool-use'], {
  readInput: () =>
    JSON.stringify({ session_id: 'shared', cwd: root, tool_name: 'Bash', tool_use_id: toolUseId }),
  now: Date.now,
  environment: () => ({ cwd: root }),
  root: () => root,
  createStore: (r) => new SlowStore(r, { lock: { timeoutMs: 20_000, staleAfterMs: 20_000 } }),
  ensureDaemon: () => {},
});
