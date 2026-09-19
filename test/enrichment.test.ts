import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEnrichmentDispatcher,
  GitBranchResolver,
  type Enrichment,
  type ProviderEnrichmentReader,
} from '../src/provider/enrichment';
import type { AggregatedState } from '../src/types';

function state(overrides: Partial<AggregatedState> = {}): AggregatedState {
  return {
    provider: 'claude-code',
    sessionId: 'session-1',
    sessionCount: 1,
    startedAt: 1,
    cwd: '/work/repo',
    enrichmentRef: '/logs/session-1.jsonl',
    ...overrides,
  };
}

test('enrichment dispatches by selected provider and supports every shared fact', () => {
  const seen: Array<string | undefined> = [];
  const claude: ProviderEnrichmentReader = (reference) => {
    seen.push(reference);
    return { model: 'Opus 4.8', tokens: 1200, cost: 1.25 };
  };
  const enrich = createEnrichmentDispatcher({
    readers: { 'claude-code': claude },
    resolveBranch: (cwd) => (cwd === '/work/repo' ? 'feat/provider-routing' : undefined),
  });

  assert.deepEqual(enrich(state()), {
    model: 'Opus 4.8',
    branch: 'feat/provider-routing',
    tokens: 1200,
    cost: 1.25,
  });
  assert.deepEqual(seen, ['/logs/session-1.jsonl']);
});

test('last successful file facts survive a partial rewrite only for the same identity', () => {
  let facts: Enrichment = { model: 'Sonnet 4.5', tokens: 42 };
  const enrich = createEnrichmentDispatcher({
    readers: { 'claude-code': () => facts },
    resolveBranch: () => undefined,
  });

  assert.deepEqual(enrich(state()), facts);
  facts = { tokens: 84 };
  assert.deepEqual(enrich(state()), { model: 'Sonnet 4.5', tokens: 84 });
  facts = { tokens: 3 };
  assert.deepEqual(enrich(state()), { model: 'Sonnet 4.5', tokens: 84 });
  facts = {};
  assert.deepEqual(enrich(state()), { model: 'Sonnet 4.5', tokens: 84 });
  assert.deepEqual(enrich(state({ sessionId: 'session-2' })), {});
});

test('detached HEAD does not fall back to a stale transcript branch', () => {
  const enrich = createEnrichmentDispatcher({
    readers: { 'claude-code': () => ({ branch: 'stale-branch' }) },
    resolveBranch: () => undefined,
  });

  assert.deepEqual(enrich(state()), {});
});

test('providers without an enrichment reader return no facts', () => {
  const enrich = createEnrichmentDispatcher({
    readers: {},
    resolveBranch: () => 'must-not-leak',
  });

  assert.deepEqual(enrich(state({ provider: 'codex' })), {});
});

test('Git branch resolution uses cwd, tolerates detached heads, and caches repeated lookups', () => {
  const calls: string[] = [];
  const resolver = new GitBranchResolver({
    maxEntries: 2,
    ttlMs: Number.POSITIVE_INFINITY,
    readRepository: (cwd) => {
      calls.push(cwd);
      if (cwd === '/work/repo/packages/app') return { root: '/work/repo', branch: 'main' };
      if (cwd === '/work/detached') return { root: cwd, branch: undefined };
      return null;
    },
    hasGitBoundary: () => false,
  });

  assert.equal(resolver.resolve('/work/repo/packages/app'), 'main');
  assert.equal(resolver.resolve('/work/repo/other'), 'main');
  assert.equal(resolver.resolve('/work/detached'), undefined);
  assert.equal(resolver.resolve('/work/detached'), undefined);
  assert.deepEqual(calls, ['/work/repo/packages/app', '/work/detached']);
});

test('Git branch cache probes a nested repository instead of reusing its parent branch', () => {
  const calls: string[] = [];
  const resolver = new GitBranchResolver({
    readRepository: (cwd) => {
      calls.push(cwd);
      return cwd.endsWith('/nested')
        ? { root: cwd, branch: 'nested-branch' }
        : { root: '/work/repo', branch: 'outer-branch' };
    },
    hasGitBoundary: (_root, cwd) => cwd.endsWith('/nested'),
  });

  assert.equal(resolver.resolve('/work/repo'), 'outer-branch');
  assert.equal(resolver.resolve('/work/repo/nested'), 'nested-branch');
  assert.deepEqual(calls, ['/work/repo', '/work/repo/nested']);
});

test('Git branch cache is bounded', () => {
  let calls = 0;
  const resolver = new GitBranchResolver({
    maxEntries: 1,
    ttlMs: Number.POSITIVE_INFINITY,
    readRepository: (cwd) => {
      calls++;
      return { root: cwd, branch: 'main' };
    },
  });

  resolver.resolve('/repo/a');
  resolver.resolve('/repo/b');
  resolver.resolve('/repo/a');
  assert.equal(calls, 3);
});

test('Git branch resolver caches non-repository working directories', () => {
  let calls = 0;
  const resolver = new GitBranchResolver({
    readRepository: () => {
      calls++;
      return null;
    },
  });

  assert.equal(resolver.resolve('/not/a/repository'), undefined);
  assert.equal(resolver.resolve('/not/a/repository'), undefined);
  assert.equal(calls, 1);
});

test('Git branch resolution ignores inherited repository-location variables', () => {
  const root = mkdtempSync(join(tmpdir(), 'vdp-git-env-'));
  const selected = join(root, 'selected');
  const foreign = join(root, 'foreign');
  mkdirSync(selected);
  mkdirSync(foreign);
  const initialize = (cwd: string, branch: string): void => {
    execFileSync('git', ['init', '-b', branch], { cwd, stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=VDP Test',
        '-c',
        'user.email=vdp@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd, stdio: 'ignore' },
    );
  };
  initialize(selected, 'selected-branch');
  initialize(foreign, 'foreign-branch');

  const previousDir = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(foreign, '.git');
    process.env.GIT_WORK_TREE = foreign;
    assert.equal(new GitBranchResolver().resolve(selected), 'selected-branch');
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousDir;
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousWorkTree;
    rmSync(root, { recursive: true, force: true });
  }
});
