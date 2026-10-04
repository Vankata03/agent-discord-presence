import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPresence } from '../src/core/presence';
import { SessionStore } from '../src/core/session-store';
import { createReconcileTick, type PresenceSink } from '../src/daemon/reconcile';
import { readCodexRollout } from '../src/provider/codex-rollout';
import { createEnrichmentDispatcher } from '../src/provider/enrichment';
import type { PresencePayload, Theme } from '../src/types';

const FIXTURE = join(import.meta.dirname, 'fixtures/codex/0.160.0/rollout.jsonl');
const LINES = readFileSync(FIXTURE, 'utf8').trim().split('\n');

let dir: string;
let path: string;
let session = 0;
let identity: { provider: 'codex'; sessionId: string };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vdp-rollout-'));
  path = join(dir, 'rollout.jsonl');
  // A fresh identity per test so the reader's cache never carries over.
  identity = { provider: 'codex', sessionId: `session-${++session}` };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => readCodexRollout(path, identity);
const record = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-10-04T00:00:00Z', type, payload })}\n`;
const META = record('session_meta', { id: 's', cli_version: '0.160.0' });
const turn = (model: string) => record('turn_context', { model });
const tokens = (output: number) =>
  record('event_msg', {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 1, output_tokens: output } },
  });

test('captured rollout: the latest turn model and the latest cumulative token snapshot', () => {
  writeFileSync(path, `${LINES.join('\n')}\n`);
  // Snapshots are 7, 21, 42, 77, 77, 84, 84, 98, 119, 147, 182: summing would be wrong.
  assert.deepEqual(read(), { model: 'gpt-5.6-sol', tokens: 182 });
});

test('reads only what was appended, as the session grows', () => {
  const cut = LINES.findIndex((line) => line.includes('"thread_settings_applied"'));
  writeFileSync(path, `${LINES.slice(0, cut).join('\n')}\n`);
  assert.deepEqual(read(), { model: 'gpt-5.5-codex', tokens: 77 });
  appendFileSync(path, `${LINES.slice(cut).join('\n')}\n`);
  assert.deepEqual(read(), { model: 'gpt-5.6-sol', tokens: 182 });
});

test('an incomplete trailing record is ignored until its line is finished', () => {
  const line = tokens(500);
  writeFileSync(path, META + turn('gpt-5.5-codex') + tokens(10) + line.slice(0, 40));
  assert.deepEqual(read(), { model: 'gpt-5.5-codex', tokens: 10 });
  appendFileSync(path, line.slice(40));
  assert.deepEqual(read(), { model: 'gpt-5.5-codex', tokens: 500 });
});

test('unknown records, malformed lines and drifted shapes are skipped', () => {
  writeFileSync(
    path,
    META +
      turn('gpt-5.5-codex') +
      tokens(30) +
      '{not json\n' +
      '[1,2]\n' +
      record('brand_new_record', { model: 'not-a-turn', output_tokens: 9999 }) +
      record('event_msg', { type: 'token_count', info: null }) +
      record('event_msg', {
        type: 'token_count',
        info: { total_token_usage: { output_tokens: '1' } },
      }) +
      record('event_msg', {
        type: 'token_count',
        info: { last_token_usage: { output_tokens: 3 } },
      }) +
      record('turn_context', { model: 42 }) +
      record('turn_context', null),
  );
  assert.deepEqual(read(), { model: 'gpt-5.5-codex', tokens: 30 });
});

test('an unsupported rollout schema yields no facts at all', () => {
  for (const first of [
    // The legacy rollout format: a bare session header, no record envelope.
    `${JSON.stringify({ id: 's', timestamp: 't', instructions: null })}\n`,
    record('session_meta', { id: 's' }), // no cli_version
    record('turn_context', { model: 'gpt-5.5-codex' }),
    '{broken first line\n',
  ]) {
    identity = { provider: 'codex', sessionId: `session-${++session}` };
    writeFileSync(path, first + turn('gpt-5.5-codex') + tokens(30));
    assert.deepEqual(read(), {}, first);
  }
});

test('a session header still being written yields nothing yet', () => {
  writeFileSync(path, META.slice(0, 20));
  assert.deepEqual(read(), {});
  appendFileSync(path, META.slice(20) + tokens(5));
  assert.deepEqual(read(), { tokens: 5 });
});

test('a rewritten (shorter) rollout is read again from the start', () => {
  writeFileSync(path, META + turn('gpt-5.5-codex') + tokens(900));
  assert.deepEqual(read(), { model: 'gpt-5.5-codex', tokens: 900 });
  writeFileSync(path, META + tokens(4));
  assert.deepEqual(read(), { tokens: 4 });
});

test('a missing rollout or reference yields no facts', () => {
  assert.deepEqual(readCodexRollout(undefined, identity), {});
  assert.deepEqual(read(), {});
});

test('cached facts never cross session identities', () => {
  writeFileSync(path, META + tokens(50));
  assert.deepEqual(read(), { tokens: 50 });
  const other = join(dir, 'other.jsonl');
  writeFileSync(other, META + turn('gpt-6-luna'));
  assert.deepEqual(readCodexRollout(other, { provider: 'codex', sessionId: 'other' }), {
    model: 'gpt-6-luna',
  });
  assert.deepEqual(read(), { tokens: 50 });
});

test('in the daemon tick, the hook model wins and rollout tokens fill the gap', async () => {
  writeFileSync(path, `${LINES.join('\n')}\n`);
  const store = new SessionStore(dir);
  store.record(
    { provider: 'codex', sessionId: 'live' },
    { model: 'gpt-5.5-codex', enrichmentRef: path, activity: 'Thinking' },
    1_000,
    true,
  );
  const theme: Theme = {
    details: '{model}',
    state: '{tokens}',
    largeImage: { key: 'logo', text: '' },
    smallImage: { key: 'logo', text: '' },
    timer: false,
    buttons: [],
  };
  const payloads: PresencePayload[] = [];
  const sink: PresenceSink = {
    isConnected: true,
    setActivity: async (payload) => {
      payloads.push(payload);
    },
    clearActivity: async () => {},
  };
  const tick = createReconcileTick({
    store,
    loadConfig: () => ({ theme }),
    enrich: createEnrichmentDispatcher({
      readers: { codex: (reference, id) => readCodexRollout(reference, id) },
      resolveBranch: () => undefined,
    }),
    sink,
    writeStatus: () => {},
    pid: 1,
  });

  assert.equal(await tick(1_000), 'active');
  const expected = renderPresence(
    theme,
    { provider: 'codex', sessionId: 'live', sessionCount: 1, startedAt: 1_000, tokens: 182 },
    1_000,
  );
  assert.equal(payloads[0]?.details, 'gpt-5.5-codex');
  assert.equal(payloads[0]?.state, expected.state);
});
