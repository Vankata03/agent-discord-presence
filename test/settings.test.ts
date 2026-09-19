import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_EVENTS, mergeHooks, stripOurHooks, type Settings } from '../src/core/settings';

test('new Claude Code hook entries use the canonical provider route', () => {
  const merged = mergeHooks({}, 'C:/vdp.js');

  for (const event of HOOK_EVENTS) {
    assert.equal(
      merged.hooks?.[event.name]?.[0]?.hooks?.[0]?.command,
      `node "C:/vdp.js" hook claude-code ${event.arg}`,
    );
  }
});

test('reinstall replaces legacy VDP routes and uninstall removes both shapes', () => {
  const legacy: Settings = {
    hooks: {
      Stop: [
        { matcher: '*', hooks: [{ type: 'command', command: 'node "C:/vdp.js" hook stop' }] },
        { matcher: '*', hooks: [{ type: 'command', command: 'foreign-hook stop' }] },
      ],
    },
  };

  const merged = mergeHooks(legacy, 'C:/vdp.js');
  assert.deepEqual(
    merged.hooks?.Stop?.map((entry) => entry.hooks?.[0]?.command),
    ['foreign-hook stop', 'node "C:/vdp.js" hook claude-code stop'],
  );

  const { cleaned, removed } = stripOurHooks(merged);
  assert.equal(removed, HOOK_EVENTS.length);
  assert.deepEqual(cleaned.hooks?.Stop, [
    { matcher: '*', hooks: [{ type: 'command', command: 'foreign-hook stop' }] },
  ]);
});
