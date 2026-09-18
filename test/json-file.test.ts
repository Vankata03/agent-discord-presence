import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, readJsonIfExists, writeJsonAtomic } from '../src/core/json-file';

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'vdp-json-'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('readJson parses a BOM-prefixed file', () => {
  const p = join(root, 'bom.json');
  writeFileSync(p, '\ufeff{"a":1}');
  assert.deepEqual(readJson(p), { a: 1 });
});

test('readJson returns null for a missing file', () => {
  assert.equal(readJson(join(root, 'missing.json')), null);
});

test('readJson returns null for corrupt input', () => {
  const p = join(root, 'corrupt.json');
  writeFileSync(p, '{"a":');
  assert.equal(readJson(p), null);
});

test('readJsonIfExists returns null only for a missing file and rethrows corrupt input', () => {
  assert.equal(readJsonIfExists(join(root, 'missing.json')), null);
  const p = join(root, 'corrupt2.json');
  writeFileSync(p, 'nope');
  assert.throws(() => readJsonIfExists(p), SyntaxError);
});

test('writeJsonAtomic creates parent directories and leaves no temp file', () => {
  const p = join(root, 'nested', 'deeper', 'out.json');
  writeJsonAtomic(p, { hello: 'world' });
  assert.equal(readFileSync(p, 'utf8'), '{"hello":"world"}');
  assert.deepEqual(readdirSync(join(root, 'nested', 'deeper')), ['out.json']);
});

test('writeJsonAtomic pretty-prints with a trailing newline when asked', () => {
  const p = join(root, 'pretty.json');
  writeJsonAtomic(p, { theme: 'minimal', overrides: {} }, { pretty: true });
  assert.equal(readFileSync(p, 'utf8'), '{\n  "theme": "minimal",\n  "overrides": {}\n}\n');
  assert.ok(!existsSync(`${p}.${process.pid}.tmp`));
});
