/**
 * The daemon-side enrichment reader for each provider that has one. Each reader
 * takes the selected session's provider-owned reference (a transcript or
 * rollout path) and returns only the facts its supported format records;
 * providers without a reader get no enrichment.
 *
 * OpenCode has nothing to read: its plugin reports model, tokens and cost in
 * the marker itself. Its empty reader still opts it into branch resolution
 * from the session's working directory.
 */
import { readCodexRollout } from './codex-rollout';
import type { ProviderEnrichmentReader } from './enrichment';
import { readGeminiTranscript } from './gemini-cli-transcript';
import { readTranscriptMeta } from './transcript';
import type { ProviderKey } from '../types';

export const ENRICHMENT_READERS: Partial<Record<ProviderKey, ProviderEnrichmentReader>> = {
  'claude-code': (reference, identity) => readTranscriptMeta(reference, identity),
  codex: (reference, identity) => readCodexRollout(reference, identity),
  'gemini-cli': (reference, identity) => readGeminiTranscript(reference, identity),
  opencode: () => ({}),
};
