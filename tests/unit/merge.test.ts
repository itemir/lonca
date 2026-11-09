import { describe, expect, it } from 'vitest';
import type { Checks, PullRequest } from '../../shared/types.ts';
import { mergeSettingsArgs, parseLocalState, parseMergeSettings, parsePullRequest, prViewArgs } from '../../server/inspect.ts';
import { checkBeforeMerge, cleanMergeError, type GhResult, mergeArgs, mergeOutcome, type MergeRequest, mergeRequestSchema } from '../../server/merge.ts';
import { parseGithubOwner, parseGithubRepo } from '../../server/projects.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7, title: 'T', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', headRefOid: HEAD, baseRefName: 'main', createdAt: '2026-11-02T10:00:00Z', mergedAt: null, closedAt: null,
    autoMergeRequest: false, ...overrides,
  };
}

function read(overrides: Partial<PullRequest> = {}, extra: Partial<Checks> = {}): Checks {
  return {
    github: 'connected', pr: pr(overrides), checks: [], local: { head: HEAD, unpushed: 0, uncommitted: 0 }, checkedAt: 1,
    repo: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: 'SQUASH', viewerPermission: 'WRITE' },
    queue: { enabled: false, queued: false },
    ...extra,
  };
}

const request: MergeRequest = { number: 7, headOid: HEAD, base: 'main', method: 'squash' };

describe('the repository a project’s pull requests are in', () => {
  it('reads owner and name from GitHub URLs only', () => {
    expect(parseGithubRepo('https://github.com/itemir/lonca.git')).toEqual({ owner: 'itemir', name: 'lonca' });
    expect(parseGithubRepo('https://github.com/itemir/lonca')).toEqual({ owner: 'itemir', name: 'lonca' });
    expect(parseGithubRepo('https://github.com/itemir/lonca/')).toEqual({ owner: 'itemir', name: 'lonca' });
    expect(parseGithubRepo('git@github.com:octocat/Hello-World.git')).toEqual({ owner: 'octocat', name: 'Hello-World' });
    expect(parseGithubRepo('ssh://git@github.com/a-b/c.d.git')).toEqual({ owner: 'a-b', name: 'c.d' });
    expect(parseGithubRepo('https://gitlab.com/a/b.git')).toBeNull();
    expect(parseGithubRepo('https://github.example.com/a/b.git')).toBeNull();
    expect(parseGithubRepo('https://evil.example/github.com/a/b.git')).toBeNull();
    expect(parseGithubRepo('https://github.com/a/b/c.git')).toBeNull();
    expect(parseGithubRepo('https://github.com/../b.git')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
    // Whatever counts as GitHub here also has an owner for its avatar.
    expect(parseGithubOwner('git@github.com:octocat/Hello-World.git')).toBe('octocat');
  });

  it('names it in the view command, host and all, so neither the checkout nor GH_HOST can redirect it', () => {
    expect(prViewArgs('itemir/salzburg', { owner: 'itemir', name: 'lonca' })).toEqual([
      'gh', 'pr', 'view', 'itemir/salzburg', '--repo', 'github.com/itemir/lonca', '--json',
      'number,title,url,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,baseRefName,createdAt,mergedAt,closedAt,autoMergeRequest',
    ]);
    const query = mergeSettingsArgs('123', '2048', 7);
    expect(query.slice(0, 5)).toEqual(['gh', 'api', 'graphql', '--hostname', 'github.com']);
    expect(query).toContain('owner=123');
    expect(query[query.indexOf('owner=123') - 1]).toBe('-f');
    expect(query.slice(-2)).toEqual(['-F', 'number=7']);
    expect(query.join(' ')).not.toMatch(/mutation/);
  });
});

describe('what GitHub says', () => {
  it('reads a pull request, with booleans where gh sends objects or empty strings', () => {
    const parsed = parsePullRequest({
      ...pr(), reviewDecision: '', mergedAt: '', autoMergeRequest: { mergeMethod: 'SQUASH' },
      statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    expect(parsed?.pr).toMatchObject({ reviewDecision: null, mergedAt: null, autoMergeRequest: true, state: 'OPEN' });
    expect(parsed?.checks).toEqual([{ name: 'ci', status: 'failure', url: undefined }]);
    expect(parsePullRequest({ ...pr(), autoMergeRequest: null })?.pr.autoMergeRequest).toBe(false);
    expect(parsePullRequest({ ...pr(), headRefOid: '--upload-pack=x' })?.pr.headRefOid).toBe('');
    expect(parsePullRequest({ ...pr(), state: 'WEIRD' })).toBeNull();
    // A merge state that's missing or new to Lonca is taken as one GitHub is still working out.
    expect(parsePullRequest({ ...pr(), mergeStateStatus: undefined })?.pr.mergeStateStatus).toBe('UNKNOWN');
    expect(parsePullRequest({ ...pr(), mergeStateStatus: 'SOMETHING_NEW' })?.pr.mergeStateStatus).toBe('UNKNOWN');
    expect(parsePullRequest({ ...pr(), mergeStateStatus: 'has_hooks' })?.pr.mergeStateStatus).toBe('HAS_HOOKS');
    expect(parsePullRequest({ number: '7' })).toBeNull();
    expect(parsePullRequest(null)).toBeNull();
  });

  it('reads merge settings and the merge queue', () => {
    const output = JSON.stringify({ data: { repository: {
      mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: 'SQUASH', viewerPermission: 'ADMIN',
      pullRequest: { isInMergeQueue: false, isMergeQueueEnabled: true },
    } } });
    expect(parseMergeSettings(output)).toEqual({
      repo: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: 'SQUASH', viewerPermission: 'ADMIN' },
      queue: { enabled: true, queued: false },
    });
    expect(parseMergeSettings('{"data":{"repository":null}}')).toBeNull();
    expect(parseMergeSettings('not json')).toBeNull();
  });

  it('reads the workspace’s own state', () => {
    expect(parseLocalState(`${HEAD} 0 3\n`)).toEqual({ head: HEAD, unpushed: 0, uncommitted: 3 });
    expect(parseLocalState(`${HEAD} null 0\n`)).toEqual({ head: HEAD, unpushed: null, uncommitted: 0 });
    expect(parseLocalState('')).toBeNull();
    expect(parseLocalState(`${HEAD} -1 0`)).toBeNull();
  });
});

describe('merging', () => {
  it('accepts only what the dialog sends', () => {
    expect(mergeRequestSchema.safeParse(request).success).toBe(true);
    expect(mergeRequestSchema.safeParse({ ...request, admin: true }).success).toBe(false);
    expect(mergeRequestSchema.safeParse({ ...request, method: 'admin' }).success).toBe(false);
    expect(mergeRequestSchema.safeParse({ ...request, headOid: 'HEAD' }).success).toBe(false);
    expect(mergeRequestSchema.safeParse({ ...request, number: 0 }).success).toBe(false);
    expect(mergeRequestSchema.safeParse({ ...request, base: 'x'.repeat(256) }).success).toBe(false);
  });

  it('runs gh with the repository, the method and the head the user saw, and nothing that goes around the rules', () => {
    for (const method of ['squash', 'merge', 'rebase'] as const) {
      const args = mergeArgs({ owner: 'itemir', name: 'lonca' }, { ...request, method });
      expect(args).toEqual(['gh', 'pr', 'merge', '7', '--repo', 'github.com/itemir/lonca', `--${method}`, '--match-head-commit', HEAD]);
      for (const forbidden of ['--delete-branch', '-d', '--admin', '--auto', '--subject', '--body', '-t', '-b']) expect(args).not.toContain(forbidden);
    }
  });

  it('checks the pull request again just before merging', () => {
    expect(checkBeforeMerge(read(), request)).toEqual({ action: 'merge' });
    expect(checkBeforeMerge(read({ state: 'MERGED' }), request)).toEqual({ action: 'reply', outcome: 'merged' });
    expect(checkBeforeMerge(read({ state: 'CLOSED' }), request)).toEqual({ action: 'reply', outcome: 'failed', message: '#7 was closed, so nothing was merged.' });
    expect(checkBeforeMerge(read({ headRefOid: OTHER }), request)).toEqual({
      action: 'refuse', status: 409, message: 'New commits were pushed after you looked, so nothing was merged. Check them, then merge again.',
    });
    expect(checkBeforeMerge(read({ baseRefName: 'release' }), request)).toEqual({
      action: 'refuse', status: 409, message: '#7 now targets release, not main, so nothing was merged. Check it, then merge again.',
    });
    expect(checkBeforeMerge(read({ number: 8 }), request)).toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge({ ...read(), pr: null }, request)).toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge(read(), { ...request, method: 'rebase' })).toEqual({ action: 'refuse', status: 400, message: 'This repository doesn’t allow rebase merging.' });
    // A merge queue decides the method itself.
    expect(checkBeforeMerge(read({}, { queue: { enabled: true, queued: false } }), { ...request, method: 'rebase' })).toEqual({ action: 'merge' });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'DIRTY' }), request)).toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge(read({ mergeStateStatus: null }), request)).toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'SOMETHING_NEW' }), request)).toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge(read({ isDraft: true }), request)).toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge({ ...read(), github: 'error', error: 'HTTP 502', pr: null }, request)).toMatchObject({ action: 'refuse', status: 502 });
  });

  it('adds one to a merge queue, which GitHub reports as BLOCKED until it goes through', () => {
    const queue = { queue: { enabled: true, queued: false } };
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED' }, queue), request)).toEqual({ action: 'merge' });
    // Whatever else is known to block it still does.
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED' }, { ...queue, checks: [{ name: 'ci', status: 'failure' }] }), request))
      .toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED' }, { ...queue, checks: [{ name: 'ci', status: 'pending' }] }), request))
      .toMatchObject({ action: 'refuse', status: 409 });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, queue), request)).toMatchObject({ action: 'refuse' });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }, queue), request)).toMatchObject({ action: 'refuse' });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED', mergeable: 'CONFLICTING' }, queue), request)).toMatchObject({ action: 'refuse' });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BEHIND' }, queue), request)).toMatchObject({ action: 'refuse' });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED', isDraft: true }, queue), request)).toMatchObject({ action: 'refuse' });
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED' }, { queue: { enabled: true, queued: true } }), request)).toMatchObject({ action: 'refuse' });
    // Without a queue, BLOCKED is a rule that stands in the way.
    expect(checkBeforeMerge(read({ mergeStateStatus: 'BLOCKED' }), request)).toMatchObject({ action: 'refuse', status: 409 });
  });

  const ok: GhResult = { code: 0, timedOut: false, output: '' };
  const failed: GhResult = { code: 1, timedOut: false, output: 'GraphQL: Pull request is not mergeable (mergePullRequest)' };
  const timedOut: GhResult = { code: null, timedOut: true, output: 'Timed out running gh in the workspace’s sandbox' };

  it.each([
    ['merged, whatever gh said', read({ state: 'MERGED' }), failed, { outcome: 'merged' }],
    ['merged after gh timed out', read({ state: 'MERGED' }), timedOut, { outcome: 'merged' }],
    ['queued', read({}, { queue: { enabled: true, queued: true } }), ok, { outcome: 'queued', message: 'GitHub will merge #7 when it’s ready.' }],
    ['auto-merge', read({ autoMergeRequest: true }), ok, { outcome: 'queued' }],
    ['open after gh succeeded', read(), ok, { outcome: 'pending', message: 'GitHub accepted the merge, but #7 isn’t merged yet. Lonca keeps checking.' }],
    ['open after gh failed', read(), failed, { outcome: 'failed', message: 'Pull request is not mergeable' }],
    ['closed', read({ state: 'CLOSED' }), ok, { outcome: 'failed', message: '#7 was closed, so nothing was merged.' }],
    ['open after gh timed out', read(), timedOut, { outcome: 'unknown', message: 'Lonca couldn’t confirm the merge. Check #7 on GitHub before trying again.' }],
    ['a read that failed', { ...read(), github: 'error' as const, pr: null }, ok, { outcome: 'unknown' }],
    ['a different pull request', read({ number: 8, state: 'MERGED' }), ok, { outcome: 'unknown' }],
  ])('takes the outcome from the read after gh: %s', (_name, after, gh, expected) => {
    expect(mergeOutcome(after, gh, 7)).toMatchObject(expected);
  });

  it('cleans up gh’s messages', () => {
    expect(cleanMergeError('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n', 7))
      .toBe('Head branch was modified. Review and try the merge again.');
    expect(cleanMergeError([
      'X Pull request itemir/lonca#7 is not mergeable: the base branch policy prohibits the merge.',
      'To have the pull request merged after all the requirements have been met, add the `--auto` flag.',
      'To use administrator privileges to immediately merge the pull request, add the `--admin` flag.',
      '',
    ].join('\n'), 7)).toBe('#7 is not mergeable: the base branch policy prohibits the merge.');
    expect(cleanMergeError([
      'X Pull request itemir/lonca#7 is not mergeable: the merge commit cannot be cleanly created.',
      'Run the following to resolve the merge conflicts locally:',
      '  gh pr checkout 7 && git fetch origin main && git merge origin/main',
    ].join('\n'), 7)).toBe('#7 is not mergeable: the merge commit cannot be cleanly created.');
    expect(cleanMergeError('GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)', 7)).toBe('Merge commits are not allowed on this repository.');
    expect(cleanMergeError('\n\n', 7)).toBe('GitHub didn’t merge #7.');
  });
});
