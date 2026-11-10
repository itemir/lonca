import { z } from 'zod';
import { allowedMethods, mergeBlocker } from '../shared/pr.ts';
import type { Checks, MergeMethod, MergeOutcome, MergeReply, PullRequest, Workspace } from '../shared/types.ts';
import { execEnv } from './env.ts';
import { getChecks, repoArg } from './inspect.ts';
import { parseGithubRepo } from './projects.ts';
import { exec } from './sandbox.ts';
import { getProject } from './store.ts';
import { HttpError, errorMessage } from './util.ts';
import { runningSandbox, underLifecycle } from './workspaces.ts';

// Merging a workspace's pull request, which the user asks for from its header. Agents in the
// workspace have gh and the same credentials, so the pull request can change at any moment,
// including while the user is deciding: everything is checked again just before and just after.

export const mergeRequestSchema = z.object({
  number: z.number().int().positive(),
  /** The head the user saw. GitHub refuses the merge if it's moved since. */
  headOid: z.string().regex(/^[0-9a-f]{40}$/, 'That isn’t a commit.'),
  /** The base the user saw, which `--match-head-commit` doesn't guard. */
  base: z.string().min(1).max(255),
  method: z.enum(['squash', 'merge', 'rebase']),
}).strict();

export type MergeRequest = z.infer<typeof mergeRequestSchema>;

const MERGE_TIMEOUT_MS = 60_000;

const METHOD_NAMES: Record<MergeMethod, string> = { squash: 'squash merging', merge: 'merge commits', rebase: 'rebase merging' };

/**
 * With a number and `--repo`, gh does no git work in the checkout, and with the host in `--repo`,
 * a project's GH_HOST can't send it elsewhere. It never deletes a branch, which would take the one
 * the agents are on, and never goes around the repository's rules.
 */
export function mergeArgs(repo: { owner: string; name: string }, request: MergeRequest): string[] {
  return ['gh', 'pr', 'merge', String(request.number), '--repo', repoArg(repo), `--${request.method}`, '--match-head-commit', request.headOid];
}

/** gh's message without its advice, which is about flags Lonca never passes or commands that don't apply. */
export function cleanMergeError(output: string, number: number): string {
  const text = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/`--auto`|`--admin`|gh pr checkout|resolve the merge conflicts locally/i.test(line))
    .map((line) => line
      .replace(/^(?:X|✗|!)\s+/, '')
      .replace(/^GraphQL:\s*/, '')
      .replace(/\s*\(mergePullRequest\)\s*$/, '')
      .replace(/^Pull request [\w.-]+\/[\w.-]+#(\d+)/, '#$1'))
    .filter(Boolean)
    .join(' ');
  return text || `GitHub didn’t merge #${number}.`;
}

/**
 * A merge into another base than the one confirmed. GitHub can only be told which head to merge, so an
 * agent that retargets the pull request at the last moment, or merged it first, can't be stopped. It
 * can be said, though.
 */
function merged(pr: PullRequest, request: Pick<MergeRequest, 'number' | 'base'>): { outcome: 'merged'; message?: string } {
  if (pr.baseRefName === request.base) return { outcome: 'merged' };
  return { outcome: 'merged', message: `#${request.number} was merged into ${pr.baseRefName}, not ${request.base}.` };
}

export type MergeCheck =
  | { action: 'merge' }
  | { action: 'reply'; outcome: MergeOutcome; message?: string }
  | { action: 'refuse'; status: number; message: string };

/** What a read just before merging allows. Only what the user saw is merged. */
export function checkBeforeMerge(checks: Checks, request: MergeRequest): MergeCheck {
  const { number } = request;
  const refuse = (status: number, message: string): MergeCheck => ({ action: 'refuse', status, message });
  if (checks.github === 'error') return refuse(502, `GitHub couldn’t be reached, so nothing was merged. ${checks.error ?? ''}`.trim());
  if (checks.github !== 'connected') return refuse(409, 'Lonca can’t reach this project on GitHub, so nothing was merged.');
  const pr = checks.pr;
  if (!pr || pr.number !== number) return refuse(409, `#${number} isn’t this workspace’s pull request any more, so nothing was merged.`);
  // Someone, an agent perhaps, got there first. That's what the user wanted.
  if (pr.state === 'MERGED') return { action: 'reply', ...merged(pr, request) };
  if (pr.state === 'CLOSED') return { action: 'reply', outcome: 'failed', message: `#${number} was closed, so nothing was merged.` };
  if (pr.headRefOid !== request.headOid) return refuse(409, 'New commits were pushed after you looked, so nothing was merged. Check them, then merge again.');
  if (pr.baseRefName !== request.base) {
    return refuse(409, `#${number} now targets ${pr.baseRefName}, not ${request.base}, so nothing was merged. Check it, then merge again.`);
  }
  if (!allowedMethods(checks.repo).includes(request.method)) {
    return refuse(400, `This repository doesn’t allow ${METHOD_NAMES[request.method]}.`);
  }
  const blocker = mergeBlocker(checks);
  if (blocker) return refuse(409, `${blocker} Nothing was merged.`);
  return { action: 'merge' };
}

export interface GhResult {
  /** gh's exit code, or null if it never finished. */
  code: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * The outcome comes from a read after gh finished, whatever gh said: it exits 0 when the pull
 * request was already merged, too.
 */
export function mergeOutcome(after: Checks, gh: GhResult, request: Pick<MergeRequest, 'number' | 'base'>): { outcome: MergeOutcome; message?: string } {
  const { number } = request;
  const unknown = { outcome: 'unknown' as const, message: `Lonca couldn’t confirm the merge. Check #${number} on GitHub before trying again.` };
  const pr = after.github === 'connected' ? after.pr : null;
  if (!pr || pr.number !== number) return unknown;
  if (pr.state === 'MERGED') return merged(pr, request);
  if (pr.state === 'CLOSED') return { outcome: 'failed', message: `#${number} was closed, so nothing was merged.` };
  if (gh.timedOut) return unknown;
  if (gh.code === 0) return { outcome: 'pending', message: `GitHub accepted the merge, but #${number} isn’t merged yet. Lonca keeps checking.` };
  return { outcome: 'failed', message: cleanMergeError(gh.output, number) };
}

function unreadable(error: unknown): Checks {
  return { github: 'error', error: errorMessage(error), pr: null, checks: [], repo: null, local: null, checkedAt: Date.now() };
}

const merging = new Set<string>();

/** Merges the workspace's pull request as the user confirmed it. It never starts a stopped workspace. */
export async function mergePullRequest(workspace: Workspace, request: MergeRequest): Promise<MergeReply> {
  if (workspace.status !== 'ready') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  // Checked before waiting for the lock, so that a second merge is turned away rather than queued.
  if (merging.has(workspace.id)) throw new HttpError(409, 'A merge is already under way.');
  merging.add(workspace.id);
  try {
    // Stop, Archive and Rebuild wait for this, so the workspace stays as it was while it's merged.
    return await underLifecycle(workspace, async () => {
      const project = getProject(workspace.projectId);
      const repo = parseGithubRepo(project?.remoteUrl ?? null);
      if (!project || !repo) throw new HttpError(409, 'This project isn’t on GitHub.');
      const before = await getChecks(workspace);
      const check = checkBeforeMerge(before, request);
      if (check.action === 'refuse') throw new HttpError(check.status, check.message);
      if (check.action === 'reply') return { outcome: check.outcome, ...(check.message ? { message: check.message } : {}), checks: before };
      const sandbox = await runningSandbox(workspace);
      let gh: GhResult;
      try {
        const result = await exec(sandbox, mergeArgs(repo, request), {
          workdir: workspace.path,
          env: [...execEnv(project), 'GH_PROMPT_DISABLED=1'],
          timeoutMs: MERGE_TIMEOUT_MS,
        });
        // 124 and 137 are `timeout` ending it, which leaves GitHub's answer unknown.
        gh = { code: result.code, timedOut: result.code === 124 || result.code === 137, output: `${result.stderr.toString('utf8')}\n${result.stdout.toString('utf8')}` };
      } catch (error) {
        gh = { code: null, timedOut: true, output: errorMessage(error) };
      }
      const after = await getChecks(workspace).catch(unreadable);
      return { ...mergeOutcome(after, gh, request), checks: after };
    });
  } finally {
    merging.delete(workspace.id);
  }
}
