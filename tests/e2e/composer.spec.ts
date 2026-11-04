import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Project, Session, Workspace } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, removeRuntime } from '../support/harness.ts';

const lonca = new Lonca({ port: 47383, instance: 'e2e-composer', firstWorkspacePort: 46800 });
let fixture: string;
let workspace: Workspace;
let first: Session;

test.beforeAll(async () => {
  fixture = makeFixtureRepo();
  await lonca.start();
  const project = await lonca.api<Project>('POST', '/projects', { path: fixture });
  await lonca.waitForProject(project.id);
  const made = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(made.workspace.id);
  first = await lonca.api<Session>('PATCH', `/sessions/${made.session.id}`, { title: 'First conversation' });
  const second = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  await lonca.api('PATCH', `/sessions/${second.id}`, { title: 'Second conversation' });
});

test.afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('keeps a failed send with its original conversation', async ({ page }) => {
  let received!: () => void;
  let release!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const responseReleased = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/sessions/${first.id}/messages`, async (route) => {
    received();
    await responseReleased;
    await route.fulfill({ status: 503, json: { error: 'Simulated server disconnect' } });
  });
  try {
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('button', { name: 'First conversation', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('The message for the first conversation');
    await composer.press('Enter');
    await requestReceived;

    await page.getByRole('button', { name: 'Second conversation', exact: true }).click();
    await composer.fill('The draft for the second conversation');
    release();
    await expect(page.getByText('Simulated server disconnect', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('The draft for the second conversation');

    await page.getByRole('button', { name: 'First conversation', exact: true }).click();
    await expect(composer).toHaveValue('The message for the first conversation');
  } finally {
    release();
  }
});

test('recovers a failed send alongside a newer draft and attachments after returning to the conversation', async ({ page }) => {
  let received!: () => void;
  let release!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const responseReleased = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/sessions/${first.id}/messages`, async (route) => {
    received();
    await responseReleased;
    await route.fulfill({ status: 503, json: { error: 'Simulated delayed send failure' } });
  });
  try {
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('button', { name: 'First conversation', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    const upload = (name: string) => page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
    await upload('first.txt');
    await expect(page.getByRole('button', { name: 'Remove first.txt', exact: true })).toBeVisible();
    await composer.fill('The message whose send fails');
    await composer.press('Enter');
    await requestReceived;

    await composer.fill('A new draft while waiting');
    await upload('second.txt');
    await expect(page.getByRole('button', { name: 'Remove second.txt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Second conversation', exact: true }).click();
    await page.getByRole('button', { name: 'First conversation', exact: true }).click();
    await expect(composer).toHaveValue('A new draft while waiting');
    await expect(page.getByRole('button', { name: 'Remove second.txt', exact: true })).toBeVisible();
    release();
    await expect(page.getByText('Simulated delayed send failure', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('The message whose send fails\n\nA new draft while waiting');
    await expect(page.getByRole('button', { name: 'Remove first.txt', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove second.txt', exact: true })).toBeVisible();
  } finally {
    release();
  }
});

test('keeps an accepted message out of the draft when the workspace cannot start', async ({ page }) => {
  await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
  removeRuntime(workspace.containerName);
  await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { image: 'lonca-missing-composer-test:never-built' } });
  try {
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('button', { name: 'First conversation', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    const text = 'Accepted while the workspace cannot start';
    await composer.fill(text);
    await composer.press('Enter');
    await expect(page.getByText(/Your message is queued, but the workspace could not start/)).toBeVisible();
    await expect(composer).toHaveValue('');
    await expect(page.locator('.user-text').filter({ hasText: text })).toHaveCount(1);
    const session = await lonca.session(first.id);
    expect(session.queue).toHaveLength(1);
    await lonca.api('DELETE', `/sessions/${first.id}/queue/${session.queue[0]}`);
  } finally {
    await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { image: '' } });
    await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    workspace = await lonca.waitForWorkspace(workspace.id);
  }
});
