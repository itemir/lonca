import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { Project, ServerEvent, Session, Workspace } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 48305, instance: 'e2e-hydration', firstWorkspacePort: 51400 });
let fixture: string;
let project: Project;
let workspace: Workspace;
let mock: MockLlm;

test.beforeAll(async () => {
  fixture = makeFixtureRepo();
  mock = await startMockLlm();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-ant-api03-hydration-not-a-real-key' } },
  });
  await lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-api03-hydration-not-a-real-key' });
  const made = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(made.workspace.id);
});

test.afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function delaySnapshot(page: Page, routePath = '/state') {
  const received = deferred();
  const released = deferred();
  const fulfilled = deferred();
  await page.route(`**/api${routePath}`, async (route) => {
    const response = await route.fetch();
    received.resolve();
    await released.promise;
    await route.fulfill({ response });
    fulfilled.resolve();
  }, { times: 1 });
  return { received: received.promise, release: released.resolve, fulfilled: fulfilled.promise };
}

async function observeConnections(page: Page, ready: () => Promise<void> = async () => {}) {
  const connections: { client: WebSocketRoute; server: WebSocketRoute; events: ServerEvent[] }[] = [];
  await page.routeWebSocket((url) => url.pathname === '/ws', async (client) => {
    await ready();
    const server = client.connectToServer();
    const events: ServerEvent[] = [];
    server.onMessage((message) => {
      events.push(JSON.parse(message.toString()));
      client.send(message);
    });
    connections.push({ client, server, events });
  });
  return connections;
}

/** A directory in place of the file fails every read, whichever user runs the tests. */
function makeUnreadable(file: string): () => void {
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  return () => {
    fs.rmdirSync(file);
    fs.renameSync(`${file}.saved`, file);
  };
}

const rename = (name: string) => lonca.api('PATCH', `/projects/${project.id}`, { name });
const projectButton = (page: Page, name: string) => page.getByRole('button', { name: `New workspace in ${name}`, exact: true });

test('keeps events received after the initial state snapshot was captured', async ({ page }) => {
  await rename('Initial snapshot');
  const connections = await observeConnections(page);
  const delayed = await delaySnapshot(page);
  try {
    await page.goto(`${lonca.url}/?token=${lonca.token}`);
    await delayed.received;
    await rename('Updated during hydration');
    await expect.poll(() => connections[0]?.events.some((event) => event.type === 'project' && event.project.name === 'Updated during hydration')).toBe(true);
    // Give the browser time to handle the event while its snapshot is still held back.
    await page.waitForTimeout(100);
    delayed.release();
    await expect(projectButton(page, 'Updated during hydration')).toBeVisible();
    await expect(projectButton(page, 'Initial snapshot')).toHaveCount(0);
  } finally {
    delayed.release();
  }
});

test('keeps events received while refreshing state after a reconnect', async ({ page }) => {
  await rename('Before reconnect');
  const connections = await observeConnections(page);
  await page.goto(`${lonca.url}/?token=${lonca.token}`);
  await expect(projectButton(page, 'Before reconnect')).toBeVisible();
  const checked = page.waitForResponse((response) => response.url().endsWith('/api/state'));
  await connections[0].client.close();
  await connections[0].server.close();
  await checked; // The disconnect's authentication probe precedes the next hydration.
  const delayed = await delaySnapshot(page);
  try {
    await delayed.received;
    await rename('Updated during reconnect');
    await expect.poll(() => connections[1]?.events.some((event) => event.type === 'project' && event.project.name === 'Updated during reconnect')).toBe(true);
    await page.waitForTimeout(100);
    delayed.release();
    await expect(projectButton(page, 'Updated during reconnect')).toBeVisible();
    await expect(projectButton(page, 'Before reconnect')).toHaveCount(0);
  } finally {
    delayed.release();
  }
});

test('ignores a delayed snapshot from a connection that has already closed', async ({ page }) => {
  await rename('Stale connection');
  const connections = await observeConnections(page);
  const delayed = await delaySnapshot(page);
  try {
    await page.goto(`${lonca.url}/?token=${lonca.token}`);
    await delayed.received;
    await connections[0].client.close();
    await connections[0].server.close();
    await rename('Replacement connection');
    await expect(projectButton(page, 'Replacement connection')).toBeVisible();
    delayed.release();
    await delayed.fulfilled;
    await page.waitForTimeout(100);
    await expect(projectButton(page, 'Replacement connection')).toBeVisible();
    await expect(projectButton(page, 'Stale connection')).toHaveCount(0);
  } finally {
    delayed.release();
  }
});

for (const initial of [true, false]) {
  test(`refreshes a pending ${initial ? 'initial' : 'reconnect'} transcript after losing its connection`, async ({ page }) => {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('PATCH', `/sessions/${session.id}`, { title: 'Pending transcript' });
    const connections = await observeConnections(page);
    const openConversation = async () => {
      await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
      await page.getByRole('button', { name: 'Pending transcript', exact: true }).click();
    };
    const disconnect = async () => {
      const connection = connections.at(-1)!;
      await connection.client.close();
      await connection.server.close();
    };
    if (!initial) {
      await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Message before reconnecting', attachments: [] });
      await lonca.waitForIdle(session.id);
      await openConversation();
      await expect(page.locator('.user-text').filter({ hasText: 'Message before reconnecting' })).toBeVisible();
    }
    const delayed = await delaySnapshot(page, `/sessions/${session.id}`);
    try {
      if (initial) await openConversation();
      else await disconnect();
      await delayed.received;
      await disconnect();
      const text = 'Message sent while the transcript connection was lost';
      await lonca.api('POST', `/sessions/${session.id}/messages`, { text, attachments: [] });
      // A fresh snapshot must load without waiting for the old request to return.
      const message = page.locator('.user-text').filter({ hasText: text });
      await expect(message).toBeVisible();
      delayed.release();
      await delayed.fulfilled;
      await page.waitForTimeout(100);
      await expect(message).toBeVisible();
      await lonca.waitForIdle(session.id);
    } finally {
      delayed.release();
      await lonca.api('DELETE', `/sessions/${session.id}`);
    }
  });
}

test('says when it can’t read a conversation, and recovers by itself once it can', async ({ page }) => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  await lonca.api('PATCH', `/sessions/${session.id}`, { title: 'Unreadable history' });
  await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Message before the failure', attachments: [] });
  await lonca.waitForIdle(session.id);
  const file = path.join(lonca.home, 'sessions', `${session.id}.jsonl`);
  const problem = page.getByRole('alert').filter({ hasText: 'can’t read this conversation' });
  const message = (text: string) => page.locator('.user-text').filter({ hasText: text });
  await lonca.stop();
  const restore = makeUnreadable(file);
  try {
    await lonca.start();
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('button', { name: 'Unreadable history', exact: true }).click();
    await expect(problem).toBeVisible();
    await expect(message('Message before the failure')).toHaveCount(0);
  } finally {
    restore();
  }
  // With no reload, and carrying on with new messages.
  await expect(message('Message before the failure')).toBeVisible();
  await expect(problem).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Message after recovering');
  await composer.press('Enter');
  await expect(message('Message after recovering')).toBeVisible();
  await expect(page.getByText(/You said: Message after recovering/)).toBeVisible({ timeout: 60000 });
  await lonca.waitForIdle(session.id);
  await lonca.api('DELETE', `/sessions/${session.id}`);
});

test('says when it can’t refresh a conversation on reconnecting, and catches up by itself once it can', async ({ page }) => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  await lonca.api('PATCH', `/sessions/${session.id}`, { title: 'Refresh fails' });
  await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Seen before the outage', attachments: [] });
  await lonca.waitForIdle(session.id);
  const problem = page.getByRole('alert').filter({ hasText: 'can’t read this conversation' });
  const message = (text: string) => page.locator('.user-text').filter({ hasText: text });
  let reconnect = Promise.resolve();
  const connections = await observeConnections(page, () => reconnect);
  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  await page.getByRole('button', { name: 'Refresh fails', exact: true }).click();
  await expect(message('Seen before the outage')).toBeVisible();

  // The page is disconnected for a whole turn, then the server restarts unable to read it.
  const outage = deferred();
  reconnect = outage.promise;
  const connection = connections.at(-1)!;
  await connection.client.close();
  await connection.server.close();
  await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Missed during the outage', attachments: [] });
  await lonca.waitForIdle(session.id);
  await lonca.stop();
  const restore = makeUnreadable(path.join(lonca.home, 'sessions', `${session.id}.jsonl`));
  try {
    await lonca.start();
    outage.resolve();
    await expect(problem).toBeVisible();
    await expect(message('Seen before the outage')).toBeVisible();
    await expect(message('Missed during the outage')).toHaveCount(0);
  } finally {
    outage.resolve();
    restore();
  }
  await expect(message('Missed during the outage')).toBeVisible();
  await expect(problem).toHaveCount(0);
  await lonca.api('DELETE', `/sessions/${session.id}`);
});
