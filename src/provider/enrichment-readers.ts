/**
 * The daemon-side enrichment reader for each provider that has one. Each reader
 * takes the selected session's provider-owned reference (a transcript or
 * rollout path) and returns only the facts its supported format records;
 * providers without a reader get no enrichment.
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
};
