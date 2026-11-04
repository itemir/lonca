import type { Project } from '../shared/types.ts';
import { state } from './store.ts';
import { secretEnv } from './system.ts';

/** Environment for agents, terminals and scripts. Secrets are passed per process, never baked into a container. */
export function execEnv(project: Project | undefined): string[] {
  const { gitName, gitEmail } = state.settings;
  const identity = [
    ...(gitName ? [`GIT_AUTHOR_NAME=${gitName}`, `GIT_COMMITTER_NAME=${gitName}`] : []),
    ...(gitEmail ? [`GIT_AUTHOR_EMAIL=${gitEmail}`, `GIT_COMMITTER_EMAIL=${gitEmail}`] : []),
  ];
  const custom = Object.entries(project?.settings.env ?? {}).map(([key, value]) => `${key}=${value}`);
  return [...identity, ...secretEnv(), ...custom];
}
