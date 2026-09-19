import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AggregatedState, ProviderKey, SessionIdentity } from '../types';

export type Enrichment = Pick<AggregatedState, 'model' | 'branch' | 'tokens' | 'cost'>;
export type ProviderEnrichmentReader = (
  reference: string | undefined,
  identity: SessionIdentity,
) => Enrichment;

export interface EnrichmentDispatcherOptions {
  readers: Partial<Record<ProviderKey, ProviderEnrichmentReader>>;
  resolveBranch: (cwd?: string) => string | undefined;
}

function hasFacts(facts: Enrichment): boolean {
  return Object.values(facts).some((value) => value !== undefined);
}

function mergeKnownFacts(previous: Enrichment, next: Enrichment): Enrichment {
  const known = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as Enrichment;
  const merged = { ...previous, ...known };
  if (previous.tokens !== undefined && next.tokens !== undefined) {
    merged.tokens = Math.max(previous.tokens, next.tokens);
  }
  if (previous.cost !== undefined && next.cost !== undefined) {
    merged.cost = Math.max(previous.cost, next.cost);
  }
  return merged;
}

/**
 * Dispatch enrichment by current-session identity. The last successful read is
 * retained across a transient partial rewrite, but never across identities.
 */
export function createEnrichmentDispatcher(
  options: EnrichmentDispatcherOptions,
): (state: AggregatedState) => Enrichment {
  let cachedIdentity: SessionIdentity | undefined;
  let cachedFacts: Enrichment = {};

  return (state) => {
    const identity = { provider: state.provider, sessionId: state.sessionId };
    if (
      identity.provider !== cachedIdentity?.provider ||
      identity.sessionId !== cachedIdentity.sessionId
    ) {
      cachedIdentity = identity;
      cachedFacts = {};
    }

    const reader = options.readers[state.provider];
    if (!reader) return {};

    const readFacts = reader(state.enrichmentRef, identity);
    if (hasFacts(readFacts)) cachedFacts = mergeKnownFacts(cachedFacts, readFacts);
    const { branch: transcriptBranch, ...facts } = cachedFacts;
    const branch = state.cwd ? options.resolveBranch(state.cwd) : transcriptBranch;
    return branch === undefined ? facts : { ...facts, branch };
  };
}

export interface RepositoryState {
  root: string;
  branch?: string;
}

export interface GitBranchResolverOptions {
  maxEntries?: number;
  ttlMs?: number;
  readRepository?: (cwd: string) => RepositoryState | null;
  hasGitBoundary?: (root: string, cwd: string) => boolean;
}

type BranchCacheEntry =
  | (RepositoryState & { kind: 'repository'; expiresAt: number })
  | { kind: 'miss'; path: string; expiresAt: number };

function readRepository(cwd: string): RepositoryState | null {
  try {
    const output = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const [root, rawBranch] = output.trim().split(/\r?\n/);
    if (!root) return null;
    return { root, branch: rawBranch && rawBranch !== 'HEAD' ? rawBranch : undefined };
  } catch {
    return null;
  }
}

function isInside(root: string, cwd: string): boolean {
  const path = relative(resolve(root), resolve(cwd));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function hasGitBoundary(root: string, cwd: string): boolean {
  const normalizedRoot = resolve(root);
  let current = resolve(cwd);
  while (current !== normalizedRoot) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return false;
}

/** Resolve selected-session Git branches through a small LRU repository cache. */
export class GitBranchResolver {
  private readonly entries = new Map<string, BranchCacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly readRepository: (cwd: string) => RepositoryState | null;
  private readonly hasGitBoundary: (root: string, cwd: string) => boolean;

  constructor(options: GitBranchResolverOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 32);
    this.ttlMs = options.ttlMs ?? 60_000;
    this.readRepository = options.readRepository ?? readRepository;
    this.hasGitBoundary = options.hasGitBoundary ?? hasGitBoundary;
  }

  resolve(cwd?: string, now = Date.now()): string | undefined {
    if (!cwd) return undefined;
    const normalizedCwd = resolve(cwd);
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(key);
        continue;
      }
      const matches =
        entry.kind === 'miss'
          ? entry.path === normalizedCwd
          : isInside(entry.root, cwd) && !this.hasGitBoundary(entry.root, cwd);
      if (!matches) continue;
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.kind === 'repository' ? entry.branch : undefined;
    }

    const repository = this.readRepository(cwd);
    const entry: BranchCacheEntry = repository
      ? { ...repository, kind: 'repository', expiresAt: now + this.ttlMs }
      : {
          kind: 'miss',
          path: normalizedCwd,
          expiresAt: now + this.ttlMs,
        };
    const key = entry.kind === 'repository' ? `repo:${resolve(entry.root)}` : `miss:${entry.path}`;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.kind === 'repository' ? entry.branch : undefined;
  }
}
