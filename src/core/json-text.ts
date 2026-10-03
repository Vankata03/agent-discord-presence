/**
 * Minimal-diff edits to JSON text that other tools and the user also own.
 *
 * Re-serializing a whole settings file would reflow everything VDP did not
 * touch (inline arrays, spacing, key layout). Instead `rewriteJson` walks the
 * original text alongside the before/after values and rewrites only the object
 * members whose values changed, so every untouched member keeps its exact
 * bytes. New or changed values are serialized in the file's own layout:
 * indent unit, line endings, member nesting, and `key: value` spacing.
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

interface Member {
  key: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
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

/** `t[open]` is `{`; returns its members and the index of its `}`. */
function scanMembers(t: string, open: number): { members: Member[]; close: number } {
  const members: Member[] = [];
  let i = skipWs(t, open + 1);
  if (t[i] === '}') return { members, close: i };
  for (;;) {
    const keyStart = i;
    const keyEnd = scanString(t, i);
    const valueStart = skipWs(t, skipWs(t, keyEnd) + 1); // past ':'
    const valueEnd = scanValue(t, valueStart);
    members.push({
      key: JSON.parse(t.slice(keyStart, keyEnd)) as string,
      keyStart,
      keyEnd,
      valueStart,
      valueEnd,
    });
    i = skipWs(t, valueEnd);
    if (t[i] !== ',') {
      if (new Set(members.map((m) => m.key)).size !== members.length) throw new DuplicateKeys();
      return { members, close: i };
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
  const { members } = scanMembers(t, open);
  const first = members[0];
  if (!first) return { ...DEFAULT_LAYOUT, eol };
  return { unit: lineIndent(t, open, first.keyStart) ?? '', eol };
}

/** Serialize `value` to sit at a position whose line is indented by `indent`. */
function serializeAt(value: unknown, indent: string, layout: Layout): string {
  return JSON.stringify(value, null, layout.unit).replace(/\n/g, layout.eol + indent);
}

/**
 * Rewrite the object spanning `t[open]..` from `before` to `after`, keeping
 * the bytes of every member whose value did not change. `indent` is the
 * indentation of the line the object starts on.
 */
function patchObject(
  t: string,
  open: number,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  indent: string,
  layout: Layout,
): string {
  const { members, close } = scanMembers(t, open);
  const keys = Object.keys(after);
  if (keys.length === 0) return '{}';
  const first = members[0];
  const last = members[members.length - 1];
  if (!first || !last) return serializeAt(after, indent, layout);

  const ownLine = lineIndent(t, open, first.keyStart);
  // An object written inline inside a pretty file has no member layout to copy.
  if (ownLine === null && layout.unit !== '') return serializeAt(after, indent, layout);
  const memberIndent = ownLine ?? '';
  const colon = t.slice(first.keyEnd, first.valueStart);
  const defaultSep = members[1]
    ? t.slice(first.valueEnd, members[1].keyStart)
    : layout.unit === ''
      ? ','
      : `,${layout.eol}${memberIndent}`;

  const byKey = new Map(members.map((m, index) => [m.key, { m, index }]));
  const pieces: Array<{ text: string; index: number | null }> = keys.map((key) => {
    const found = byKey.get(key);
    const value = after[key];
    if (!found) {
      return {
        text: `${JSON.stringify(key)}${colon}${serializeAt(value, memberIndent, layout)}`,
        index: null,
      };
    }
    const { m, index } = found;
    const old = before[key];
    let valueText: string;
    if (same(old, value)) valueText = t.slice(m.valueStart, m.valueEnd);
    else if (isPlainObject(old) && isPlainObject(value) && t[m.valueStart] === '{') {
      valueText = patchObject(t, m.valueStart, old, value, memberIndent, layout);
    } else valueText = serializeAt(value, memberIndent, layout);
    return { text: t.slice(m.keyStart, m.valueStart) + valueText, index };
  });

  // Members that were neighbours originally keep their original separator.
  let out = t.slice(open, first.keyStart);
  pieces.forEach((piece, j) => {
    if (j > 0) {
      const prev = members[pieces[j - 1]?.index ?? -1];
      const next = piece.index === null ? undefined : members[piece.index];
      const adjacent = prev && next && members.indexOf(next) === members.indexOf(prev) + 1;
      out += adjacent ? t.slice(prev.valueEnd, next.keyStart) : defaultSep;
    }
    out += piece.text;
  });
  return out + t.slice(last.valueEnd, close + 1);
}

/** Default layout for a file VDP creates: two-space indent, trailing newline. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, DEFAULT_LAYOUT.unit)}\n`;
}

/**
 * Return `text` (which parses to `before`) edited to represent `after`, with
 * untouched members byte-for-byte intact. A leading BOM, leading whitespace
 * and trailing text around the root object are preserved too.
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
