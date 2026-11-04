import type { Attachment, Project, Workspace } from '../../shared/types.ts';

export function systemPrompt(workspace: Workspace, project: Project): string {
  const lastPort = workspace.port + 9;
  const inVm = workspace.runtime === 'sandbox';
  const place = inVm ? 'virtual machine' : 'container';
  return [
    `You are working in Lonca workspace "${workspace.name}" of the project "${project.name}", inside an isolated ${inVm ? 'virtual machine' : 'Docker container'}.`,
    `The repository is a git worktree at ${workspace.path} on branch ${workspace.branch}. Its target is origin/${workspace.baseBranch}: compare with \`git diff origin/${workspace.baseBranch}...\` and open pull requests with \`gh pr create --base ${workspace.baseBranch}\`.`,
    'Keep the current branch name unless asked to change it. The .context directory is gitignored: use it for scratch files. Files the user attaches appear in .context/attachments.',
    `Ports ${workspace.port}-${lastPort} (the first is in $LONCA_PORT) are published to the user's localhost. Servers must listen on 0.0.0.0 on one of those ports for the user to open them.`,
    project.settings.network === 'internet'
      ? `The ${place} can reach the internet, but not the user's computer, their local network or other workspaces.`
      : `The ${place} can reach the internet and the user's computer at host.docker.internal.`,
    ...(inVm ? ['You have sudo and a Docker engine of your own here. Neither reaches outside this virtual machine.'] : []),
  ].join('\n');
}

export function userPrompt(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const list = attachments.map((file) => `- ${file.path}`).join('\n');
  return `The user has attached these files. Read them before proceeding:\n${list}\n\n${text}`;
}
