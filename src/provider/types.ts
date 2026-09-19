import type { SessionIdentity, SessionMarkerPatch } from '../types';

/** Environment facts a provider runner may use when its payload omits them. */
export interface TranslateEnv {
  sessionId?: string;
  cwd: string;
}

/** Stable boundary between a provider translator and its hook runner. */
export type Translation =
  | {
      kind: 'update';
      identity: SessionIdentity;
      patch: SessionMarkerPatch;
      activityChanged: boolean;
    }
  | { kind: 'end'; identity: SessionIdentity }
  | null;
