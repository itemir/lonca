import crypto from 'node:crypto';
import { profileIdOf, profileName, profilesOf } from '../shared/profiles.ts';
import type { AgentId, Profile } from '../shared/types.ts';
import { notice, persistSession } from './agents/runner.ts';
import { profileSecret } from './boundary.ts';
import { publish } from './events.ts';
import { logins } from './logins.ts';
import { saveState, secretsStatus, setClaudeCredential, state } from './store.ts';
import { clearProfileLimit, describeProfiles, forgetCodexLogin, getProfile, publishSystem } from './system.ts';
import { HttpError } from './util.ts';
import { addProxySecretEverywhere, applyCodexSetupEverywhere, publishWorkspace } from './workspaces.ts';

// A provider's sign-ins, which the page calls sign-ins and the code profiles. What's here is only
// what they're called and in what order. Their credentials are kept with the others, on this computer.

const NAME_LIMIT = 40;

export function publishProfiles(): void {
  publish({ type: 'profiles', profiles: state.profiles });
  saveState();
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, NAME_LIMIT);
}

function checkName(agent: AgentId, name: string, except?: string): void {
  if (profilesOf(state.profiles, agent).some((profile) => profile.id !== except && profile.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, `There’s already a ${state.catalog[agent].label} sign-in called ${name}.`);
  }
}

/** Status changes with the list, and it's how a page learns about one it hasn't seen. */
function statusChanged(): void {
  describeProfiles();
  publishSystem();
}

/**
 * Adds a sign-in, which is signed out until it's signed in like any other. One alone needs no
 * name, but two need telling apart, so the first is named now if it hasn't been.
 */
export function createProfile(agent: AgentId, name: string, firstName?: string): Profile {
  const clean = cleanName(name);
  if (!clean) throw new HttpError(400, 'Give the new sign-in a name, so you can tell them apart.');
  const existing = profilesOf(state.profiles, agent);
  const first = firstName === undefined ? undefined : cleanName(firstName);
  if (existing.length === 1 && !existing[0].name) {
    if (!first) throw new HttpError(400, `Name the ${state.catalog[agent].label} sign-in you already have too, so you can tell them apart.`);
    if (first.toLowerCase() === clean.toLowerCase()) throw new HttpError(409, 'Give the two sign-ins different names.');
    existing[0].name = first;
  }
  checkName(agent, clean);
  const profile: Profile = { id: `${agent}-${crypto.randomBytes(6).toString('hex')}`, agent, name: clean };
  state.profiles.push(profile);
  publishProfiles();
  statusChanged();
  // Running workspaces only get the sign-ins there were when they started.
  void addProxySecretEverywhere(profileSecret(profile));
  return profile;
}

export function updateProfile(profile: Profile, patch: { name?: string; autoSwitch?: boolean; makeDefault?: boolean }): Profile {
  if (patch.name !== undefined) {
    const clean = cleanName(patch.name);
    if (!clean && profilesOf(state.profiles, profile.agent).length > 1) throw new HttpError(400, 'A sign-in needs a name while there are others to tell it from.');
    if (clean) checkName(profile.agent, clean, profile.id);
    profile.name = clean;
  }
  if (patch.autoSwitch !== undefined) profile.autoSwitch = patch.autoSwitch || undefined;
  if (patch.makeDefault) {
    const index = state.profiles.indexOf(profile);
    const first = state.profiles.findIndex((entry) => entry.agent === profile.agent);
    if (index > first) {
      state.profiles.splice(index, 1);
      state.profiles.splice(first, 0, profile);
      // Terminals use the default, and Codex's address in a VM follows its kind.
      if (profile.agent === 'codex') applyCodexSetupEverywhere();
    }
  }
  publishProfiles();
  statusChanged();
  return profile;
}

/**
 * Removes a sign-in and what it held. Conversations on it move to the provider's default, which
 * they say, and so does anything that would have started on it. Not while one is running on it,
 * which would lose its credentials partway.
 */
export async function removeProfile(profile: Profile): Promise<void> {
  const keepsOne = () => {
    if (profilesOf(state.profiles, profile.agent).length < 2) {
      throw new HttpError(409, `${state.catalog[profile.agent].label} keeps at least one sign-in. Sign out of this one instead.`);
    }
  };
  keepsOne();
  // A sign-in under way would save to it afterwards.
  await logins.cancel({ agent: profile.agent, profileId: profile.id });
  if (getProfile(profile.id) !== profile) return;
  // Another removal could have finished meanwhile.
  keepsOne();
  const name = profileName(profile, state.catalog);
  // A turn that started before there could be several runs on the provider's first.
  const running = state.sessions.filter((session) => session.status === 'running' && (session.activeProfileId ?? session.agent) === profile.id);
  if (running.length > 0) {
    throw new HttpError(409, `${running.length === 1 ? 'A conversation is' : `${running.length} conversations are`} running on ${name}. Remove it once ${running.length === 1 ? 'it has' : 'they have'} finished, or stop ${running.length === 1 ? 'it' : 'them'} first.`);
  }
  // Its credentials go first, then what was on it, and the sign-in last, so that removing it
  // again finishes anything that was cut short.
  if (profile.agent === 'claude') setClaudeCredential(profile.id, undefined);
  else forgetCodexLogin(profile.id);
  const fallback = profilesOf(state.profiles, profile.agent).find((entry) => entry !== profile)!;
  const fallbackName = profileName(fallback, state.catalog);
  for (const session of state.sessions.filter((entry) => entry.agent === profile.agent && !entry.closedAt && profileIdOf(entry) === profile.id)) {
    if (session.hasMessages) notice(session.id, undefined, 'info', `Moved from ${name} to ${fallbackName} because ${name} was removed.`);
    persistSession(session, { profileId: fallback.id });
  }
  if (state.settings.leadDefault.profileId === profile.id) state.settings.leadDefault = { ...state.settings.leadDefault, profileId: fallback.id };
  for (const workspace of state.workspaces.filter((entry) => entry.lead?.profileId === profile.id)) {
    workspace.lead = { ...workspace.lead!, profileId: fallback.id };
    publishWorkspace(workspace);
  }
  state.profiles = state.profiles.filter((entry) => entry !== profile);
  clearProfileLimit(profile.id);
  publish({ type: 'settings', settings: state.settings, secrets: secretsStatus() });
  publishProfiles();
  statusChanged();
  if (profile.agent === 'codex') applyCodexSetupEverywhere();
}
