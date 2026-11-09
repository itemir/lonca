import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Project, Workspace } from '../../shared/types.ts';
import { Lonca, sandboxExec, git, makeFixtureRepo, sandboxRunning, until, REAL_SANDBOX } from '../support/harness.ts';

const lonca = new Lonca({ port: 48319, instance: `operation-recovery-sandbox`, firstWorkspacePort: 52600});
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
    expect(sandboxRunning(workspace.sandboxName)).toBe(operation === 'stop' ? false : null);
  }
}

it.skipIf(REAL_SANDBOX).each(['archive', 'delete', 'stop'] as const)('retries %s after Docker Sandboxes failed before cleanup', async (operation) => {
  const workspace = await create();
  const edited = 'SECRET=keep-until-requested-cleanup\n';
  fs.writeFileSync(path.join(workspace.path, '.env'), edited);
  await lonca.kill();
  lonca.setOffline(true);
  await lonca.start();
  try {
    await expect(operation === 'delete'
      ? lonca.api('DELETE', `/workspaces/${workspace.id}`)
      : lonca.api('POST', `/workspaces/${workspace.id}/${operation}`)).rejects.toThrow();
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: operation });
    expect(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8')).toBe(edited);
  } finally {
    await lonca.kill();
    lonca.setOffline(false);
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

it.skipIf(REAL_SANDBOX)('deletes an archived workspace while Docker Sandboxes can’t be reached', async () => {
  const workspace = await create();
  await lonca.api('POST', `/workspaces/${workspace.id}/archive`);
  expect(fs.readdirSync(workspace.path)).toEqual(['.git']);
  await lonca.kill();
  lonca.setOffline(true);
  await lonca.start();
  try {
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    expect(await lonca.workspace(workspace.id)).toBeUndefined();
    expect(fs.existsSync(workspace.path)).toBe(false);
  } finally {
    await lonca.kill();
    lonca.setOffline(false);
    await lonca.start();
  }
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
    expect(sandboxExec(workspace.sandboxName, 'rm config && mkdir config').code).toBe(0);
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
  expect(sandboxExec(workspace.sandboxName, `echo damaged > /var/tmp/lonca/tty/${workspace.id}-setup.pid`).code).toBe(0);
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
  sandboxExec(workspace.sandboxName, `cd ${workspace.path} && mkdir -p cache && (setsid nohup bash -c 'while :; do : > "cache/$RANDOM$RANDOM"; done' >/dev/null 2>&1 &)`);
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
  expect(sandboxExec(workspace.sandboxName, `f=/var/tmp/lonca/tty/${shell.id}.pid; rm -f "$f" && mkfifo "$f"`).code).toBe(0);
  await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  expect(await lonca.workspace(workspace.id)).toBeUndefined();
});
