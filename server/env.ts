import type { Profile, Project } from '../shared/types.ts';
import { placeholderEnv } from './boundary.ts';
import { state } from './store.ts';

/**
 * Environment for agents, terminals and scripts. It holds no credentials of Lonca's, only
 * placeholders for them: those of the sign-in given, for its provider, and the defaults' for the
 * others. `extra` goes before the project's own variables, which can override it.
 */
export function execEnv(project: Project | undefined, profile?: Pick<Profile, 'id' | 'agent'>, extra: string[] = []): string[] {
  const { gitName, gitEmail } = state.settings;
  const identity = [
    ...(gitName ? [`GIT_AUTHOR_NAME=${gitName}`, `GIT_COMMITTER_NAME=${gitName}`] : []),
    ...(gitEmail ? [`GIT_AUTHOR_EMAIL=${gitEmail}`, `GIT_COMMITTER_EMAIL=${gitEmail}`] : []),
  ];
  const custom = Object.entries(project?.settings.env ?? {}).map(([key, value]) => `${key}=${value}`);
  return [...identity, ...placeholderEnv(project, profile), ...extra, ...custom];
}
