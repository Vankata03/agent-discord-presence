/**
 * A JSON config file VDP shares with a coding tool and the user (Claude Code's
 * settings.json, Codex's hooks.json). Installer adapters change only their own
 * entries in it, so every write here:
 *   - validates first, and fails without writing on unreadable or malformed
 *     content (a broken file is never silently replaced);
 *   - happens only when the result differs from what is on disk;
 *   - backs up the exact original bytes of a non-empty file beforehand, never
 *     overwriting an earlier backup;
 *   - edits the text in place (core/json-text.ts), so everything VDP did not
 *     change keeps its exact bytes.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { writeTextAtomic } from './json-file';
import { formatJson, rewriteJson } from './json-text';

export interface SharedJsonSnapshot<T> {
  /** Original bytes, or null when the file does not exist. */
  bytes: Buffer | null;
  raw: string;
  value: T;
}

export interface WriteOutcome {
  written: string[];
  backups: string[];
}

export class SharedJsonFile<T extends object> {
  constructor(
    readonly path: string,
    /** Shape check for the parsed value (null = missing file); throws when malformed. */
    private readonly validate: (parsed: unknown) => T,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Read and validate. Throws on unreadable or malformed content. */
  read(): SharedJsonSnapshot<T> {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { bytes: null, raw: '', value: this.validate(null) };
      }
      throw err;
    }
    const raw = bytes.toString('utf8');
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    let parsed: unknown;
    try {
      parsed = body.trim() === '' ? null : JSON.parse(body);
    } catch (err) {
      throw new Error(`${basename(this.path)} is not valid JSON (${(err as Error).message})`);
    }
    return { bytes, raw, value: this.validate(parsed) };
  }

  /**
   * Write `next` if it changes the file, backing up a non-empty original first.
   * With `removeIfEmpty`, an empty `next` deletes the file instead (for a file
   * only VDP's entries kept alive).
   */
  write(
    snapshot: SharedJsonSnapshot<T>,
    next: T,
    options: { removeIfEmpty?: boolean } = {},
  ): WriteOutcome {
    const { bytes, raw, value } = snapshot;
    const remove = options.removeIfEmpty === true && Object.keys(next).length === 0;
    if (remove && !bytes) return { written: [], backups: [] };
    const text = remove ? '' : bytes ? rewriteJson(raw, value, next) : formatJson(next);
    if (!remove && bytes && text === raw) return { written: [], backups: [] };
    const backups = bytes && Object.keys(value).length > 0 ? [this.backup(bytes)] : [];
    if (remove) rmSync(this.path, { force: true });
    else writeTextAtomic(this.path, text);
    return { written: [this.path], backups };
  }

  /** True when `name` (in this file's dir) is one of our backups or temp files. */
  private isOwnArtifact(name: string): boolean {
    const file = basename(this.path);
    return name.startsWith(`${file}.`) && (name.endsWith('.bak') || name.endsWith('.tmp'));
  }

  /** True when the file's directory holds anything besides this file's backups and temp files. */
  dirHasForeignEntries(ignore: readonly string[] = []): boolean {
    try {
      return readdirSync(dirname(this.path)).some(
        (name) => !ignore.includes(name) && !this.isOwnArtifact(name),
      );
    } catch {
      return false;
    }
  }

  private backup(bytes: Buffer): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    for (let n = 0; ; n++) {
      const path = `${this.path}.${stamp}${n === 0 ? '' : `-${n}`}.bak`;
      try {
        writeFileSync(path, bytes, { flag: 'wx' });
        return path;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }
}
