import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchHook,
  resolveHookRoute,
  type HookRunner,
  type HookRunnerLoader,
} from '../src/provider/dispatch';

test('canonical hook routes select only the named provider', async () => {
  const calls: Array<{ provider: string; args: string[] }> = [];
  const load: HookRunnerLoader = async (provider) => {
    const runner: HookRunner = async (args) => {
      calls.push({ provider, args });
    };
    return runner;
  };

  await dispatchHook(['claude-code', 'stop'], load);

  assert.deepEqual(calls, [{ provider: 'claude-code', args: ['stop'] }]);
});

test('legacy unqualified Claude Code events remain accepted', async () => {
  const calls: string[][] = [];
  const load: HookRunnerLoader = async (provider) => {
    assert.equal(provider, 'claude-code');
    return async (args) => {
      calls.push(args);
    };
  };

  await dispatchHook(['pre-tool-use'], load);

  assert.deepEqual(calls, [['pre-tool-use']]);
});

test('unknown unqualified routes do not infer a provider', () => {
  assert.equal(resolveHookRoute(['not-a-provider', 'stop']), null);
});

test('hook dispatch fails open when loading or running a provider fails', async () => {
  await assert.doesNotReject(() =>
    dispatchHook(['claude-code', 'stop'], async () => {
      throw new Error('broken import');
    }),
  );
  await assert.doesNotReject(() =>
    dispatchHook(['claude-code', 'stop'], async () => async () => {
      throw new Error('broken runner');
    }),
  );
});
