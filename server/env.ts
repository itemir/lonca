import type { Profile, Project } from '../shared/types.ts';
import { claudeEnv, placeholderEnv } from './boundary.ts';
import { state } from './store.ts';

/**
 * Environment for agents, terminals and scripts. It holds no credentials of Lonca's, only
 * placeholders for them: for Claude's, those of the sign-in given, or of the default one.
 */
export function execEnv(project: Project | undefined, claude?: Pick<Profile, 'id' | 'agent'>): string[] {
  const { gitName, gitEmail } = state.settings;
  const identity = [
    ...(gitName ? [`GIT_AUTHOR_NAME=${gitName}`, `GIT_COMMITTER_NAME=${gitName}`] : []),
    ...(gitEmail ? [`GIT_AUTHOR_EMAIL=${gitEmail}`, `GIT_COMMITTER_EMAIL=${gitEmail}`] : []),
  ];
  const custom = Object.entries(project?.settings.env ?? {}).map(([key, value]) => `${key}=${value}`);
  return [...identity, ...(claude ? claudeEnv(claude) : placeholderEnv()), ...custom];
}
