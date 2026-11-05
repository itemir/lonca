import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Project, Workspace } from '../../shared/types.ts';
import { IN_SANDBOX, Lonca, docker, dockerExec, git, makeFixtureRepo, runtimeRunning, until } from '../support/harness.ts';

const lonca = new Lonca({ port: IN_SANDBOX ? 48319 : 48309, instance: `operation-recovery-${IN_SANDBOX ? 'sandbox' : 'container'}`, firstWorkspacePort: IN_SANDBOX ? 52600 : 51600 });
let fixture: string;
let project: Project;

beforeAll(async () => {
  fixture = makeFixtureRepo();
  fs.writeFileSync(path.join(fixture, 'config'), 'a tracked file that blocks copying a nested secret');
  git(fixture, 'add', 'config');
  git(fixture, 'commit', '--quiet', '-m', 'Add a copy conflict');
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { filesToCopy: ['.env'] } });
  fs.rmSync(path.join(fixture, 'config'));
  fs.mkdirSync(path.join(fixture, 'config'));
  fs.writeFileSync(path.join(fixture, 'config', 'secret'), 'copy after retry');
});

afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

async function create(): Promise<Workspace> {
  const { workspace } = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  return lonca.waitForWorkspace(workspace.id);
}

async function retry(workspace: Workspace, operation: 'archive' | 'delete' | 'stop'): Promise<void> {
  await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
  if (operation === 'delete') {
    await until('workspace removal', async () => !await lonca.workspace(workspace.id));
    expect(fs.existsSync(workspace.path)).toBe(false);
  } else {
    await lonca.waitForWorkspace(workspace.id, operation === 'stop' ? 'stopped' : 'archived');
    expect(runtimeRunning(workspace.containerName)).toBe(operation === 'stop' ? false : null);
  }
}

it.skipIf(IN_SANDBOX).each(['archive', 'delete', 'stop'] as const)('retries %s after Docker failed before cleanup', async (operation) => {
  const workspace = await create();
  const edited = 'SECRET=keep-until-requested-cleanup\n';
  fs.writeFileSync(path.join(workspace.path, '.env'), edited);
  await lonca.kill();
  lonca.env.DOCKER_HOST = 'tcp://127.0.0.1:9';
  await lonca.start();
  try {
    await expect(operation === 'delete'
      ? lonca.api('DELETE', `/workspaces/${workspace.id}`)
      : lonca.api('POST', `/workspaces/${workspace.id}/${operation}`)).rejects.toThrow();
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: operation });
    expect(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8')).toBe(edited);
  } finally {
    await lonca.kill();
    delete lonca.env.DOCKER_HOST;
    await lonca.start();
  }
  expect((await lonca.workspace(workspace.id)).pendingOperation).toBe(operation);
  await retry(workspace, operation);
  if (operation === 'stop') expect(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8')).toBe(edited);
  if (operation === 'archive') {
    await lonca.api('POST', `/workspaces/${workspace.id}/restore`);
    await lonca.waitForWorkspace(workspace.id);
  }
  if (operation !== 'delete') await lonca.api('DELETE', `/workspaces/${workspace.id}`);
});

it.skipIf(IN_SANDBOX).each(['archive', 'delete'] as const)('reports partial %s cleanup failures and retries the same cleanup', async (operation) => {
  const workspace = await create();
  // Fail after deleting checkout files, before pruning worktree metadata or deleting the branch.
  docker('exec', workspace.containerName, 'bash', '-c', `cat > /usr/local/bin/git <<'GIT'
#!/bin/bash
if [ "$3 $4" = 'worktree prune' ] && [ ! -e /tmp/prune-failed ]; then
  touch /tmp/prune-failed
  echo 'Injected prune failure' >&2
  exit 42
fi
exec /usr/bin/git "$@"
GIT
chmod +x /usr/local/bin/git`);
  await expect(operation === 'delete'
    ? lonca.api('DELETE', `/workspaces/${workspace.id}`)
    : lonca.api('POST', `/workspaces/${workspace.id}/archive`)).rejects.toThrow(/Injected prune failure/);
  expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: operation });
  expect(fs.readdirSync(workspace.path)).toEqual([]);
  expect(runtimeRunning(workspace.containerName)).toBe(false);
  await lonca.kill();
  await lonca.start();
  await retry(workspace, operation);
  if (operation === 'archive') {
    await lonca.api('POST', `/workspaces/${workspace.id}/restore`);
    await lonca.waitForWorkspace(workspace.id);
    expect(fs.existsSync(path.join(workspace.path, 'README.md'))).toBe(true);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  }
});

it.skipIf(IN_SANDBOX).each(['archive', 'delete'] as const)('retains %s intent when the server crashes during cleanup', async (operation) => {
  const workspace = await create();
  docker('exec', workspace.containerName, 'bash', '-c', `cat > /usr/local/bin/git <<'GIT'
#!/bin/bash
if [ "$3 $4" = 'worktree prune' ]; then
  touch /tmp/prune-waiting
  for i in $(seq 1 300); do
    [ -e /tmp/prune-release ] && break
    sleep 0.1
  done
fi
exec /usr/bin/git "$@"
GIT
chmod +x /usr/local/bin/git`);
  const pending = (operation === 'delete'
    ? lonca.api('DELETE', `/workspaces/${workspace.id}`)
    : lonca.api('POST', `/workspaces/${workspace.id}/archive`)).catch(() => {});
  await until('partial cleanup', () => dockerExec(workspace.containerName, 'test -e /tmp/prune-waiting').code === 0);
  await lonca.kill();
  await pending;
  expect(dockerExec(workspace.containerName, 'touch /tmp/prune-release').code).toBe(0);
  await lonca.start();
  expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: operation });
  await retry(workspace, operation);
  if (operation === 'archive') await lonca.api('DELETE', `/workspaces/${workspace.id}`);
});

it.each(['create', 'restore'] as const)('resumes partial file copying during %s without overwriting completed files', async (operation) => {
  let workspace: Workspace;
  if (operation === 'restore') {
    workspace = await create();
    await lonca.api('POST', `/workspaces/${workspace.id}/archive`);
  }
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { filesToCopy: ['.env', 'config/secret'] } });
  try {
    if (operation === 'create') workspace = (await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace;
    else await lonca.api('POST', `/workspaces/${workspace!.id}/restore`);
    workspace = await lonca.waitForWorkspace(workspace!.id, 'error');
    expect(workspace.pendingOperation).toBe(operation);
    const edited = 'SECRET=edited-after-copy-failure\n';
    fs.writeFileSync(path.join(workspace.path, '.env'), edited);
    expect(dockerExec(workspace.containerName, 'rm config && mkdir config').code).toBe(0);
    await lonca.kill();
    await lonca.start();
    await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
    await lonca.waitForWorkspace(workspace.id);
    expect(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8')).toBe(edited);
    expect(fs.readFileSync(path.join(workspace.path, 'config', 'secret'), 'utf8')).toBe('copy after retry');
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  } finally {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { filesToCopy: ['.env'] } });
  }
});

it.each(['archive', 'delete', 'stop'] as const)('can finish %s even when a lost terminal has a damaged PID record', async (operation) => {
  const workspace = await create();
  expect(dockerExec(workspace.containerName, `echo damaged > /var/tmp/lonca/tty/${workspace.id}-setup.pid`).code).toBe(0);
  if (operation === 'delete') await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  else await lonca.api('POST', `/workspaces/${workspace.id}/${operation}`);
  if (operation === 'delete') expect(await lonca.workspace(workspace.id)).toBeUndefined();
  else {
    expect((await lonca.workspace(workspace.id)).status).toBe(operation === 'stop' ? 'stopped' : 'archived');
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  }
});

it.each(['archive', 'delete'] as const)('can %s a workspace while something an agent left running keeps writing to it', async (operation) => {
  const workspace = await create();
  dockerExec(workspace.containerName, `cd ${workspace.path} && mkdir -p cache && (setsid nohup bash -c 'while :; do : > "cache/$RANDOM$RANDOM"; done' >/dev/null 2>&1 &)`);
  await until('the writer', () => fs.readdirSync(path.join(workspace.path, 'cache')).length > 20, 10000);
  if (operation === 'delete') {
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    expect(await lonca.workspace(workspace.id)).toBeUndefined();
  } else {
    await lonca.api('POST', `/workspaces/${workspace.id}/archive`);
    expect((await lonca.workspace(workspace.id)).status).toBe('archived');
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  }
  expect(fs.existsSync(workspace.path)).toBe(false);
});

it('can delete a workspace whose connected terminal’s PID record became a FIFO', async () => {
  const workspace = await create();
  const shell = await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
  expect(dockerExec(workspace.containerName, `f=/var/tmp/lonca/tty/${shell.id}.pid; rm -f "$f" && mkfifo "$f"`).code).toBe(0);
  await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  expect(await lonca.workspace(workspace.id)).toBeUndefined();
});
