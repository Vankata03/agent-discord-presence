import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJson, rewriteJson } from '../src/core/json-text';

/** Rewrite `text` with `edit` applied to its parsed value. */
function edit(text: string, change: (value: Record<string, unknown>) => void): string {
  const before = JSON.parse(text.replace(/^\ufeff/, '')) as Record<string, unknown>;
  const after = structuredClone(before);
  change(after);
  return rewriteJson(text, before, after);
}

test('an unchanged value returns the exact text', () => {
  const text = '\ufeff  {"a" :  [1,2],\n"b":{ "c": true }}  \n';
  assert.equal(
    edit(text, () => {}),
    text,
  );
});

test('adding a member keeps every other byte and follows the file layout', () => {
  const text = '{\n    "allow": ["Bash(ls)"],\n    "model": "opus"\n}\n';
  assert.equal(
    edit(text, (v) => (v.hooks = { Stop: [] })),
    '{\n    "allow": ["Bash(ls)"],\n    "model": "opus",\n    "hooks": {\n        "Stop": []\n    }\n}\n',
  );
});

test('compact files stay compact', () => {
  assert.equal(
    edit('{"a":1}', (v) => (v.b = [2])),
    '{"a":1,"b":[2]}',
  );
});

test('removing a member restores its neighbours separators', () => {
  const text = '{\r\n\t"a": [ 1 ],\r\n\t"b": 2,\r\n\t"c": 3\r\n}';
  assert.equal(
    edit(text, (v) => delete v.b),
    '{\r\n\t"a": [ 1 ],\r\n\t"c": 3\r\n}',
  );
  assert.equal(
    edit(text, (v) => delete v.c),
    '{\r\n\t"a": [ 1 ],\r\n\t"b": 2\r\n}',
  );
});

test('nested objects are patched member by member', () => {
  const text = '{\n  "hooks": {\n    "Keep":   [ "x" ],\n    "Stop": []\n  }\n}\n';
  assert.equal(
    edit(text, (v) => ((v.hooks as Record<string, unknown>).Stop = [{ a: 1 }])),
    '{\n  "hooks": {\n    "Keep":   [ "x" ],\n    "Stop": [\n      {\n        "a": 1\n      }\n    ]\n  }\n}\n',
  );
});

test('an empty object gets the default layout', () => {
  assert.equal(
    edit('{}\n', (v) => (v.a = 1)),
    '{\n  "a": 1\n}\n',
  );
  assert.equal(
    edit('{"a":1}\n', (v) => delete v.a),
    '{}\n',
  );
});

test('duplicate keys fall back to a full re-serialization', () => {
  assert.equal(rewriteJson('{"a":1,"a":2}', { a: 2 }, { a: 2, b: 3 }), '{\n  "a": 2,\n  "b": 3\n}');
});

test('formatJson matches the layout VDP has always written', () => {
  assert.equal(formatJson({ a: 1 }), '{\n  "a": 1\n}\n');
});

test('array elements that survive keep their exact text', () => {
  const text = '{\n  "Stop": [ { "hooks": [ "say done" ] } ]\n}\n';
  const before = JSON.parse(text) as { Stop: unknown[] };
  const added = { Stop: [...before.Stop, { hooks: ['ours'] }] };
  const withOurs = rewriteJson(text, before, added);
  assert.equal(withOurs, '{\n  "Stop": [ { "hooks": [ "say done" ] }, {"hooks":["ours"]} ]\n}\n');
  assert.equal(rewriteJson(withOurs, added, before), text, 'removing ours restores the original');
});

test('multi-line arrays get new elements on their own lines', () => {
  const text = '{\n  "Stop": [\n    {"a": 1},\n    {"b": 2}\n  ]\n}';
  const before = JSON.parse(text) as { Stop: unknown[] };
  assert.equal(
    rewriteJson(text, before, { Stop: [{ c: 3 }, { a: 1 }] }),
    '{\n  "Stop": [\n    {\n      "c": 3\n    },\n    {"a": 1}\n  ]\n}',
  );
});
