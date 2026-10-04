import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGeminiTranscript } from '../src/provider/gemini-cli-transcript';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/gemini-cli/0.62.0');
const lines = (name: string) => readFileSync(join(FIXTURES, name), 'utf8').trim().split('\n');
const LINES = lines('transcript.jsonl');

let dir: string;
let path: string;
let session = 0;
let identity: { provider: 'gemini-cli'; sessionId: string };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vdp-gemini-transcript-'));
  path = join(dir, 'session.jsonl');
  // A fresh identity per test so the reader's cache never carries over.
  identity = { provider: 'gemini-cli', sessionId: `session-${++session}` };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => readGeminiTranscript(path, identity);
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const META = line({
  sessionId: 's',
  projectHash: 'p',
  startTime: 't',
  lastUpdated: 't',
  kind: 'main',
});
const gemini = (id: string, output: number | null, model = 'gemini-3.1-pro-preview') =>
  line({
    id,
    type: 'gemini',
    content: '',
    model,
    tokens: output === null ? null : { input: 100, output, total: 100 + output },
  });
/** The fixture up to (not including) the first line matching `pattern`. */
const until = (pattern: RegExp) =>
  `${LINES.slice(
    0,
    LINES.findIndex((l) => pattern.test(l)),
  ).join('\n')}\n`;

test('captured transcript: the latest model and output tokens folded by message id', () => {
  writeFileSync(path, `${LINES.join('\n')}\n`);
  // Five Gemini messages (91 + 98 + 105 + 112 + 126) across a first run and two
  // resumes. Summing every record would give 833; Gemini's own loader, which
  // takes the resume restatements literally, would keep only 238.
  assert.deepEqual(read(), { model: 'gemini-3.1-pro-preview', tokens: 532 });
});

test('captured transcript: a message re-appended with tool calls counts once', () => {
  // 3b058ba4 is written twice (tokens, then tokens plus tool calls).
  writeFileSync(path, until(/"id":"970eadd0/));
  assert.deepEqual(read(), { model: 'gemini-3.1-pro-preview', tokens: 91 });
});

test('captured transcript: the model follows the latest turn, including a switch back', () => {
  // The first resume ran with `-m gemini-3-flash`, recorded as its resolved name.
  writeFileSync(path, until(/"id":"51dc9e07/));
  assert.deepEqual(read(), { model: 'gemini-3.8-flash', tokens: 406 });
  appendFileSync(
    path,
    `${LINES.slice(LINES.findIndex((l) => /"id":"51dc9e07/.test(l))).join('\n')}\n`,
  );
  assert.deepEqual(read(), { model: 'gemini-3.1-pro-preview', tokens: 532 });
});

test('captured permission transcript: an approved tool turn', () => {
  writeFileSync(path, `${lines('transcript-permission.jsonl').join('\n')}\n`);
  assert.deepEqual(read(), { model: 'gemini-3.1-pro-preview', tokens: 63 });
});

test('captured resume stub: metadata and a restated history yield no facts, not zero', () => {
  // On resume, SessionStart's transcript_path can name this short-lived file.
  writeFileSync(path, `${lines('transcript-resume-stub.jsonl').join('\n')}\n`);
  assert.deepEqual(read(), {});
});

test('a later record for the same message replaces its tokens instead of adding to them', () => {
  writeFileSync(path, META + gemini('m1', 10) + gemini('m1', 25) + gemini('m2', 5));
  assert.deepEqual(read(), { model: 'gemini-3.1-pro-preview', tokens: 30 });
});

test('a restatement without tokens or model keeps what was already recorded', () => {
  writeFileSync(path, META + gemini('m1', 10, 'gemini-a') + gemini('m2', 20, 'gemini-b'));
  appendFileSync(
    path,
    line({
      $set: {
        messages: [
          { id: 'm1', type: 'gemini', content: '' },
          { id: 'm2', type: 'gemini', content: '' },
        ],
      },
    }),
  );
  assert.deepEqual(read(), { model: 'gemini-b', tokens: 30 });
});

test('a rewind keeps the tokens already spent', () => {
  writeFileSync(path, META + gemini('m1', 10) + gemini('m2', 20) + line({ $rewindTo: 'm2' }));
  assert.equal(read().tokens, 30);
});

test('a message whose tokens have not arrived adds nothing, and no tokens means none', () => {
  writeFileSync(path, META + line({ id: 'u1', type: 'user', content: [{ text: 'hi' }] }));
  assert.deepEqual(read(), {});
  appendFileSync(path, gemini('m1', null));
  assert.deepEqual(read(), { model: 'gemini-3.1-pro-preview' });
  appendFileSync(path, gemini('m1', 12));
  assert.deepEqual(read(), { model: 'gemini-3.1-pro-preview', tokens: 12 });
});

test('an incomplete trailing record waits until its line is finished', () => {
  const record = gemini('m2', 20);
  writeFileSync(path, META + gemini('m1', 10) + record.slice(0, 30));
  assert.equal(read().tokens, 10);
  appendFileSync(path, record.slice(30));
  assert.equal(read().tokens, 30);
});

test('unknown records, malformed lines and non-Gemini messages are ignored', () => {
  writeFileSync(
    path,
    META +
      gemini('m1', 10) +
      line({ $future: { anything: true } }) +
      '{"not json\n' +
      line({ id: 'u1', type: 'user', tokens: { output: 999 } }) +
      line({ id: 'm2', type: 'gemini', model: 'gemini-x', tokens: { output: 'many' } }) +
      line({ id: 'i1', type: 'info', model: 'not-a-model', content: 'note' }),
  );
  assert.deepEqual(read(), { model: 'gemini-x', tokens: 10 });
});

test('an unknown transcript schema yields no facts at all', () => {
  // Older Gemini CLI versions wrote one pretty-printed JSON document (`.json`).
  writeFileSync(
    path,
    JSON.stringify(
      { sessionId: 's', projectHash: 'p', messages: [JSON.parse(gemini('m1', 10))] },
      null,
      2,
    ) + '\n',
  );
  assert.deepEqual(read(), {});
  // A JSONL file that does not open with the session metadata is not ours either.
  writeFileSync(join(dir, 'other.jsonl'), gemini('m1', 10) + gemini('m2', 20));
  assert.deepEqual(readGeminiTranscript(join(dir, 'other.jsonl'), identity), {});
});

test('a missing or unset transcript yields no facts', () => {
  assert.deepEqual(read(), {});
  assert.deepEqual(readGeminiTranscript(undefined, identity), {});
});

test('a transcript rewritten in place is read again from the start', () => {
  writeFileSync(path, META + gemini('m1', 10) + gemini('m2', 20));
  assert.equal(read().tokens, 30);
  // Gemini rewrites an unreadable session through a temp file and a rename.
  const temp = join(dir, 'session.jsonl.tmp');
  writeFileSync(temp, META + gemini('m3', 7, 'gemini-y'));
  renameSync(temp, path);
  assert.deepEqual(read(), { model: 'gemini-y', tokens: 7 });
});

test('facts never carry over between session identities', () => {
  writeFileSync(path, META + gemini('m1', 10));
  assert.equal(read().tokens, 10);
  const other = join(dir, 'other.jsonl');
  writeFileSync(other, META);
  assert.deepEqual(readGeminiTranscript(other, { provider: 'gemini-cli', sessionId: 'x' }), {});
});
