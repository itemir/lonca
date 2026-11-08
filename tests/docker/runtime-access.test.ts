import fs from 'node:fs';
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AppState, Session, UserItem, Workspace } from '../../shared/types.ts';
import { RUNTIME, Lonca, makeFixtureRepo, removeSandbox, sandboxRunning, sbx, sleep, until, REAL_SANDBOX } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 48367, instance: `runtime-access-${RUNTIME}`, firstWorkspacePort: 58300});
let fixture: string;
let workspace: Workspace;
let mock: MockLlm;

beforeAll(async () => {
  fixture = makeFixtureRepo();
  mock = await startMockLlm();
  await lonca.start();
  await until('initial server checks', async () => (await lonca.api<AppState>('GET', '/state')).system.agentsChecked);
  const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-ant-api03-runtime-access-not-a-real-key' } },
  });
  await lonca.api('PUT', '/profiles/claude/key', { key: 'sk-ant-api03-runtime-access-not-a-real-key' });
  workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
  await sleep(1000); // Let optional setup discovery finish before an external stop.
});
beforeEach(async () => {
  await lonca.api('POST', `/workspaces/${workspace.id}/start`);
  await lonca.waitForWorkspace(workspace.id);
});
afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

function stopRuntime(): void {
  sbx('stop', workspace.sandboxName);
}

const passive = [
  ['GET', '/files?path=.'], ['GET', '/file?path=src%2Findex.js'],
  ['GET', '/search?q=hello&mode=content'], ['GET', '/changes'],
  ['GET', '/diff?path=src%2Findex.js&untracked=0'], ['GET', '/scripts'],
  ['POST', '/terminals'], ['POST', '/scripts/setup'], ['POST', '/attachments?name=test.txt'],
] as const;

it.each(passive)('does not wake an externally stopped runtime for %s %s', async (method, route) => {
  stopRuntime();
  expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'ready' });
  await expect(lonca.api(method, `/workspaces/${workspace.id}${route}`)).rejects.toThrow(/409.*stopped/);
  expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'stopped' });
});

it('does not wake an externally stopped runtime to run a configured setup script', async () => {
  await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { setupScript: 'true' } });
  try {
    stopRuntime();
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`)).rejects.toThrow(/409.*stopped/);
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'stopped' });
  } finally {
    await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { setupScript: '' } });
  }
});

it('does not recreate a removed runtime for a read, but explicit Start recreates it', async () => {
  removeSandbox(workspace.sandboxName);
  await expect(lonca.api('GET', `/workspaces/${workspace.id}/files`)).rejects.toThrow(/409.*stopped/);
  expect(sandboxRunning(workspace.sandboxName)).toBeNull();
  await lonca.api('POST', `/workspaces/${workspace.id}/start`);
  expect(sandboxRunning(workspace.sandboxName)).toBe(true);
  expect(await lonca.api('GET', `/workspaces/${workspace.id}/files`)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'src' })]));
});

it.each([false, true])('wakes for a submitted message after an external stop (already observed: %s)', async (observed) => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  stopRuntime();
  if (observed) await expect(lonca.api('GET', `/workspaces/${workspace.id}/changes`)).rejects.toThrow(/409/);
  const message = await lonca.api<UserItem>('POST', `/sessions/${session.id}/messages`, { text: 'Wake for this message' });
  const items = await lonca.waitForIdle(session.id);
  expect(items.filter((item) => item.id === message.id)).toHaveLength(1);
  expect(items.some((item) => item.type === 'text' && item.text.includes(message.text))).toBe(true);
  expect(items.findLast((item) => item.type === 'result')).toMatchObject({ failed: false });
  expect(sandboxRunning(workspace.sandboxName)).toBe(true);
});

it('keeps a message queued through a failed wake and starts it once with Send now', async () => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  stopRuntime();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(workspace.port, '127.0.0.1', resolve);
  });
  let message!: UserItem;
  try {
    message = await lonca.api<UserItem>('POST', `/sessions/${session.id}/messages`, { text: 'Keep this through the occupied port' });
    expect(message.queued).toBe(true);
    expect((await lonca.items(session.id)).find((item) => item.id === message.id)).toMatchObject({ queued: true });
    expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, queue: [message.id] });
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'stopped', pendingOperation: 'start' });
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
  await lonca.api('POST', `/sessions/${session.id}/queue/flush`);
  const items = await lonca.waitForIdle(session.id);
  expect(items.filter((item) => item.id === message.id)).toHaveLength(1);
  expect(items.filter((item) => item.type === 'text' && item.text.includes(message.text))).toHaveLength(1);
});

it.skipIf(REAL_SANDBOX)('does not mark an unreachable runtime stopped or lose its controls', async () => {
  await lonca.kill();
  lonca.setOffline(true);
  await lonca.start();
  try {
    await expect(lonca.api('GET', `/workspaces/${workspace.id}/files`)).rejects.toThrow();
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'ready' });
    expect(sandboxRunning(workspace.sandboxName)).toBe(true);
  } finally {
    await lonca.kill();
    lonca.setOffline(false);
    await lonca.start();
  }
});
