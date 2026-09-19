import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptMeta } from '../src/provider/transcript';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('transcript cache preserves a same-session read during file truncation', () => {
  const root = mkdtempSync(join(tmpdir(), 'vdp-transcript-'));
  roots.push(root);
  const path = join(root, 'session.jsonl');
  const identity = { provider: 'claude-code', sessionId: 'session-1' } as const;
  writeFileSync(
    path,
    `${JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { output_tokens: 42 } } })}\n`,
  );
  assert.deepEqual(readTranscriptMeta(path, identity), {
    model: 'Opus 4.8',
    branch: undefined,
    tokens: 42,
  });

  writeFileSync(path, '{');
  assert.deepEqual(readTranscriptMeta(path, identity), {
    model: 'Opus 4.8',
    branch: undefined,
    tokens: 42,
  });

  writeFileSync(
    path,
    `${JSON.stringify({ message: { model: 'claude-haiku-4-5', usage: { output_tokens: 7 } } })}\n`,
  );
  assert.deepEqual(readTranscriptMeta(path, identity), {
    model: 'Haiku 4.5',
    branch: undefined,
    tokens: 7,
  });
});

test('transcript cache never crosses a changed session identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'vdp-transcript-'));
  roots.push(root);
  const path = join(root, 'session.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { output_tokens: 42 } } })}\n`,
  );
  assert.equal(
    readTranscriptMeta(path, { provider: 'claude-code', sessionId: 'session-1' }).tokens,
    42,
  );

  writeFileSync(path, '{');
  assert.deepEqual(readTranscriptMeta(path, { provider: 'claude-code', sessionId: 'session-2' }), {
    model: undefined,
    branch: undefined,
    tokens: undefined,
  });
});
