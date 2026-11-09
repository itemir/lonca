import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, Project, Workspace } from '../../shared/types.ts';
import { FAKE_SBX, REAL_SANDBOX, Lonca, sandboxExec, git, makeFixtureRepo, sleep, until } from '../support/harness.ts';

const lonca = new Lonca({ port: 48295, instance: 'lifecycle-test', firstWorkspacePort: 50300 });
let fixture: string;
let project: Project;
let workspace: Workspace;

const setupStep = async () => (await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup');
const flag = (name: string) => path.join(lonca.home, name);

beforeAll(async () => {
  fixture = makeFixtureRepo();
  fs.writeFileSync(path.join(fixture, 'lonca.json'), JSON.stringify({ scripts: { setup: 'echo repo >> .context/setup-runs' } }));
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'Add repository setup');
  // Lets a test hold the removal of a VM, which deleting a workspace waits for.
  const wrapper = flag('sbx-hold');
  fs.writeFileSync(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const root = process.env.LONCA_HOME;
const args = process.argv.slice(2);
(async () => {
  if (args[0] === 'rm' && fs.existsSync(root + '/hold-removal')) {
    fs.writeFileSync(root + '/removal-waiting', '');
    while (fs.existsSync(root + '/hold-removal')) await new Promise(r => setTimeout(r, 25));
  }
  cp.spawn(${JSON.stringify(REAL_SANDBOX ? 'sbx' : FAKE_SBX)}, args, { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1));
})();
`, { mode: 0o700 });
  lonca.env.LONCA_SBX = wrapper;
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  const made = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(made.workspace.id);
  await until('automatic setup to finish', async () => (await setupStep())?.status === 'done');
});

afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(`${fixture}-moved`, { recursive: true, force: true });
});

describe('repository setup scripts', () => {
  it('exposes and reruns the repository script, including after a server restart', async () => {
    expect(project.settings.setupScript).toBe('');
    expect(await lonca.api('GET', `/workspaces/${workspace.id}/scripts`)).toEqual({ setup: true });
    expect(sandboxExec(workspace.sandboxName, 'cat .context/setup-runs').output).toBe('repo');
    await lonca.kill();
    await lonca.start();
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    await until('setup rerun', async () => (await setupStep())?.status === 'done'
      && sandboxExec(workspace.sandboxName, 'cat .context/setup-runs').output === 'repo\nrepo');
  });

  it('uses the current repository script and records failure, stop, and successful rerun', async () => {
    const config = path.join(workspace.path, 'lonca.json');
    fs.writeFileSync(config, JSON.stringify({ scripts: { setup: 'exit 23' } }));
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    await until('failed setup', async () => (await setupStep())?.status === 'error');
    expect((await setupStep())?.detail).toContain('23');

    fs.writeFileSync(config, JSON.stringify({ scripts: { setup: 'echo waiting; sleep 300' } }));
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    expect((await setupStep())?.status).toBe('running');
    await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
    await until('stopped setup', async () => (await setupStep())?.status === 'error');

    fs.writeFileSync(config, JSON.stringify({ scripts: { setup: 'echo repo >> .context/setup-runs' } }));
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    await until('successful setup rerun', async () => (await setupStep())?.status === 'done');
    expect((await setupStep())?.detail).toBeUndefined();
  });

  it('prefers project settings and reports when no script is available', async () => {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: 'echo override > .context/override' } });
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    await until('project setup override', () => fs.existsSync(path.join(workspace.path, '.context/override')));
    expect(fs.readFileSync(path.join(workspace.path, '.context/override'), 'utf8').trim()).toBe('override');
    await until('override to finish', async () => (await setupStep())?.status === 'done');
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: '' } });
    fs.writeFileSync(path.join(workspace.path, 'lonca.json'), '{');
    expect(await lonca.api('GET', `/workspaces/${workspace.id}/scripts`)).toEqual({ setup: false });
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`)).rejects.toThrow(/400.*no setup script/);
  });
});

it('restores its saved branch after the original local checkout moves', async () => {
  // Preserve a workspace-only commit to prove restoration uses the saved branch.
  expect(sandboxExec(workspace.sandboxName, "echo saved > saved.txt; git add saved.txt; git -c user.name=Test -c user.email=test@example.com commit --quiet -m saved").code).toBe(0);
  const commit = sandboxExec(workspace.sandboxName, 'git rev-parse HEAD').output;
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { filesToCopy: ['.env*'] } });
  await lonca.api('POST', `/workspaces/${workspace.id}/archive`);
  fs.renameSync(fixture, `${fixture}-moved`);
  try {
    await lonca.api('POST', `/workspaces/${workspace.id}/restore`);
    workspace = await lonca.waitForWorkspace(workspace.id);
    expect(sandboxExec(workspace.sandboxName, 'git rev-parse HEAD').output).toBe(commit);
    expect(fs.readFileSync(path.join(workspace.path, 'saved.txt'), 'utf8').trim()).toBe('saved');
    await until('restored setup', async () => (await setupStep())?.status === 'done');
  } finally {
    fs.renameSync(`${fixture}-moved`, fixture);
  }
});

it('does not allocate a workspace while its project is being removed', async () => {
  const repo = makeFixtureRepo();
  let deleting: Promise<unknown> | undefined;
  let removing: Workspace | undefined;
  try {
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: repo })).id);
    const made = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    removing = await lonca.waitForWorkspace(made.workspace.id);
    // Hold the removal of its VM, so that the next request definitely overlaps teardown.
    fs.writeFileSync(flag('hold-removal'), '');
    deleting = lonca.api('DELETE', `/projects/${project.id}`);
    await until('project teardown', () => fs.existsSync(flag('removal-waiting')));
    const creating = fetch(`${lonca.url}/api/projects/${project.id}/workspaces`, {
      method: 'POST', headers: { ...lonca.headers, 'content-type': 'application/json' }, body: '{}',
    });
    await sleep(200);
    fs.rmSync(flag('hold-removal'));
    await deleting;
    expect((await creating).status).toBe(404);
    const state = await lonca.api<AppState>('GET', '/state');
    expect(state.projects.some((entry) => entry.id === project.id)).toBe(false);
    expect(state.workspaces.some((entry) => entry.projectId === project.id)).toBe(false);
    expect(state.sessions.some((entry) => entry.workspaceId === removing!.id)).toBe(false);
  } finally {
    fs.rmSync(flag('hold-removal'), { force: true });
    await deleting?.catch(() => {});
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
