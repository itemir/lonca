import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';
import { FAKE_SBX, Lonca, REPO_ROOT, until } from '../support/harness.ts';

// Signing Docker Sandboxes in and out from Settings, with tests/support/fake-sbx standing in for
// `sbx login` and `sbx logout`. The server has a stand-in of its own, so that being signed out
// doesn't reach other tests' servers.
const sbxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-fake-sbx-signin-'));
const lonca = new Lonca({ port: 48377, instance: 'e2e-docker-signin', firstWorkspacePort: 59200 });
lonca.env = { LONCA_SBX: FAKE_SBX, FAKE_SBX_DIR: sbxDir };
const SHOTS = path.join(REPO_ROOT, 'test-results', 'shots');
const signedOut = path.join(sbxDir, 'signed-out');
const calls = () => fs.readFileSync(path.join(sbxDir, 'calls.log'), 'utf8').split('\n');
const dockerLogin = async () => (await lonca.api<AppState>('GET', '/state')).system.dockerLogin;
const loginRunning = () => spawnSync('pgrep', ['-f', `${FAKE_SBX} login`]).status === 0;

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // Starting signed out also keeps the server from building a template it doesn't need here.
  fs.writeFileSync(signedOut, '');
  await lonca.start();
});
test.afterAll(async () => {
  // destroy() asks the stand-in for this server's sandboxes, which it won't list while signed out.
  fs.rmSync(signedOut, { force: true });
  await lonca.destroy();
  fs.rmSync(sbxDir, { recursive: true, force: true });
});

const row = (page: Page) => page.locator('.settings-block').filter({ hasText: 'Virtual machines' }).first();

test('signs Docker Sandboxes in from Settings, and can be cancelled or fail', async ({ page }) => {
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  await expect(row(page)).toContainText('isn’t signed in', { timeout: 30000 });
  const banner = page.locator('.banner-error');
  await expect(banner).toContainText('isn’t signed in');
  await expect(banner).not.toContainText('sbx login');
  await expect(banner.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');

  // Cancelling stops sbx.
  await row(page).getByRole('button', { name: 'Sign in to Docker' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to Docker' });
  await expect(dialog.locator('.login-code')).toHaveText('VKNZ-LBTN');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(dockerLogin).toBeUndefined();
  await until('sbx login to stop', () => !loginRunning(), 10000);

  // A sign-in the page refuses says what sbx said, and can be tried again.
  await row(page).getByRole('button', { name: 'Sign in to Docker' }).click();
  await expect(dialog.locator('.login-code')).toHaveText('VKNZ-LBTN');
  fs.writeFileSync(path.join(sbxDir, 'login-deny'), '');
  await expect(dialog.getByRole('alert')).toContainText('Docker Sandboxes didn’t sign in: Auth login failed: completing login: access denied');
  await expect(dialog.locator('.login-log')).toContainText('Waiting for authentication...');
  await dialog.getByRole('button', { name: 'Hide what sbx printed' }).click();
  await expect(dialog.locator('.login-log')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Show what sbx printed' }).click();
  await expect(dialog.locator('.login-log')).toBeVisible();
  await dialog.getByRole('button', { name: 'Try again' }).click();

  // Then it goes through.
  await expect(dialog.locator('.login-code')).toHaveText('VKNZ-LBTN');
  const open = dialog.getByRole('link', { name: 'Open sign-in page' });
  await expect(open).toHaveAttribute('href', 'https://login.docker.com/activate?user_code=VKNZ-LBTN');
  await expect(dialog).toContainText('Only approve it on login.docker.com');
  await page.screenshot({ path: path.join(SHOTS, 'docker-signin.png') });
  fs.writeFileSync(path.join(sbxDir, 'login-approve'), '');
  await expect(dialog).toHaveCount(0, { timeout: 15000 });
  await expect(row(page)).toContainText('Each new workspace gets its own virtual machine');
  await expect(banner).toHaveCount(0);
  expect(fs.existsSync(signedOut)).toBe(false);
  expect(calls().filter((line) => line === 'login')).toHaveLength(3);
  expect((await dockerLogin())?.phase).toBe('done');
});

test('warns before signing Docker Sandboxes out, then does', async ({ page }) => {
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  await expect(row(page)).toContainText('Each new workspace gets its own virtual machine', { timeout: 30000 });

  // Nothing happens until it's confirmed.
  await row(page).getByRole('button', { name: 'Sign out of Docker' }).click();
  const confirm = page.getByRole('dialog', { name: 'Sign out of Docker?' });
  await expect(confirm).toContainText('signs Docker Sandboxes out on this whole computer');
  await expect(confirm).toContainText('sbx in your terminal is signed out too');
  await expect(confirm).toContainText('stops every sandbox running on this computer');
  await expect(confirm).toContainText('all of Lonca’s workspaces, any agents working in them, and sandboxes that aren’t Lonca’s');
  await page.screenshot({ path: path.join(SHOTS, 'docker-signout-confirm.png') });
  // Enter, by habit, doesn't do it.
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  expect(calls()).not.toContain('logout');

  await row(page).getByRole('button', { name: 'Sign out of Docker' }).click();
  await confirm.getByRole('button', { name: 'Sign out of Docker' }).click();
  await expect(row(page)).toContainText('isn’t signed in', { timeout: 30000 });
  await expect(row(page).getByRole('button', { name: 'Sign in to Docker' })).toBeVisible();
  expect(calls()).toContain('logout');
  expect(fs.existsSync(signedOut)).toBe(true);
});

test('ends a sign-in waiting in Lonca once sbx is signed in from a terminal', async ({ page }) => {
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  await row(page).getByRole('button', { name: 'Sign in to Docker' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to Docker' });
  await expect(dialog.locator('.login-code')).toHaveText('VKNZ-LBTN');
  expect(loginRunning()).toBe(true);

  // As `sbx login` in a terminal would.
  fs.rmSync(signedOut);
  await expect(dialog).toHaveCount(0, { timeout: 15000 });
  await expect.poll(async () => (await dockerLogin())?.phase, { timeout: 15000 }).toBe('done');
  await until('Lonca’s sbx login to stop', () => !loginRunning(), 10000);
  await page.reload();
  await expect(row(page)).toContainText('Each new workspace gets its own virtual machine');
  await expect(dialog).toHaveCount(0);
});

test('leaves a sign-in alone when Lonca is started a second time and can’t get its port', async () => {
  fs.writeFileSync(signedOut, '');
  await until('it to be signed out', async () => (await lonca.api('POST', '/sandboxes/check')).state === 'signed-out', 15000);
  await lonca.api('POST', '/sandboxes/login');
  await expect.poll(async () => (await dockerLogin())?.code).toBe('VKNZ-LBTN');
  const second = spawnSync('node', [path.join(REPO_ROOT, 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: { ...process.env, LONCA_HOME: lonca.home, LONCA_INSTANCE: lonca.instance, LONCA_NO_OPEN: '1', LONCA_NO_NOTIFY: '1', PORT: String(lonca.port), ...lonca.env },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(second.status).toBe(1);
  expect(second.stderr).toContain('already in use');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(loginRunning()).toBe(true);
  expect((await dockerLogin())?.code).toBe('VKNZ-LBTN');
  await lonca.api('DELETE', '/sandboxes/login');
  await until('the sbx login to stop', () => !loginRunning(), 15000);
});

test('ends a sign-in that a server killed outright left waiting', async () => {
  fs.writeFileSync(signedOut, '');
  await until('it to be signed out', async () => (await lonca.api('POST', '/sandboxes/check')).state === 'signed-out', 15000);
  await lonca.api('POST', '/sandboxes/login');
  await expect.poll(async () => (await dockerLogin())?.code).toBe('VKNZ-LBTN');
  await lonca.kill();
  // Nothing of the server's was left to end it.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(loginRunning()).toBe(true);
  await lonca.start();
  await until('the left sbx login to stop', () => !loginRunning(), 15000);
  expect(await dockerLogin()).toBeUndefined();
});
