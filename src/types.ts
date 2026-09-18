/** Shared shapes used across the tool. */

export interface PresenceButton {
  label: string;
  url: string;
}

export interface ImageSlot {
  /** Discord asset key (uploaded in the Developer Portal), may contain placeholders. */
  key: string;
  /** Hover tooltip, may contain placeholders. */
  text: string;
}

/**
 * Which line Discord shows as the compact status (the member-list "Playing …"
 * slot): the app `name`, the `state` line, or the `details` line. Maps to
 * Discord's StatusDisplayType.
 */
export type StatusDisplay = 'name' | 'state' | 'details';

/** A theme is a bundle of slot templates + which image assets to use. */
export interface Theme {
  details: string;
  state: string;
  largeImage: ImageSlot;
  smallImage: ImageSlot;
  timer: boolean;
  buttons: PresenceButton[];
  /** What the compact member-list status shows. Defaults to `name`. */
  statusDisplay?: StatusDisplay;
}

export type ThemeName =
  | 'minimal'
  | 'developer'
  | 'focus'
  | 'playful'
  | 'chaos'
  | 'terminal'
  | 'shipper'
  | 'custom';

/**
 * Machine-readable activity keyword. Drives the small-image badge via the
 * `status-{state}` asset key. `activity` (below) is the human-facing text.
 */
export type ActivityState =
  | 'idle'
  | 'thinking'
  | 'editing'
  | 'running'
  | 'searching'
  | 'browsing'
  | 'delegating'
  | 'waiting';

/** Canonical provider keys and their opt-in theme display names. */
export const PROVIDER_DISPLAY_NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  opencode: 'OpenCode',
  'grok-build': 'Grok Build',
} as const;

export type ProviderKey = keyof typeof PROVIDER_DISPLAY_NAMES;
export const PROVIDER_KEYS = Object.freeze(
  Object.keys(PROVIDER_DISPLAY_NAMES) as ProviderKey[],
) as readonly ProviderKey[];

/** A provider's raw session id is unique only within that provider. */
export interface SessionIdentity {
  provider: ProviderKey;
  sessionId: string;
}

/** The user's config file: pick a theme, optionally override slots. */
export interface UserConfig {
  theme: ThemeName;
  overrides?: Partial<Theme>;
  /** Override the Discord application id (defaults to the shared "vibecoder" app). */
  clientId?: string;
}

/** One live root session, written by its coding-tool provider. */
export interface SessionMarker extends SessionIdentity {
  startedAt: number; // epoch ms
  heartbeat: number; // epoch ms
  lastActivityAt: number; // epoch ms
  cwd?: string;
  enrichmentRef?: string; // provider-owned reference read by daemon enrichment
  project?: string;
  branch?: string;
  model?: string;
  state?: ActivityState; // machine keyword (badge)
  activity?: string; // human-facing text
  file?: string;
  tokens?: number;
  cost?: number;
}

/** Provider-owned facts accepted by the store; identity and clocks are store-owned. */
export type SessionMarkerPatch = Partial<
  Omit<SessionMarker, 'provider' | 'sessionId' | 'heartbeat' | 'lastActivityAt'>
>;

/** Live sessions merged into a single view the daemon renders. */
export interface AggregatedState extends SessionIdentity {
  sessionCount: number;
  startedAt: number; // selected session's start
  cwd?: string; // selected session's working directory
  enrichmentRef?: string; // selected session's provider-owned enrichment reference
  project?: string;
  branch?: string;
  model?: string;
  state?: ActivityState;
  activity?: string;
  file?: string;
  tokens?: number;
  cost?: number;
}

/** What the Discord layer sends, mapped onto Discord's fixed slots. */
export interface PresencePayload {
  details?: string;
  state?: string;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  startTimestamp?: number;
  buttons?: PresenceButton[];
  /** Discord StatusDisplayType: 0 name, 1 state, 2 details. Omit for default. */
  statusDisplayType?: number;
}
