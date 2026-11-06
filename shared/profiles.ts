import type { AgentId, AgentStatus, Catalog, Profile, ProfileStatus, Project, Session, SystemStatus } from './types.ts';

// A provider can have several sign-ins, which code calls profiles. The one each provider had before
// that has the provider's id, so a conversation from then, which names none, still has its own.

export const AGENTS: AgentId[] = ['claude', 'codex'];

/** What an id can be. It names files on this computer, so nothing else is taken for one. */
export const PROFILE_ID = /^(claude|codex)(-[a-f0-9]{12})?$/;

export function agentOfProfileId(id: string): AgentId | undefined {
  const match = PROFILE_ID.exec(id);
  return match ? match[1] as AgentId : undefined;
}

/** The sign-in a conversation's next turn runs on. */
export function profileIdOf(session: Pick<Session, 'agent' | 'profileId'>): string {
  return session.profileId ?? session.agent;
}

export function profilesOf(profiles: Profile[], agent: AgentId): Profile[] {
  return profiles.filter((profile) => profile.agent === agent);
}

/** The first of a provider's, which is what's used where nothing chooses. */
export function defaultProfile(profiles: Profile[], agent: AgentId): Profile | undefined {
  return profiles.find((profile) => profile.agent === agent);
}

const UNKNOWN: ProfileStatus = { signedIn: false };

/**
 * A sign-in's status, which for one that's been removed, or that this page hasn't heard of yet, is
 * signed out. A server from before there were several only says how each provider is signed in.
 */
export function profileStatus(system: Pick<SystemStatus, 'agents'> & Partial<Pick<SystemStatus, 'profiles'>>, id: string): ProfileStatus {
  return system.profiles?.[id] ?? (system.profiles ? undefined : system.agents?.[id as AgentId]) ?? UNKNOWN;
}

export function isReady(status: AgentStatus | undefined): boolean {
  return Boolean(status?.signedIn && !status.rejected);
}

/** How long a limit counts for when the service didn't say when it ends, so that it gets tried again. */
export const UNKNOWN_LIMIT_MS = 60 * 60 * 1000;

export function isLimited(status: ProfileStatus | undefined, now = Date.now()): boolean {
  if (!status?.limitedAt) return false;
  return status.limitResetsAt ? status.limitResetsAt > now : now - status.limitedAt < UNKNOWN_LIMIT_MS;
}

/** When a limit ends, or seems likely to have, for one the service didn't give a time for. */
export function limitEnds(status: ProfileStatus): number | undefined {
  if (!status.limitedAt) return undefined;
  return status.limitResetsAt ?? status.limitedAt + UNKNOWN_LIMIT_MS;
}

/** A project can bring its own key for a provider, which goes in place of any sign-in. */
export function projectBringsKey(agent: AgentId, project: Pick<Project, 'settings'> | undefined): boolean {
  const env = project?.settings.env ?? {};
  return Boolean(agent === 'claude' ? env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN : env.CODEX_API_KEY || env.OPENAI_API_KEY);
}

/** "Claude – work", or just "Claude" for one nobody has named. */
export function profileName(profile: Pick<Profile, 'agent' | 'name'> | undefined, catalog: Catalog, agent?: AgentId): string {
  const provider = catalog[profile?.agent ?? agent ?? 'claude'].label;
  if (!profile) return `${provider} (a removed sign-in)`;
  return profile.name ? `${provider} – ${profile.name}` : provider;
}

/** What tells it apart from the provider's others, where the provider is already clear. */
export function profileShortName(profile: Pick<Profile, 'agent' | 'name'> | undefined, catalog: Catalog): string {
  if (!profile) return 'removed sign-in';
  return profile.name || catalog[profile.agent].label;
}

/** The long name of a conversation's sign-in, by id, whether or not it's still there. */
export function profileLabel(profiles: Profile[], catalog: Catalog, id: string, agent: AgentId): string {
  return profileName(profiles.find((profile) => profile.id === id), catalog, agent);
}

/** Only a provider with more than one sign-in needs to say which. */
export function hasSeveral(profiles: Profile[], agent: AgentId): boolean {
  return profilesOf(profiles, agent).length > 1;
}

/**
 * Where a conversation that reached a usage limit can move by itself: a sign-in of the same
 * provider that the user chose for this, that's signed in and isn't at a limit itself.
 */
export function autoSwitchTarget(profiles: Profile[], system: Pick<SystemStatus, 'agents' | 'profiles'>, agent: AgentId, from: string, now = Date.now()): Profile | undefined {
  return profilesOf(profiles, agent).find((profile) => profile.id !== from && profile.autoSwitch
    && isReady(profileStatus(system, profile.id)) && !isLimited(profileStatus(system, profile.id), now));
}

/** The other signed-in sign-ins a conversation stopped by a limit could carry on with, in order. */
export function continueOptions(profiles: Profile[], system: Pick<SystemStatus, 'agents' | 'profiles'>, agent: AgentId, from: string, now = Date.now()): { available: Profile[]; limited: Profile[] } {
  const others = profilesOf(profiles, agent).filter((profile) => profile.id !== from && isReady(profileStatus(system, profile.id)));
  return {
    available: others.filter((profile) => !isLimited(profileStatus(system, profile.id), now)),
    limited: others.filter((profile) => isLimited(profileStatus(system, profile.id), now)),
  };
}

/**
 * What a Lead may start or move an agent on: its own sign-in, or for another provider that one's
 * default, and any the user chose for moving to at a limit.
 */
export function leadMayUse(lead: Pick<Session, 'agent' | 'profileId'>, profile: Profile, profiles: Profile[]): boolean {
  if (profile.autoSwitch) return true;
  if (profile.agent === lead.agent) return profile.id === profileIdOf(lead);
  return profile.id === defaultProfile(profiles, profile.agent)?.id;
}

/** The sign-in a Lead's agent on this provider gets when the Lead doesn't say. */
export function leadDefaultFor(lead: Pick<Session, 'agent' | 'profileId'>, agent: AgentId, profiles: Profile[]): string | undefined {
  if (agent === lead.agent && profiles.some((profile) => profile.id === profileIdOf(lead))) return profileIdOf(lead);
  return defaultProfile(profiles, agent)?.id;
}
