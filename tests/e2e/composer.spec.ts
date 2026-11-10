import fs from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Project, Session, Workspace } from '../../shared/types.ts';
import { Lonca, REPO_ROOT, makeFixtureRepo, removeSandbox } from '../support/harness.ts';
import { startMockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 47383, instance: 'e2e-composer', firstWorkspacePort: 46800 });
const SHOTS = path.join(REPO_ROOT, 'test-results', 'composer');
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
  const conversation = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  first = await lonca.api<Session>('PATCH', `/sessions/${conversation.id}`, { title: 'First conversation' });
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

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('shows a message written while Claude works waiting for its next step, then where it was read', async ({ page }) => {
  const mock = await startMockLlm();
  const settings = (await lonca.api<{ projects: Project[] }>('GET', '/state')).projects.find((entry) => entry.id === workspace.projectId)!.settings;
  await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { network: 'host', env: {
    ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock',
  } } });
  try {
    const conversation = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
    await lonca.api('PATCH', `/sessions/${conversation.id}`, { title: 'Working conversation' });
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('button', { name: 'Working conversation', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('RUN: python3 -c "import time; time.sleep(8)"');
    await composer.press('Enter');
    await expect(page.locator('.tool-running')).toBeVisible({ timeout: 60000 });
    await expect(composer).toHaveAttribute('placeholder', 'Write while it works. It reads this at its next step');
    await composer.fill('A correction while it works');
    await composer.press('Enter');
    const waiting = page.locator('.user-message.queued').filter({ hasText: 'A correction while it works' });
    await expect(waiting.getByText('It reads this at its next step')).toBeVisible();
    // It may be reading it already, so it can't be called back.
    await expect(waiting.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await shot(page, 'mid-turn-waiting');
    const read = page.locator('.user-message:not(.queued)').filter({ hasText: 'A correction while it works' });
    await expect(read).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.working-row')).toHaveCount(0, { timeout: 60000 });
    // Where the agent read it: after the command, before the reply it went into, in one turn.
    const rows = page.locator('.chat-column > *');
    const order = await rows.evaluateAll((elements) => elements.map((element) => element.className.split(' ')[0]));
    expect(order.slice(-4)).toEqual(['tool', 'user-message', 'assistant-text', 'result-row']);
    await expect(page.locator('.result-row')).toHaveCount(1);
    await shot(page, 'mid-turn-read');
  } finally {
    await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { network: settings.network, env: settings.env } });
    await mock.close();
  }
});

test('keeps an accepted message out of the draft when the workspace cannot start', async ({ page }) => {
  await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
  removeSandbox(workspace.sandboxName);
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
