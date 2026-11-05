import type { AgentId, Catalog, Project, Session, SystemStatus } from './types.ts';

export const MAX_AUTONOMOUS_TURNS = 30;

/** Busy now, or about to be. Something the user stopped stays stopped, whatever's waiting for it. */
export function isWorking(session: Session): boolean {
  return session.status === 'running' || (session.queue.length > 0 && !session.held);
}

/** Whether a workspace in this project can run this CLI. A project can bring its own key, which sign-in status doesn't know about. */
export function canRun(agent: AgentId, system: SystemStatus, project: Pick<Project, 'settings'> | undefined): boolean {
  const status = system.agents[agent];
  if (!system.agentsChecked || (status.signedIn && !status.rejected)) return true;
  const env = project?.settings.env ?? {};
  return Boolean(agent === 'claude' ? env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN : env.CODEX_API_KEY || env.OPENAI_API_KEY);
}

/** Why a Lead can't run on its model. These are the only times that model can change. */
export function leadBlocker(session: Session, catalog: Catalog, system: SystemStatus, project: Pick<Project, 'settings'> | undefined): 'retired' | 'signed-out' | 'limit' | null {
  if (!catalog[session.agent].models.some((model) => model.id === session.model)) return 'retired';
  if (!canRun(session.agent, system, project)) return 'signed-out';
  return session.lastOutcome === 'limit' ? 'limit' : null;
}
