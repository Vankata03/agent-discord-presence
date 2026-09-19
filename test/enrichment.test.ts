import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  facts = {};
  assert.deepEqual(enrich(state()), { model: 'Sonnet 4.5', tokens: 84 });
  assert.deepEqual(enrich(state({ sessionId: 'session-2' })), {});
});

test('providers without an enrichment reader return no facts', () => {
  const enrich = createEnrichmentDispatcher({
    readers: {},
    resolveBranch: () => 'must-not-leak',
  });

  assert.deepEqual(enrich(state({ provider: 'codex' })), {});
});

test('Git branch resolution uses cwd, tolerates detached heads, and caches by repository', () => {
  const calls: string[] = [];
  const resolver = new GitBranchResolver({
    maxEntries: 2,
    ttlMs: Number.POSITIVE_INFINITY,
    readRepository: (cwd) => {
      calls.push(cwd);
      if (cwd.startsWith('/work/repo')) return { root: '/work/repo', branch: 'main' };
      if (cwd === '/work/detached') return { root: cwd, branch: undefined };
      return null;
    },
  });

  assert.equal(resolver.resolve('/work/repo/packages/app'), 'main');
  assert.equal(resolver.resolve('/work/repo/other'), 'main');
  assert.equal(resolver.resolve('/work/detached'), undefined);
  assert.equal(resolver.resolve('/work/detached'), undefined);
  assert.deepEqual(calls, ['/work/repo/packages/app', '/work/detached']);
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
