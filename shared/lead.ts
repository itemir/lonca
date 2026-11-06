import { isReady, profileIdOf, profileStatus, projectBringsKey } from './profiles.ts';
import type { AgentId, Catalog, Project, Session, SystemStatus } from './types.ts';

export const MAX_AUTONOMOUS_TURNS = 30;

/** Busy now, or about to be. Something the user stopped stays stopped, whatever's waiting for it. */
export function isWorking(session: Session): boolean {
  return session.status === 'running' || (session.queue.length > 0 && !session.held);
}

/** Whether a message from the Lead leaves this session's queue waiting. Only a Stop by the Lead is lifted by its next message. */
export function staysHeld(session: Session): boolean {
  return Boolean(session.held) && (Boolean(session.userStopped) || session.lastOutcome !== 'stopped');
}

/**
 * Whether a workspace in this project can run this CLI on this sign-in: a provider's id alone
 * means its first. A project can bring its own key, which sign-in status doesn't know about.
 */
export function canRun(who: AgentId | Pick<Session, 'agent' | 'profileId'>, system: SystemStatus, project: Pick<Project, 'settings'> | undefined): boolean {
  const agent = typeof who === 'string' ? who : who.agent;
  const profileId = typeof who === 'string' ? who : profileIdOf(who);
  if (!system.agentsChecked || isReady(profileStatus(system, profileId))) return true;
  return projectBringsKey(agent, project);
}

/** Why a Lead can't run on its model. These are the only times that model can change. */
export function leadBlocker(session: Session, catalog: Catalog, system: SystemStatus, project: Pick<Project, 'settings'> | undefined): 'retired' | 'signed-out' | 'limit' | null {
  if (!catalog[session.agent].models.some((model) => model.id === session.model)) return 'retired';
  if (!canRun(session, system, project)) return 'signed-out';
  return session.lastOutcome === 'limit' ? 'limit' : null;
}
