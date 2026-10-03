/**
 * Minimal-diff edits to JSON text that other tools and the user also own.
 *
 * Re-serializing a whole settings file would reflow everything VDP did not
 * touch (inline arrays, spacing, key layout). Instead `rewriteJson` walks the
 * original text alongside the before/after values and rewrites only what
 * changed: object members whose values changed, and array elements that were
 * added or removed. Every untouched member and element keeps its exact bytes.
 * New or changed values follow the file's own layout: indent unit, line
 * endings, nesting, `key: value` spacing, and single-line containers stay on
 * one line.
 *
 * The input text must already be valid JSON (callers parse it first). Text
 * with duplicate keys, whose meaning differs between parsers, falls back to a
 * whole-document re-serialization in the detected layout.
 */

interface Layout {
  /** One indentation level ('' = compact single-line JSON). */
  unit: string;
  eol: '\n' | '\r\n';
}

/** One object member or array element in the original text. */
interface Item {
  /** Where the item starts: the key for a member, the value for an element. */
  start: number;
  valueStart: number;
  valueEnd: number;
  /** Member key; undefined for array elements. */
  key?: string;
  keyEnd?: number;
}

/** A piece of the rewritten container: its text and the original item it keeps, if any. */
interface Piece {
  text: string;
  index: number | null;
}

const DEFAULT_LAYOUT: Layout = { unit: '  ', eol: '\n' };

class DuplicateKeys extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function skipWs(t: string, i: number): number {
  while (i < t.length && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) i++;
  return i;
}

/** `t[i]` is an opening quote; returns the index just past the closing one. */
function scanString(t: string, i: number): number {
  for (i++; t[i] !== '"'; i++) if (t[i] === '\\') i++;
  return i + 1;
}

function scanValue(t: string, i: number): number {
  const c = t[i];
  if (c === '"') return scanString(t, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (; i < t.length; i++) {
      const ch = t[i];
      if (ch === '"') i = scanString(t, i) - 1;
      else if (ch === '{' || ch === '[') depth++;
      else if ((ch === '}' || ch === ']') && --depth === 0) return i + 1;
    }
    return i;
  }
  while (i < t.length && !/[\s,\]}]/.test(t[i] ?? '')) i++;
  return i;
}

/** `t[open]` is `{` or `[`; returns its items and the index of its closing bracket. */
function scanItems(t: string, open: number): { items: Item[]; close: number } {
  const isObject = t[open] === '{';
  const items: Item[] = [];
  let i = skipWs(t, open + 1);
  if (t[i] === '}' || t[i] === ']') return { items, close: i };
  for (;;) {
    const start = i;
    let keyEnd: number | undefined;
    if (isObject) {
      keyEnd = scanString(t, i);
      i = skipWs(t, skipWs(t, keyEnd) + 1); // past ':'
    }
    const valueEnd = scanValue(t, i);
    items.push({
      start,
      valueStart: i,
      valueEnd,
      keyEnd,
      key: keyEnd === undefined ? undefined : (JSON.parse(t.slice(start, keyEnd)) as string),
    });
    i = skipWs(t, valueEnd);
    if (t[i] !== ',') {
      if (isObject && new Set(items.map((m) => m.key)).size !== items.length) {
        throw new DuplicateKeys();
      }
      return { items, close: i };
    }
    i = skipWs(t, i + 1);
  }
}

/** Whitespace between the last line break before `pos` and `pos`, or null if none. */
function lineIndent(t: string, from: number, pos: number): string | null {
  const nl = t.lastIndexOf('\n', pos - 1);
  return nl < from ? null : t.slice(nl + 1, pos);
}

function detectLayout(t: string): Layout {
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  const open = t.indexOf('{');
  if (open < 0) return { ...DEFAULT_LAYOUT, eol };
  const first = scanItems(t, open).items[0];
  if (!first) return { ...DEFAULT_LAYOUT, eol };
  return { unit: lineIndent(t, open, first.start) ?? '', eol };
}

/** Serialize `value` to sit at a position whose line is indented by `indent`. */
function serializeAt(value: unknown, indent: string, layout: Layout): string {
  return JSON.stringify(value, null, layout.unit).replace(/\n/g, layout.eol + indent);
}

/** Where a container's items sit and how new ones are laid out. */
interface ItemLayout {
  /** Indentation of each item's line, or null when the container is on one line. */
  indent: string | null;
  sep: string;
  serialize: (value: unknown) => string;
}

function itemLayout(t: string, open: number, items: Item[], layout: Layout): ItemLayout {
  const [first, second] = items;
  const indent = first ? lineIndent(t, open, first.start) : null;
  const sep = second
    ? t.slice(first!.valueEnd, second.start)
    : indent !== null
      ? `,${layout.eol}${indent}`
      : layout.unit === ''
        ? ','
        : ', ';
  const serialize =
    indent !== null
      ? (value: unknown) => serializeAt(value, indent, layout)
      : (value: unknown) => JSON.stringify(value); // single-line containers stay single-line
  return { indent, sep, serialize };
}

/** Join pieces; originally adjacent items keep the separator they had. */
function assemble(
  t: string,
  open: number,
  close: number,
  items: Item[],
  pieces: Piece[],
  sep: string,
): string {
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return ''; // callers handle empty originals
  let out = t.slice(open, first.start);
  pieces.forEach((piece, j) => {
    if (j > 0) {
      const prevIndex = pieces[j - 1]?.index;
      const adjacent =
        prevIndex !== null && prevIndex !== undefined && piece.index === prevIndex + 1;
      out += adjacent ? t.slice(items[prevIndex]!.valueEnd, items[piece.index!]!.start) : sep;
    }
    out += piece.text;
  });
  return out + t.slice(last.valueEnd, close + 1);
}

/** Rewrite the value at `t[at]` from `before` to `after`; `indent` is its line's indentation. */
function patchValue(
  t: string,
  at: number,
  before: unknown,
  after: unknown,
  indent: string,
  layout: Layout,
): string {
  if (same(before, after)) return t.slice(at, scanValue(t, at));
  if (isPlainObject(before) && isPlainObject(after) && t[at] === '{') {
    return patchObject(t, at, before, after, indent, layout);
  }
  if (Array.isArray(before) && Array.isArray(after) && t[at] === '[') {
    return patchArray(t, at, before, after, indent, layout);
  }
  return serializeAt(after, indent, layout);
}

function patchObject(
  t: string,
  open: number,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  indent: string,
  layout: Layout,
): string {
  const { items, close } = scanItems(t, open);
  const keys = Object.keys(after);
  if (keys.length === 0) return '{}';
  const first = items[0];
  if (!first || first.keyEnd === undefined) return serializeAt(after, indent, layout);

  const { indent: own, sep, serialize } = itemLayout(t, open, items, layout);
  const colon = t.slice(first.keyEnd, first.valueStart);
  const byKey = new Map(items.map((m, index) => [m.key, index]));
  const pieces = keys.map((key): Piece => {
    const index = byKey.get(key);
    const m = index === undefined ? undefined : items[index];
    if (index === undefined || !m) {
      return { text: `${JSON.stringify(key)}${colon}${serialize(after[key])}`, index: null };
    }
    const value = patchValue(t, m.valueStart, before[key], after[key], own ?? indent, layout);
    return { text: t.slice(m.start, m.valueStart) + value, index };
  });
  return assemble(t, open, close, items, pieces, sep);
}

/**
 * Arrays keep every element that survives unchanged (matched in order), drop
 * removed ones, and serialize only new or changed elements.
 */
function patchArray(
  t: string,
  open: number,
  before: unknown[],
  after: unknown[],
  indent: string,
  layout: Layout,
): string {
  const { items, close } = scanItems(t, open);
  if (after.length === 0) return '[]';
  if (items.length === 0) return serializeAt(after, indent, layout);

  const { sep, serialize } = itemLayout(t, open, items, layout);
  let cursor = 0;
  const pieces = after.map((value): Piece => {
    for (let k = cursor; k < before.length; k++) {
      const item = items[k];
      if (item && same(before[k], value)) {
        cursor = k + 1;
        return { text: t.slice(item.start, item.valueEnd), index: k };
      }
    }
    return { text: serialize(value), index: null };
  });
  return assemble(t, open, close, items, pieces, sep);
}

/** Default layout for a file VDP creates: two-space indent, trailing newline. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, DEFAULT_LAYOUT.unit)}\n`;
}

/**
 * Return `text` (which parses to `before`) edited to represent `after`, with
 * untouched members and elements byte-for-byte intact. A leading BOM, leading
 * whitespace and trailing text around the root object are preserved too.
 */
export function rewriteJson(text: string, before: unknown, after: unknown): string {
  const open = text.indexOf('{');
  if (open < 0 || !isPlainObject(before) || !isPlainObject(after)) return formatJson(after);
  const end = scanValue(text, open);
  let body: string;
  try {
    body = patchObject(text, open, before, after, '', detectLayout(text));
  } catch (err) {
    if (!(err instanceof DuplicateKeys)) throw err;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    body = serializeAt(after, '', { ...DEFAULT_LAYOUT, eol });
  }
  return text.slice(0, open) + body + text.slice(end);
}
