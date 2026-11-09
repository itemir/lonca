// Reading and merging a workspace's pull request, with a stand-in for gh inside the sandbox
// (tests/support/fake-gh), so nothing here reaches GitHub, let alone changes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Checks, MergeReply, Project, Workspace } from '../../shared/types.ts';
import { Lonca, REPO_ROOT, RUNTIME, asRoot, git, makeFixtureRepo, sandboxExec, sandboxRunning, sbx } from '../support/harness.ts';

const lonca = new Lonca({ port: 48461, instance: `pull-request-${RUNTIME}`, firstWorkspacePort: 59600 });
const REPO = 'lonca-test/merge-fixture';
let fixture: string;
let scratch: string;
let project: Project;
let workspace: Workspace;
let head: string;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Sets what the fake gh answers. A null removes that answer. */
function answer(files: Record<string, string | object | null>): void {
  const lines = Object.entries(files).map(([name, content]) => {
    if (content === null) return `rm -f /var/tmp/fake-gh/${name}`;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return `printf %s ${quote(Buffer.from(text).toString('base64'))} | base64 -d > /var/tmp/fake-gh/${name}`;
  });
  const result = sandboxExec(workspace.sandboxName, lines.join(' && '));
  if (result.code !== 0) throw new Error(result.output);
}

/** Each call the fake gh got, as its arguments. */
function calls(): string[][] {
  const log = sandboxExec(workspace.sandboxName, 'cat /var/tmp/fake-gh/calls.log 2>/dev/null').output;
  return log.split('\n').filter(Boolean).map((line) => line.split('\x1f').slice(0, -1));
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'Name terminals after the project and branch',
    url: `https://github.com/${REPO}/pull/7`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.com/ci' }],
    headRefOid: head,
    baseRefName: 'main',
    createdAt: new Date(workspace.createdAt + 60_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function graphql() {
  return {
    data: {
      repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: 'SQUASH', viewerPermission: 'WRITE' },
    },
  };
}

const merged = () => view({ state: 'MERGED', mergedAt: new Date().toISOString(), mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${lonca.url}/api/workspaces/${workspace.id}/pr/merge`, {
    method: 'POST',
    headers: { ...lonca.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const request = (overrides: Record<string, unknown> = {}) => ({ number: 7, headOid: head, base: 'main', method: 'squash', ...overrides });
const merges = () => calls().filter(([command, action]) => command === 'pr' && action === 'merge');

beforeAll(async () => {
  // The project's remote is on GitHub, where the host's Git can't reach, so it imports what's on disk.
  fixture = makeFixtureRepo();
  git(fixture, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-merge-'));
  const config = path.join(scratch, 'gitconfig');
  fs.writeFileSync(config, '[http "https://github.com/"]\n\tproxy = http://127.0.0.1:9\n');
  lonca.env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, NO_PROXY: '', no_proxy: '' };
  await lonca.start();
  await lonca.api('PUT', '/secrets/github', { token: 'github_pat_not_a_real_token' });
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  expect(project.githubOwner).toBe('lonca-test');
  workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
  // Installed as root, where the real one is, as an agent couldn't.
  sbx('cp', path.join(REPO_ROOT, 'tests', 'support', 'fake-gh'), `${workspace.sandboxName}:/var/tmp/fake-gh-script`);
  asRoot(workspace.sandboxName, `
    real=$(command -v gh)
    mv "$real" "$real.real"
    install -m 755 /var/tmp/fake-gh-script "$real"
    install -d -m 777 /var/tmp/fake-gh
  `);
  head = sandboxExec(workspace.sandboxName, `git -C ${quote(workspace.path)} rev-parse HEAD`).output;
});

afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  if ((await lonca.workspace(workspace.id)).status !== 'ready' || !sandboxRunning(workspace.sandboxName)) {
    await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    await lonca.waitForWorkspace(workspace.id);
  }
  sandboxExec(workspace.sandboxName, 'rm -f /var/tmp/fake-gh/*');
  answer({ 'view.json': view(), 'graphql.json': graphql() });
});

describe('reading a pull request', () => {
  it('reads it from the project’s repository on GitHub, with merge settings and the workspace’s own state', async () => {
    const checks = await lonca.api<Checks>('GET', `/workspaces/${workspace.id}/checks`);
    expect(checks).toMatchObject({
      github: 'connected',
      pr: { number: 7, state: 'OPEN', headRefOid: head, baseRefName: 'main', reviewDecision: null },
      checks: [{ name: 'test', status: 'success' }],
      repo: { squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: 'SQUASH', viewerPermission: 'WRITE' },
      local: { head, unpushed: 0, uncommitted: 0 },
    });
    const [viewCall, queryCall] = calls();
    expect(viewCall).toEqual([
      'pr', 'view', workspace.branch, '--repo', `github.com/${REPO}`, '--json',
      'number,title,url,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,baseRefName,createdAt,mergedAt,closedAt',
    ]);
    // github.com is named every time, so a project's GH_HOST can't send any of it elsewhere.
    expect(queryCall.slice(0, 6)).toEqual(['api', 'graphql', '--hostname', 'github.com', '-f', expect.stringMatching(/^query=query\(/)]);
    expect(queryCall.slice(6)).toEqual(['-f', 'owner=lonca-test', '-f', 'name=merge-fixture']);
    expect(queryCall.join(' ')).not.toMatch(/mutation/);
    expect((await lonca.workspace(workspace.id)).pr).toMatchObject({ number: 7, state: 'OPEN', headRefOid: head, baseRefName: 'main' });
  });

  it('counts commits and changes that aren’t in the pull request', async () => {
    sandboxExec(workspace.sandboxName, `cd ${quote(workspace.path)} && echo more > more.txt && git add more.txt &&
      git -c user.name=T -c user.email=t@example.com commit -qm more && echo loose > loose.txt`);
    try {
      const checks = await lonca.api<Checks>('GET', `/workspaces/${workspace.id}/checks`);
      expect(checks.local).toMatchObject({ unpushed: 1, uncommitted: 1 });
      // A head the workspace has never seen can't be compared.
      answer({ 'view.json': view({ headRefOid: 'c'.repeat(40) }) });
      expect((await lonca.api<Checks>('GET', `/workspaces/${workspace.id}/checks`)).local).toMatchObject({ unpushed: null });
    } finally {
      sandboxExec(workspace.sandboxName, `cd ${quote(workspace.path)} && git reset -q --hard ${head} && rm -f loose.txt`);
    }
  });

  it('counts changes the checkout’s own config would hide from git status', async () => {
    sandboxExec(workspace.sandboxName, `cd ${quote(workspace.path)} && git config status.showUntrackedFiles no && echo hidden > hidden.txt`);
    try {
      expect((await lonca.api<Checks>('GET', `/workspaces/${workspace.id}/checks`)).local).toMatchObject({ unpushed: 0, uncommitted: 1 });
    } finally {
      sandboxExec(workspace.sandboxName, `cd ${quote(workspace.path)} && git config --unset status.showUntrackedFiles; rm -f hidden.txt`);
    }
  });

  it('ignores a pull request opened before the workspace, which an earlier one with its name left', async () => {
    answer({ 'view.json': merged() });
    await lonca.api('GET', `/workspaces/${workspace.id}/checks`);
    answer({ 'view.json': view({ state: 'MERGED', createdAt: new Date(workspace.createdAt - 86_400_000).toISOString() }) });
    expect(await lonca.api<Checks>('GET', `/workspaces/${workspace.id}/checks`)).toMatchObject({ github: 'connected', pr: null });
    expect((await lonca.workspace(workspace.id)).pr).toBeNull();
  });

  it('reports a failure as one, keeping the last known pull request', async () => {
    await lonca.api('GET', `/workspaces/${workspace.id}/checks`);
    answer({ 'view.err': 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' });
    expect(await lonca.api<Checks>('GET', `/workspaces/${workspace.id}/checks`)).toMatchObject({ github: 'error', error: expect.stringContaining('502'), pr: null });
    expect((await lonca.workspace(workspace.id)).pr).toMatchObject({ number: 7, state: 'OPEN' });
    answer({ 'view.err': 'no pull requests found for branch "x"' });
    expect(await lonca.api<Checks>('GET', `/workspaces/${workspace.id}/checks`)).toMatchObject({ github: 'connected', pr: null });
  });

  it('doesn’t wake a stopped workspace to read it', async () => {
    sbx('stop', workspace.sandboxName);
    const response = await fetch(`${lonca.url}/api/workspaces/${workspace.id}/checks`, { headers: lonca.headers });
    expect(response.status).toBe(409);
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  });
});

describe('merging', () => {
  it('merges with the method and head the user saw, and nothing that goes around the rules', async () => {
    answer({ 'after-view.json': merged() });
    const reply = await post(request());
    expect(reply).toMatchObject({ status: 200, body: { outcome: 'merged', checks: { pr: { state: 'MERGED' } } } });
    expect(merges()).toEqual([['pr', 'merge', '7', '--repo', `github.com/${REPO}`, '--squash', '--match-head-commit', head]]);
    for (const forbidden of ['--delete-branch', '-d', '--admin', '--auto', '--subject', '--body']) expect(calls().flat()).not.toContain(forbidden);
    expect((await lonca.workspace(workspace.id)).pr).toMatchObject({ state: 'MERGED' });
  });

  it('says merged without merging when someone got there first', async () => {
    answer({ 'view.json': merged() });
    expect(await post(request())).toMatchObject({ status: 200, body: { outcome: 'merged' } });
    expect(merges()).toEqual([]);
    // gh itself exits 0 for one that was already merged.
    answer({ 'view.json': view(), 'after-view.json': merged(), 'merge.stderr': '! Pull request lonca-test/merge-fixture#7 was already merged\n' });
    expect(await post(request())).toMatchObject({ status: 200, body: { outcome: 'merged' } });
  });

  it('refuses when new commits arrived after the user looked, or the base changed', async () => {
    const stale = await post(request({ headOid: 'd'.repeat(40) }));
    expect(stale).toEqual({ status: 409, body: { error: 'New commits were pushed after you looked, so nothing was merged. Check them, then merge again.' } });
    answer({ 'view.json': view({ baseRefName: 'release' }) });
    expect(await post(request())).toEqual({ status: 409, body: { error: '#7 now targets release, not main, so nothing was merged. Check it, then merge again.' } });
    answer({ 'view.json': view({ state: 'CLOSED', closedAt: new Date().toISOString() }) });
    expect(await post(request())).toMatchObject({ status: 200, body: { outcome: 'failed', message: '#7 was closed, so nothing was merged.' } });
    answer({ 'view.json': view() });
    expect(await post(request({ method: 'rebase' }))).toEqual({ status: 400, body: { error: 'This repository doesn’t allow rebase merging.' } });
    expect(await post({ ...request(), admin: true })).toMatchObject({ status: 400 });
    expect(merges()).toEqual([]);
  });

  it('runs one merge at a time', async () => {
    answer({ 'merge.sleep': '3', 'after-view.json': merged() });
    const first = post(request());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await post(request())).toEqual({ status: 409, body: { error: 'A merge is already under way.' } });
    expect(await first).toMatchObject({ status: 200, body: { outcome: 'merged' } });
    expect(merges()).toHaveLength(1);
  });

  it('keeps Stop waiting until a merge has finished', async () => {
    answer({ 'merge.sleep': '3', 'after-view.json': merged() });
    const merging = post(request());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let stopped = 0;
    const stop = lonca.api('POST', `/workspaces/${workspace.id}/stop`).then(() => { stopped = Date.now(); });
    const reply = await merging;
    const answered = Date.now();
    await stop;
    expect(reply).toMatchObject({ status: 200, body: { outcome: 'merged' } });
    expect(stopped).toBeGreaterThanOrEqual(answered - 50);
  });

  it('refuses a stopped workspace without starting it', async () => {
    sbx('stop', workspace.sandboxName);
    expect(await post(request())).toMatchObject({ status: 409 });
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'stopped' });
    expect(await post(request())).toMatchObject({ status: 409, body: { error: expect.stringContaining('stopped') } });
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  });

  it('leaves a rule that blocks merging to GitHub, trying nothing', async () => {
    answer({ 'view.json': view({ mergeStateStatus: 'BLOCKED' }) });
    expect(await post(request())).toMatchObject({ status: 409 });
    expect(merges()).toEqual([]);
  });

  it('says so when GitHub accepted a merge it doesn’t show yet', async () => {
    expect(await post(request())).toMatchObject({ status: 200, body: { outcome: 'pending' } });
  });

  it('passes on why GitHub refused, without gh’s advice', async () => {
    answer({
      'merge.code': '1',
      'merge.stderr': [
        'X Pull request lonca-test/merge-fixture#7 is not mergeable: the base branch policy prohibits the merge.',
        'To have the pull request merged after all the requirements have been met, add the `--auto` flag.',
        'To use administrator privileges to immediately merge the pull request, add the `--admin` flag.',
        '',
      ].join('\n'),
    });
    const reply = await post(request());
    expect(reply).toMatchObject({ status: 200, body: { outcome: 'failed', message: '#7 is not mergeable: the base branch policy prohibits the merge.' } });
    expect((reply.body as MergeReply).checks.pr?.state).toBe('OPEN');
  });

  it('says it can’t tell when gh runs out of time', async () => {
    answer({ 'merge.code': '124' });
    expect(await post(request())).toMatchObject({
      status: 200, body: { outcome: 'unknown', message: 'Lonca couldn’t confirm the merge. Check #7 on GitHub before trying again.' },
    });
  });
});
