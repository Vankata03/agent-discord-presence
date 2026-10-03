/**
 * Hook maps shared by coding tools that register command hooks as
 * `{ "<Event>": [ { matcher?, hooks: [ { type: "command", command } ] } ] }`
 * (Claude Code's settings.json, Codex's hooks.json).
 *
 * A provider supplies the ownership rule for its own commands and the groups
 * it installs; these functions apply that rule without touching anything else:
 *   - a group is ours only when every command in it is ours. A group mixing
 *     our command with a foreign one is an ownership collision: removing it
 *     would delete a foreign hook and keeping it would leave ours behind, so
 *     merge and strip both refuse it and the user resolves it by hand;
 *   - merge replaces our group in place and appends only when the event has
 *     none, so every other group keeps its position (Codex keys hook trust by
 *     position, so shifting a foreign group would revoke the user's approval);
 *   - strip removes only our groups and drops an event only when we emptied it.
 */

export interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

export type HookMap = Record<string, HookGroup[]>;

export interface HookOwnership {
  /** The file name used in error messages, e.g. `settings.json`. */
  file: string;
  /** True for a command VDP wrote for this provider. */
  isOurCommand: (command: string) => boolean;
  /** Our events in registration order, each with the group to install. */
  groups: () => ReadonlyArray<{ event: string; group: HookGroup }>;
}

/** A hook configuration VDP must not rewrite: malformed, or an ownership collision. */
export class HookConfigError extends Error {
  override name = 'HookConfigError';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check a parsed `hooks` value: absent, or an object of event -> array. */
export function validateHookMap(value: unknown, file: string): HookMap | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new HookConfigError(`${file} "hooks" is not an object`);
  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) {
      throw new HookConfigError(`${file} "hooks.${event}" is not an array`);
    }
  }
  return value as HookMap;
}

type Ownership = 'ours' | 'foreign' | 'mixed';

function ownership(group: unknown, rules: HookOwnership): Ownership {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return 'foreign';
  const ours = group.hooks.filter(
    (h) => isPlainObject(h) && typeof h.command === 'string' && rules.isOurCommand(h.command),
  ).length;
  if (ours === 0) return 'foreign';
  return ours === group.hooks.length ? 'ours' : 'mixed';
}

/** True when every command in the group is ours. */
export function isOwnedGroup(group: HookGroup, rules: HookOwnership): boolean {
  return ownership(group, rules) === 'ours';
}

function assertNoCollision(hooks: HookMap, rules: HookOwnership): void {
  const events = Object.entries(hooks)
    .filter(([, groups]) => groups.some((g) => ownership(g, rules) === 'mixed'))
    .map(([event]) => event);
  if (events.length > 0) {
    throw new HookConfigError(
      `${rules.file} mixes a vdp hook with another command in one entry (${events.join(', ')}); ` +
        'split that entry by hand so each tool owns its own entry',
    );
  }
}

/**
 * Install our groups: replace our existing group for each event in place, drop
 * duplicates and our groups under events we no longer register, and append
 * where an event has none. Idempotent; key order of existing events is kept.
 */
export function mergeOwnedHooks(hooks: HookMap | undefined, rules: HookOwnership): HookMap {
  const current = hooks ?? {};
  assertNoCollision(current, rules);
  const wanted = new Map(rules.groups().map(({ event, group }) => [event, group]));
  const placed = new Set<string>();

  const out: HookMap = {};
  for (const [event, groups] of Object.entries(current)) {
    const next: HookGroup[] = [];
    for (const group of groups) {
      if (!isOwnedGroup(group, rules)) next.push(group);
      else if (wanted.has(event) && !placed.has(event)) {
        next.push(wanted.get(event) as HookGroup);
        placed.add(event);
      }
    }
    // Drop an event we emptied; keep one that was already empty.
    if (next.length > 0 || groups.length === 0) out[event] = next;
  }
  for (const [event, group] of wanted) {
    if (!placed.has(event)) (out[event] ??= []).push(group);
  }
  return out;
}

/** Remove only our groups. Returns undefined hooks when nothing is left. */
export function stripOwnedHooks(
  hooks: HookMap | undefined,
  rules: HookOwnership,
): { hooks: HookMap | undefined; removed: number } {
  if (hooks === undefined) return { hooks, removed: 0 };
  assertNoCollision(hooks, rules);

  let removed = 0;
  const out: HookMap = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.filter((g) => !isOwnedGroup(g, rules));
    removed += groups.length - kept.length;
    if (kept.length > 0 || groups.length === 0) out[event] = kept;
  }
  if (removed === 0) return { hooks, removed };
  return { hooks: Object.keys(out).length > 0 ? out : undefined, removed };
}

/** How many of our events currently have one of our groups registered. */
export function countOwnedEvents(hooks: HookMap | undefined, rules: HookOwnership): number {
  return rules
    .groups()
    .filter(({ event }) => (hooks?.[event] ?? []).some((g) => isOwnedGroup(g, rules))).length;
}

/** Our command string: `node "<entry>" hook <provider> <event>`. */
export function hookCommand(entryPath: string, provider: string, event: string): string {
  return `node "${entryPath}" hook ${provider} ${event}`;
}
