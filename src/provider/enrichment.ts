import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AggregatedState, ProviderKey } from '../types';

export type Enrichment = Pick<AggregatedState, 'model' | 'branch' | 'tokens' | 'cost'>;
export type ProviderEnrichmentReader = (reference?: string) => Enrichment;

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
  return { ...previous, ...known };
}

/**
 * Dispatch enrichment by current-session identity. The last successful read is
 * retained across a transient partial rewrite, but never across identities.
 */
export function createEnrichmentDispatcher(
  options: EnrichmentDispatcherOptions,
): (state: AggregatedState) => Enrichment {
  let cachedIdentity: string | undefined;
  let cachedFacts: Enrichment = {};

  return (state) => {
    const identity = `${state.provider}\0${state.sessionId}`;
    if (identity !== cachedIdentity) {
      cachedIdentity = identity;
      cachedFacts = {};
    }

    const reader = options.readers[state.provider];
    if (!reader) return {};

    const readFacts = reader(state.enrichmentRef);
    if (hasFacts(readFacts)) cachedFacts = mergeKnownFacts(cachedFacts, readFacts);
    const facts = cachedFacts;
    const branch = options.resolveBranch(state.cwd) ?? facts.branch;
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
}

interface BranchCacheEntry extends RepositoryState {
  expiresAt: number;
  repository: boolean;
}

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

/** Resolve selected-session Git branches through a small LRU repository cache. */
export class GitBranchResolver {
  private readonly entries = new Map<string, BranchCacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly readRepository: (cwd: string) => RepositoryState | null;

  constructor(options: GitBranchResolverOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 32);
    this.ttlMs = options.ttlMs ?? 60_000;
    this.readRepository = options.readRepository ?? readRepository;
  }

  resolve(cwd?: string, now = Date.now()): string | undefined {
    if (!cwd) return undefined;
    const normalizedCwd = resolve(cwd);

    for (const [key, entry] of this.entries) {
      const matches = entry.repository ? isInside(entry.root, cwd) : entry.root === normalizedCwd;
      if (entry.expiresAt >= now && matches) {
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.branch;
      }
      if (entry.expiresAt < now) this.entries.delete(key);
    }

    const repository = this.readRepository(cwd);
    const entry: BranchCacheEntry = repository
      ? { ...repository, expiresAt: now + this.ttlMs, repository: true }
      : {
          root: normalizedCwd,
          branch: undefined,
          expiresAt: now + this.ttlMs,
          repository: false,
        };
    const key = `${entry.repository ? 'repo' : 'miss'}:${resolve(entry.root)}`;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.branch;
  }
}
