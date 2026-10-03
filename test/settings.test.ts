import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOOK_EVENTS,
  SettingsError,
  isOurEntry,
  mergeHooks,
  parseSettings,
  stripOurHooks,
  type Settings,
} from '../src/core/settings';

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

test('reinstall also removes our entries under events VDP no longer registers', () => {
  const stale: Settings = {
    hooks: {
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'node "/old/dist/vdp.js" hook post-tool-use' }] },
      ],
      Custom: [{ hooks: [{ type: 'command', command: 'mine' }] }],
    },
  };
  const merged = mergeHooks(stale, '/new/vdp.js');
  assert.equal(merged.hooks?.PostToolUse, undefined);
  assert.deepEqual(merged.hooks?.Custom, stale.hooks?.Custom);
});

test('merge keeps the position of existing hook events', () => {
  const settings: Settings = {
    hooks: {
      PreCompact: [{ hooks: [{ type: 'command', command: 'a' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node "/x/vdp.js" hook claude-code stop' }] }],
      PostToolUse: [],
    },
  };
  const keys = Object.keys(mergeHooks(settings, '/x/vdp.js').hooks ?? {});
  assert.deepEqual(keys.slice(0, 3), ['PreCompact', 'Stop', 'PostToolUse']);
});

test('a foreign command that merely mentions vdp.js is not ours', () => {
  assert.equal(isOurEntry({ hooks: [{ command: 'cat ~/notes/vdp.js' }] }), false);
  assert.equal(isOurEntry({ hooks: [{ command: 'node "/a/vdp.js" hook stop' }] }), true);
});

test('an entry mixing our command with a foreign one is a collision for merge and strip', () => {
  const mixed: Settings = {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'node "/x/vdp.js" hook claude-code stop' },
            { type: 'command', command: 'say done' },
          ],
        },
      ],
    },
  };
  assert.throws(() => mergeHooks(mixed, '/x/vdp.js'), SettingsError);
  assert.throws(() => stripOurHooks(mixed), SettingsError);
});

test('settings with an unexpected shape are rejected instead of replaced', () => {
  assert.deepEqual(parseSettings(null), {});
  for (const bad of [[], 'x', 42, { hooks: [] }, { hooks: 'x' }, { hooks: { Stop: {} } }]) {
    assert.throws(() => parseSettings(bad), SettingsError, JSON.stringify(bad));
  }
  const ok = { model: 'opus', hooks: { Stop: [] } };
  assert.equal(parseSettings(ok), ok);
});

test('strip leaves settings without our hooks untouched', () => {
  const settings: Settings = { hooks: { Stop: [] }, theme: 'dark' };
  const { cleaned, removed } = stripOurHooks(settings);
  assert.equal(removed, 0);
  assert.equal(cleaned, settings);
});
