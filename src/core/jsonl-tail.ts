/**
 * Incremental JSONL folding for daemon-side enrichment readers.
 *
 * A reader keeps one fold state per cache key (a session identity) and feeds it
 * only the complete lines appended since its last read, so a long session
 * costs no more per tick than a short one. A trailing line without its newline
 * is still being written, so it waits for the next read. A different file at
 * the path (a new inode), or one rewritten rather than appended to (it shrank,
 * or changed without growing), is folded again from the start into a fresh
 * state. Reads never throw: an unreadable file yields undefined.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

interface Entry<S> {
  path: string;
  /** Identifies the file itself, so a replacement at the same path is noticed. */
  ino: number;
  /** Bytes consumed so far: always the end of a complete line. */
  offset: number;
  size: number;
  mtimeMs: number;
  state: S;
}

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

export class JsonlTail<S> {
  private readonly cache = new Map<string, Entry<S>>();

  constructor(
    /** A fresh fold state, for a new file or one that must be re-read. */
    private readonly fresh: () => S,
    /** Fold one complete line (without its newline) into the state. */
    private readonly consume: (state: S, line: string) => void,
    private readonly maxEntries = 32,
  ) {}

  /** The state folded from `path`, cached under `key`; undefined when unreadable. */
  read(path: string, key: string): S | undefined {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return undefined;
    }
    try {
      const st = fstatSync(fd);
      let entry = this.cache.get(key);
      if (
        !entry ||
        entry.path !== path ||
        entry.ino !== st.ino ||
        st.size < entry.offset ||
        (st.size === entry.size && st.mtimeMs !== entry.mtimeMs)
      ) {
        entry = { path, ino: st.ino, offset: 0, size: 0, mtimeMs: 0, state: this.fresh() };
      }
      if (entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
        this.readAppended(entry, fd, st.size);
        entry.size = st.size;
        entry.mtimeMs = st.mtimeMs;
      }
      this.cache.delete(key);
      this.cache.set(key, entry);
      while (this.cache.size > this.maxEntries) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      return entry.state;
    } catch {
      return undefined;
    } finally {
      closeSync(fd);
    }
  }

  /** Fold the complete lines appended since `entry.offset`. */
  private readAppended(entry: Entry<S>, fd: number, size: number): void {
    let pending = Buffer.alloc(0);
    let position = entry.offset;
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      position += read;
      const data =
        pending.length > 0
          ? Buffer.concat([pending, chunk.subarray(0, read)])
          : chunk.subarray(0, read);
      const lastNewline = data.lastIndexOf(NEWLINE);
      if (lastNewline < 0) {
        pending = data;
        continue;
      }
      for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
        this.consume(entry.state, line);
      }
      entry.offset += lastNewline + 1;
      pending = data.subarray(lastNewline + 1);
    }
  }
}
