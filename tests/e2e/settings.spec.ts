import { expect, test } from '@playwright/test';
import type { AppState, SystemStatus } from '../../shared/types.ts';
import { Lonca } from '../support/harness.ts';

const lonca = new Lonca({ port: 48303, instance: 'e2e-settings', firstWorkspacePort: 51200 });

test.beforeAll(async () => { await lonca.start(); });
test.afterAll(async () => { await lonca.destroy(); });

test('preserves another field being edited when an earlier save arrives', async ({ page }) => {
  let received!: () => void;
  let release!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const responseReleased = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/settings', async (route) => {
    received();
    await responseReleased;
    await route.continue();
  }, { times: 1 });
  try {
    await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
    const name = page.getByRole('textbox', { name: 'Commit author name' });
    const email = page.getByRole('textbox', { name: 'Commit author email' });
    await name.fill('Saved author name');
    await email.click();
    await requestReceived;
    await email.fill('new-draft@example.test');
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
    release();
    await saved;
    await expect.poll(async () => (await lonca.api<AppState>('GET', '/state')).settings.gitName).toBe('Saved author name');
    await expect(email).toHaveValue('new-draft@example.test');
    await page.getByRole('textbox', { name: 'Branch prefix' }).click();
    await expect.poll(async () => (await lonca.api<AppState>('GET', '/state')).settings.gitEmail).toBe('new-draft@example.test');
  } finally {
    release();
  }
});

test('preserves a newer edit to the same field while its previous value is saving', async ({ page }) => {
  let received!: () => void;
  let release!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const responseReleased = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/settings', async (route) => {
    received();
    await responseReleased;
    await route.continue();
  }, { times: 1 });
  try {
    await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
    const name = page.getByRole('textbox', { name: 'Commit author name' });
    await name.fill('Name being saved');
    await page.getByRole('textbox', { name: 'Commit author email' }).click();
    await requestReceived;
    await name.fill('Newer name draft');
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
    release();
    await saved;
    await expect.poll(async () => (await lonca.api<AppState>('GET', '/state')).settings.gitName).toBe('Name being saved');
    await expect(name).toHaveValue('Newer name draft');
    await page.getByRole('textbox', { name: 'Branch prefix' }).click();
    await expect.poll(async () => (await lonca.api<AppState>('GET', '/state')).settings.gitName).toBe('Newer name draft');
  } finally {
    release();
  }
});

test('keeps the latest value when a second save overlaps a delayed first save', async ({ page }) => {
  let received!: () => void;
  let release!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const responseReleased = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/settings', async (route) => {
    received();
    await responseReleased;
    await route.continue();
  }, { times: 1 });
  try {
    await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
    const name = page.getByRole('textbox', { name: 'Commit author name' });
    await name.fill('Older delayed save');
    await page.getByRole('textbox', { name: 'Commit author email' }).click();
    await requestReceived;
    await name.fill('Latest saved name');
    await page.getByRole('textbox', { name: 'Branch prefix' }).click();
    // Let a concurrent second request complete first, if the UI allows one through.
    await page.waitForTimeout(200);
    const olderSaved = page.waitForResponse((response) => response.url().endsWith('/api/settings')
      && response.request().postDataJSON()?.gitName === 'Older delayed save');
    release();
    await olderSaved;
    await expect.poll(async () => (await lonca.api<AppState>('GET', '/state')).settings.gitName).toBe('Latest saved name');
    await page.reload();
    await expect(name).toHaveValue('Latest saved name');
  } finally {
    release();
  }
});

test('warns in the sidebar and in Settings while the disk is nearly full', async ({ page }) => {
  // The server only says so with less than 20 GB free, so this adds it to everything the page hears.
  const nearlyFull = (system: SystemStatus): SystemStatus => ({ ...system, lowDisk: { freeGb: 7 } });
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json() as AppState;
    await route.fulfill({ response, json: { ...state, system: nearlyFull(state.system) } });
  });
  await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as { type: string; system?: SystemStatus };
      socket.send(JSON.stringify(event.type === 'system' && event.system ? { ...event, system: nearlyFull(event.system) } : event));
    });
  });
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  await expect(page.getByRole('link', { name: 'Disk almost full' })).toBeVisible();
  await expect(page.getByText(/^Only 7 GB is left on this computer’s disk\./)).toBeVisible();
});

