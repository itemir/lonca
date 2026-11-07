import { hasSeveral, isLimited, profileIdOf, profileLabel, profileStatus } from '../../shared/profiles.ts';
import type { Catalog, Profile, ProfileStatus, Session, SystemStatus } from '../../shared/types.ts';

// How the page talks about a provider's sign-ins. With one, nothing about them shows that didn't
// before there could be several.

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "At its usage limit until 3:40 PM", for a sign-in a turn found at its limit. */
export function limitNote(status: ProfileStatus): string | null {
  if (!isLimited(status)) return null;
  return status.limitResetsAt ? `At its usage limit until ${clockTime(status.limitResetsAt)}` : 'At its usage limit';
}

/** A few words on why a sign-in can't be used just now, or that it costs by the token. */
export function signInCondition(system: SystemStatus, profileId: string): string | null {
  const status = profileStatus(system, profileId);
  if (!status.signedIn) return 'Not signed in';
  if (status.rejected) return 'Needs signing in again';
  if (isLimited(status)) return status.limitResetsAt ? `At its limit until ${clockTime(status.limitResetsAt)}` : 'At its limit';
  return status.usesKey ? 'API key' : null;
}

/** The sign-in's name beside a model, only where its provider has more than one. */
export function sessionSignIn(session: Pick<Session, 'agent' | 'profileId'>, profiles: Profile[], catalog: Catalog): string | null {
  if (!hasSeveral(profiles, session.agent)) return null;
  return profileLabel(profiles, catalog, profileIdOf(session), session.agent);
}

/** For a destination: an API key costs money in a way a subscription doesn't. */
export function destinationName(profile: Profile, system: SystemStatus, catalog: Catalog, profiles: Profile[]): string {
  const name = profileLabel(profiles, catalog, profile.id, profile.agent);
  return profileStatus(system, profile.id).usesKey ? `${name} (billed per token)` : name;
}
