import { PROVIDER_KEYS, type ProviderKey } from '../types';
import { CLAUDE_CODE_HOOK_EVENTS } from './claude-code-events';

export type HookRunner = (args: string[]) => Promise<void>;
export type HookRunnerLoader = (provider: ProviderKey) => Promise<HookRunner | null>;

export interface HookRoute {
  provider: ProviderKey;
  args: string[];
}

const PROVIDER_ROUTES = new Set<string>(PROVIDER_KEYS);
const LEGACY_CLAUDE_CODE_EVENTS = new Set(CLAUDE_CODE_HOOK_EVENTS.map(({ arg }) => arg));

/** Resolve only canonical provider routes plus the bounded legacy Claude route. */
export function resolveHookRoute(args: string[]): HookRoute | null {
  const [route, ...rest] = args;
  if (route && PROVIDER_ROUTES.has(route)) {
    return { provider: route as ProviderKey, args: rest };
  }
  if (route && LEGACY_CLAUDE_CODE_EVENTS.has(route)) {
    return { provider: 'claude-code', args };
  }
  return null;
}

async function loadHookRunner(provider: ProviderKey): Promise<HookRunner | null> {
  switch (provider) {
    case 'claude-code':
      return (await import('./claude-code')).runHook;
    default:
      return null;
  }
}

/** Hook entry point. Provider import and execution failures are always fail-open. */
export async function dispatchHook(
  args: string[],
  load: HookRunnerLoader = loadHookRunner,
): Promise<void> {
  try {
    const route = resolveHookRoute(args);
    if (!route) return;
    const runner = await load(route.provider);
    if (!runner) return;
    await runner(route.args);
  } catch {
    // Presence reporting must never break or block the coding tool.
  }
}
