import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, Project, Workspace } from '../../shared/types.ts';
import { IN_SANDBOX, Lonca, asRoot, docker, dockerExec, git, makeFixtureRepo, sleep, until } from '../support/harness.ts';

const lonca = new Lonca({ port: 48295, instance: 'lifecycle-test', firstWorkspacePort: 50300 });
let fixture: string;
let project: Project;
let workspace: Workspace;

const setupStep = async () => (await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup');

beforeAll(async () => {
  fixture = makeFixtureRepo();
  fs.writeFileSync(path.join(fixture, 'lonca.json'), JSON.stringify({ scripts: { setup: 'echo repo >> .context/setup-runs' } }));
  git(fixture, 'add', '.');
  git(fixture, 'commit', '--quiet', '-m', 'Add repository setup');
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
    expect(await lonca.api('GET', `/workspaces/${workspace.id}/scripts`)).toEqual({ setup: true, run: false });
    expect(dockerExec(workspace.containerName, 'cat .context/setup-runs').output).toBe('repo');
    await lonca.kill();
    await lonca.start();
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    await until('setup rerun', async () => (await setupStep())?.status === 'done'
      && dockerExec(workspace.containerName, 'cat .context/setup-runs').output === 'repo\nrepo');
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
    expect(await lonca.api('GET', `/workspaces/${workspace.id}/scripts`)).toEqual({ setup: false, run: false });
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`)).rejects.toThrow(/400.*no setup script/);
  });
});

it.skipIf(IN_SANDBOX)('waits for the firewall when Docker has already started the container', async () => {
  let reachedHost = false;
  const target = http.createServer((_req, res) => { reachedHost = true; res.end('host-reached'); });
  await new Promise<void>((resolve) => target.listen(0, '0.0.0.0', resolve));
  const port = (target.address() as { port: number }).port;
  let terminal: Awaited<ReturnType<Lonca['openTerminal']>> | undefined;
  try {
    // Slow the entrypoint's DNS lookup to hold open the real firewall startup window.
    docker('exec', workspace.containerName, 'bash', '-c', 'printf \'#!/bin/bash\nsleep 3\nexec /usr/bin/getent "$@"\n\' > /usr/local/bin/getent; chmod +x /usr/local/bin/getent');
    docker('stop', '-t', '1', workspace.containerName);
    docker('start', workspace.containerName);
    expect(dockerExec(workspace.containerName, 'test -e /run/lonca/ready').code).toBe(1);
    const created = await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
    expect(dockerExec(workspace.containerName, 'test -e /run/lonca/ready').code).toBe(0);
    terminal = await lonca.openTerminal(created.id);
    terminal.send(`curl -s --max-time 2 http://host.docker.internal:${port}/; printf '\\nprobe-finished\\n'\n`);
    await until('host access probe', () => terminal!.output().includes('probe-finished\r\n'));
    expect(reachedHost).toBe(false);
  } finally {
    terminal?.socket.close();
    docker('exec', workspace.containerName, 'rm', '-f', '/usr/local/bin/getent');
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

it('restores its saved branch after the original local checkout moves', async () => {
  // Preserve a workspace-only commit to prove restoration uses the saved branch.
  expect(dockerExec(workspace.containerName, "echo saved > saved.txt; git add saved.txt; git -c user.name=Test -c user.email=test@example.com commit --quiet -m saved").code).toBe(0);
  const commit = dockerExec(workspace.containerName, 'git rev-parse HEAD').output;
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { filesToCopy: ['.env*'] } });
  await lonca.api('POST', `/workspaces/${workspace.id}/archive`);
  fs.renameSync(fixture, `${fixture}-moved`);
  try {
    await lonca.api('POST', `/workspaces/${workspace.id}/restore`);
    workspace = await lonca.waitForWorkspace(workspace.id);
    expect(dockerExec(workspace.containerName, 'git rev-parse HEAD').output).toBe(commit);
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
    // Hold the managed Git operation so the next request definitely overlaps teardown.
    // Managed deletion bypasses repository hooks, which must not be able to veto cleanup.
    asRoot(removing.containerName, `cat > /usr/local/bin/git <<'GIT'
#!/bin/bash
if [[ " $* " == *" branch -D "* ]]; then
  touch /tmp/removal-waiting
  for i in $(seq 1 300); do
    [ -e /tmp/release-removal ] && break
    sleep 0.1
  done
fi
exec /usr/bin/git "$@"
GIT
chmod +x /usr/local/bin/git`);
    deleting = lonca.api('DELETE', `/projects/${project.id}`);
    await until('project teardown hook', () => dockerExec(removing!.containerName, 'test -e /tmp/removal-waiting').code === 0);
    const creating = fetch(`${lonca.url}/api/projects/${project.id}/workspaces`, {
      method: 'POST', headers: { ...lonca.headers, 'content-type': 'application/json' }, body: '{}',
    });
    await sleep(200);
    expect(dockerExec(removing.containerName, 'touch /tmp/release-removal').code).toBe(0);
    await deleting;
    expect((await creating).status).toBe(404);
    const state = await lonca.api<AppState>('GET', '/state');
    expect(state.projects.some((entry) => entry.id === project.id)).toBe(false);
    expect(state.workspaces.some((entry) => entry.projectId === project.id)).toBe(false);
    expect(state.sessions.some((entry) => entry.workspaceId === removing!.id)).toBe(false);
  } finally {
    if (removing) dockerExec(removing.containerName, 'touch /tmp/release-removal');
    await deleting?.catch(() => {});
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
