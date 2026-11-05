// Drives the real web app in a browser against a real server, real containers and the
// real agent CLIs. Only the model behind the CLIs is scripted; see tests/support/mock-llm.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { Project, Workspace } from '../../shared/types.ts';
import {
  FAKE_SBX, FAKE_SBX_DIR, Lonca, REPO_ROOT, dockerExec, installFakeSignIn, makeFixtureRepo, removeFakeSignIn, setFakeSignIn, until,
} from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'shots');
const lonca = new Lonca({ port: 47381, instance: 'e2e', firstWorkspacePort: 46500 });
let mock: MockLlm;
let fixture: string;
let page: Page;
const pageErrors: string[] = [];

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const terminalText = (scope: Page | Locator = page) => scope.locator('.terminal-view:visible .xterm-rows');
const composer = () => page.getByRole('textbox', { name: 'Message' });

async function send(text: string): Promise<void> {
  await composer().fill(text);
  await composer().press('Enter');
}

async function currentWorkspace(): Promise<Workspace> {
  const id = /\/w\/([^/?]+)/.exec(page.url())![1];
  return until('the workspace', () => lonca.workspace(id));
}

async function waitForReady(): Promise<Workspace> {
  const workspace = await currentWorkspace();
  const ready = await lonca.waitForWorkspace(workspace.id);
  await expect(page.locator('[data-step="container"]')).toContainText('Running in its own container');
  return ready;
}

/** Sends a message and waits for that turn's own result. */
async function sendAndWait(text: string): Promise<void> {
  const before = await page.locator('.result-row').count();
  await send(text);
  await expect(page.locator('.result-row')).toHaveCount(before + 1, { timeout: 90000 });
  await expect(page.locator('.working-row')).toHaveCount(0);
}

async function waitForTurn(): Promise<void> {
  await expect(page.locator('.working-row')).toHaveCount(0, { timeout: 90000 });
  await expect(page.locator('.result-row').last()).toBeVisible();
}

function useMock(workspace: Workspace): void {
  dockerExec(workspace.containerName, `cat > ~/.codex/config.toml <<EOF
cli_auth_credentials_store = "file"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://host.docker.internal:${mock.port}/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
supports_websockets = false
EOF`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  await lonca.start();
  const context = await browser.newContext();
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) pageErrors.push(message.text());
  });
  await page.goto(`${lonca.url}/?token=${lonca.token}`);
  await expect(page.getByText('My workspaces')).toBeVisible();
  await expect(page).toHaveURL(`${lonca.url}/`);
});

test.afterAll(async () => {
  await lonca.destroy();
  await mock.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('asks for the access link instead of showing the app', async ({ browser }) => {
  const context = await browser.newContext();
  const stranger = await context.newPage();
  await stranger.goto(lonca.url);
  await expect(stranger.getByText('Open Lonca with the link printed in the terminal')).toBeVisible();
  await stranger.goto(`${lonca.url}/?token=wrong`);
  await expect(stranger.getByText('Open Lonca with the link printed in the terminal')).toBeVisible();
  await context.close();
});

test('ignores a stray link with a bad token instead of logging you out', async () => {
  const other = await page.context().newPage();
  await other.goto(`${lonca.url}/?token=wrong`);
  await expect(other.getByText('My workspaces')).toBeVisible();
  await expect(other).toHaveURL(`${lonca.url}/`);
  await other.reload();
  await expect(other.getByText('My workspaces')).toBeVisible();
  await other.close();
});

test('removes the token from the address bar and keeps it from other ports', async () => {
  expect(page.url()).not.toContain('token');
  expect(await page.context().cookies()).toEqual([]);
  // An agent could serve this page from a published port and hope the user opens it.
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>agent page</title>');
  });
  await new Promise<void>((resolve) => server.listen(46499, '127.0.0.1', resolve));
  const other = await page.context().newPage();
  await other.goto('http://localhost:46499/');
  expect(seen[0].cookie).toBeUndefined();
  expect(await other.evaluate(() => JSON.stringify(localStorage))).toBe('{}');
  const reached = await other.evaluate(async (url) => {
    try {
      return (await fetch(`${url}/api/state`)).status;
    } catch {
      return 'blocked';
    }
  }, lonca.url);
  expect(reached).not.toBe(200);
  await other.close();
  server.close();
});

test('first run guides you through setup', async () => {
  await expect(page.getByRole('heading', { name: 'Get set up' })).toBeVisible();
  await expect(page.getByText(/Docker .* is running/)).toBeVisible();
  await expect(page.getByText('The workspace image is ready')).toBeVisible({ timeout: 300000 });
  await expect(page.getByText('Docker ready')).toBeVisible();
  await expect(page.getByText('Sign in to Claude')).toBeVisible({ timeout: 60000 });
  await shot('home-first-run');
});

test('adds a project, reporting mistakes clearly', async () => {
  await page.getByRole('button', { name: 'Add a project' }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Add a project' });
  await dialog.getByRole('tab', { name: 'Folder on this computer' }).click();
  await dialog.getByRole('textbox').fill('/tmp');
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await expect(dialog.getByRole('alert')).toContainText('not a git repository');
  await dialog.getByRole('textbox').fill(fixture);
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: new RegExp(`New workspace in ${path.basename(fixture)}`) })).toBeEnabled({ timeout: 30000 });
  await shot('project-added');
  const projects = (await lonca.api('GET', '/state')).projects as Project[];
  await lonca.api('PATCH', `/projects/${projects[0].id}`, { settings: { filesToCopy: ['.env*'] } });
});

test('creates a workspace in one click and shows how it boots', async () => {
  await page.getByRole('button', { name: new RegExp(`New workspace in ${path.basename(fixture)}`) }).click();
  await expect(page).toHaveURL(/\/w\//);
  await expect(page.getByText(/You’re in a new copy of/)).toBeVisible();
  const workspace = await waitForReady();
  await expect(page.getByText(`Branched ${workspace.branch} from origin/main`)).toBeVisible();
  await expect(page.locator('[data-step="files"]')).toContainText('and copied 1 file');
  await expect(page.locator('[data-step="container"]')).toContainText(workspace.containerName);
  await expect(page.getByRole('link', { name: new RegExp(workspace.name) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'src' })).toBeVisible();
  await shot('workspace-ready');
});

test('opens a working terminal inside the container', async () => {
  const workspace = await currentWorkspace();
  await expect(terminalText()).toContainText(`lonca@${workspace.name}`, { timeout: 20000 });
  await page.locator('.terminal-view:visible .xterm-screen').click();
  await page.keyboard.type('echo "in=$(hostname)" && git branch --show-current\n');
  await expect(terminalText()).toContainText(`in=${workspace.name}`);
  await expect(terminalText()).toContainText(workspace.branch);

  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.getByRole('tab', { name: 'Terminal 2' })).toBeVisible();
  await expect(terminalText()).toContainText(`lonca@${workspace.name}`);
  await page.getByRole('button', { name: 'Close Terminal 2' }).click();
  await expect(page.getByRole('tab', { name: 'Terminal 2' })).toBeHidden();
  await expect(terminalText()).toContainText(`in=${workspace.name}`);
});

test('browses files and searches them', async () => {
  await page.getByRole('button', { name: 'src' }).click();
  await page.getByRole('button', { name: 'index.js' }).click();
  await expect(page.locator('.file-view')).toContainText('console.log');
  await expect(page.getByRole('tab', { name: 'index.js' })).toBeVisible();
  await shot('file-view');

  await page.getByRole('button', { name: 'Search files' }).click();
  await page.getByRole('textbox', { name: 'Search files' }).fill('hello');
  await expect(page.locator('.content-hit')).toContainText('src/index.js:1');
  await page.getByRole('button', { name: 'Show the file tree' }).click();
  await page.getByRole('button', { name: 'Close index.js' }).click();
});

test('shows when an agent isn’t signed in and goes straight to signing in', async () => {
  await send('hello');
  const notice = page.locator('.notice-error');
  await expect(notice).toContainText('Claude isn’t signed in yet.', { timeout: 60000 });
  await expect(page.locator('.composer-hint')).toHaveCount(0);
  await shot('signed-out-error');
  await notice.getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to Claude' });
  // The real CLI, out of sight, produces a real link.
  const open = dialog.getByRole('link', { name: 'Open sign-in page' });
  await expect(open).toHaveAttribute('href', /^https:\/\/claude\.com\//, { timeout: 30000 });
  await shot('login-claude');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/w\//);
});

test.describe('signing in', () => {
  const tools = () => `${lonca.prefix}-tools`;
  const codeBox = () => page.getByRole('textbox', { name: 'Sign-in code' });
  const agentRow = (name: 'Claude' | 'Codex') => page.locator('.settings-row').filter({ hasText: name });

  test.beforeAll(() => {
    installFakeSignIn(tools());
  });

  test.afterAll(() => {
    removeFakeSignIn(tools());
  });

  /** Stands in for a service's sign-in page, whose button sends the browser back where it was told to. */
  const fakeSignInPage = (pattern: string, query: string) => page.context().route(pattern, (route) => {
    const url = new URL(route.request().url());
    const back = `${url.searchParams.get('redirect_uri')}?${query}&state=${url.searchParams.get('state')}`;
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<a href="${back}">Approve</a>` });
  });

  /** Opens the sign-in page from the dialog and approves there, and gives back the tab that came back. */
  async function approveOnPage(dialog: Locator): Promise<Page> {
    const [tab] = await Promise.all([page.context().waitForEvent('page'), dialog.getByRole('link', { name: 'Open sign-in page' }).click()]);
    await expect(dialog.getByRole('status')).toContainText('Waiting for you to approve');
    await shot('login-browser-waiting');
    await tab.getByRole('link', { name: 'Approve' }).click();
    return tab;
  }

  test('Claude: approve on the page, and the browser comes back and the window closes by itself', async () => {
    setFakeSignIn(tools(), { mode: 'ok' });
    await fakeSignInPage('https://claude.com/**', 'code=fakecode');
    await page.goto(`${lonca.url}/settings`);
    await expect(agentRow('Claude')).toContainText('Not signed in');
    await shot('settings');
    await agentRow('Claude').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Claude' });
    await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible({ timeout: 30000 });
    await expect(dialog.getByRole('button', { name: 'paste a code instead' })).toBeVisible({ timeout: 30000 });
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await shot('login-claude-browser');

    // Clicking back from the browser tab mustn't lose the sign-in.
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();

    const tab = await approveOnPage(dialog);
    const signedIn = page.getByRole('dialog', { name: 'Claude is signed in' });
    await Promise.all([
      expect(signedIn).toContainText('Signed in with your Claude subscription', { timeout: 30000 }),
      expect(tab.getByRole('heading', { name: 'You’re signed in' })).toBeVisible({ timeout: 30000 }),
    ]);
    expect(await tab.locator('body').innerText()).not.toContain('sk-ant-oat');
    expect(tab.url()).toMatch(/^http:\/\/localhost:\d+\/callback\?code=fakecode&state=/);
    await tab.screenshot({ path: path.join(SHOTS, 'login-returned.png') });
    await tab.close();
    expect(await page.locator('body').innerText()).not.toContain('sk-ant-oat');

    await expect(signedIn).toBeHidden({ timeout: 5000 });
    await expect(agentRow('Claude')).toContainText('Signed in with your Claude subscription');
    await agentRow('Claude').getByRole('button', { name: 'Sign out' }).click();
    await expect(agentRow('Claude')).toContainText('Not signed in');
  });

  test('Claude: a refused sign-in says so, in the browser and here', async () => {
    setFakeSignIn(tools(), { mode: 'rejected' });
    await agentRow('Claude').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Claude' });
    await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible({ timeout: 30000 });
    const tab = await approveOnPage(dialog);
    await Promise.all([
      expect(dialog.getByRole('alert')).toContainText('Claude didn’t accept that sign-in', { timeout: 30000 }),
      expect(tab.getByRole('heading', { name: 'That sign-in didn’t finish' })).toBeVisible({ timeout: 30000 }),
    ]);
    await tab.close();
    setFakeSignIn(tools(), { mode: 'ok' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(agentRow('Claude')).toContainText('Not signed in');
  });

  test('Claude: where the page can’t come back, paste the code it gives instead', async () => {
    await agentRow('Claude').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Claude' });
    await dialog.getByRole('button', { name: 'paste a code instead' }).click({ timeout: 30000 });
    const open = dialog.getByRole('link', { name: 'Open sign-in page' });
    await expect(open).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await shot('login-claude');

    const href = (await open.getAttribute('href'))!;
    expect(new URL(href).searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    const [tab] = await Promise.all([page.context().waitForEvent('page'), open.click()]);
    await tab.close();
    await expect(dialog.getByRole('link', { name: 'Open again' })).toBeVisible();
    await expect(codeBox()).toBeFocused();
    await shot('login-claude-after-open');

    // A key in the code box gets a way forward, not a dead end.
    await codeBox().fill('sk-ant-api03-pasted-in-the-wrong-place');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByRole('alert')).toContainText('That’s a key, not a sign-in code.');
    await shot('login-claude-wrong-paste');

    const state = new URL(href).searchParams.get('state');
    await codeBox().fill(`fakecode#${state}`);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    const signedIn = page.getByRole('dialog', { name: 'Claude is signed in' });
    await expect(signedIn).toBeVisible({ timeout: 30000 });
    await expect(signedIn).toContainText('Signed in with your Claude subscription');
    await shot('login-claude-success');
    expect(await page.locator('body').innerText()).not.toContain('sk-ant-oat');

    await expect(signedIn).toBeHidden({ timeout: 5000 });
    await expect(agentRow('Claude')).toContainText('Signed in with your Claude subscription');
    await shot('settings-signed-in');
    expect(await page.locator('body').innerText()).not.toContain('sk-ant-oat');
    await agentRow('Claude').getByRole('button', { name: 'Sign out' }).click();
    await expect(agentRow('Claude')).toContainText('Not signed in');
  });

  test('Claude: a refused code says so, and starting again gets a new link', async () => {
    setFakeSignIn(tools(), { mode: 'rejected' });
    await agentRow('Claude').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Claude' });
    await dialog.getByRole('button', { name: 'paste a code instead' }).click({ timeout: 30000 });
    const open = dialog.getByRole('link', { name: 'Open sign-in page' });
    await expect(open).toBeVisible();
    const first = (await open.getAttribute('href'))!;
    await codeBox().fill(`wrong#${new URL(first).searchParams.get('state')}`);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Claude didn’t accept that sign-in', { timeout: 30000 });
    await shot('login-claude-failed');

    await dialog.getByRole('button', { name: 'Show what Claude printed' }).click();
    await expect(dialog.locator('.login-log')).toContainText('wasn');
    await shot('login-claude-failed-output');

    setFakeSignIn(tools(), { mode: 'ok' });
    await dialog.getByRole('button', { name: 'Start again' }).click();
    await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible({ timeout: 30000 });
    expect(await dialog.getByRole('link', { name: 'Open sign-in page' }).getAttribute('href')).not.toBe(first);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a key has its own route, checks what it’s given, and closes when saved', async () => {
    await agentRow('Claude').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Claude' });
    await dialog.getByRole('tab', { name: 'API key' }).click();
    const field = dialog.getByRole('textbox', { name: 'API key or token' });
    await expect(field).toBeFocused();
    await shot('login-claude-key');
    await field.fill('a-code-from-the-browser#abc');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toContainText('That isn’t a key');
    await shot('login-claude-key-error');

    // Its offer to treat that as a code moves it across.
    await dialog.getByRole('button', { name: 'Use it as the sign-in code' }).click();
    await expect(codeBox()).toHaveValue('a-code-from-the-browser#abc');
    await dialog.getByRole('tab', { name: 'API key' }).click();

    await dialog.getByRole('textbox', { name: 'API key or token' }).fill('sk-ant-api03-not-a-real-key-at-all');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const signedIn = page.getByRole('dialog', { name: 'Claude is signed in' });
    await expect(signedIn).toContainText('Using an API key ending in -all', { timeout: 30000 });
    await expect(signedIn).toBeHidden({ timeout: 5000 });
    await agentRow('Claude').getByRole('button', { name: 'Sign out' }).click();
    await expect(agentRow('Claude')).toContainText('Not signed in');
  });

  test('Codex: approve on the page, and the browser comes back and the window closes by itself', async () => {
    setFakeSignIn(tools(), { mode: 'ok' });
    await fakeSignInPage('https://auth.openai.com/**', 'code=fakecode');
    await agentRow('Codex').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
    await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible({ timeout: 30000 });
    await shot('login-codex-browser');
    const tab = await approveOnPage(dialog);
    const signedIn = page.getByRole('dialog', { name: 'Codex is signed in' });
    await Promise.all([
      expect(signedIn).toContainText('Signed in with ChatGPT as probe@example.com', { timeout: 30000 }),
      expect(tab.getByRole('heading', { name: 'You’re signed in' })).toBeVisible({ timeout: 30000 }),
    ]);
    // The CLI redirects to its own page with a token in the address. That stays with the CLI.
    expect(tab.url()).toMatch(/^http:\/\/127\.0\.0\.1:1455\/auth\/callback\?code=fakecode&state=/);
    await tab.close();
    await expect(signedIn).toBeHidden({ timeout: 5000 });
    await expect(agentRow('Codex')).toContainText('Signed in with ChatGPT as probe@example.com');
    await agentRow('Codex').getByRole('button', { name: 'Sign out' }).click();
    await expect(agentRow('Codex')).toContainText('Not signed in');
  });

  test('Codex: turning it down on the page says so, in the browser and here', async () => {
    await fakeSignInPage('https://auth.openai.com/**', 'error=access_denied&error_description=The+user+said+no');
    await agentRow('Codex').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
    await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible({ timeout: 30000 });
    const tab = await approveOnPage(dialog);
    await Promise.all([
      expect(dialog.getByRole('alert')).toContainText('The sign-in page didn’t approve this', { timeout: 30000 }),
      expect(tab.getByRole('heading', { name: 'That sign-in didn’t finish' })).toBeVisible({ timeout: 30000 }),
    ]);
    await tab.close();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(agentRow('Codex')).toContainText('Not signed in');
  });

  test('Codex: says when the port is taken, and the one-time code doesn’t need it', async () => {
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(1455, '127.0.0.1', resolve));
    try {
      setFakeSignIn(tools(), { mode: 'ok', approved: false });
      await agentRow('Codex').getByRole('button', { name: 'Sign in' }).click();
      const dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
      await expect(dialog.getByRole('alert')).toContainText('port 1455', { timeout: 30000 });
      await shot('login-codex-port-busy');
      await dialog.getByRole('button', { name: 'Use a one-time code' }).click();
      await expect(dialog.locator('.login-code')).toHaveText('FAKE-7CODE', { timeout: 30000 });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
    } finally {
      squatter.close();
    }
  });

  test('Codex: where the page can’t come back, copy the code, approve on the page, and the window moves on by itself', async () => {
    setFakeSignIn(tools(), { mode: 'ok', approved: false });
    await agentRow('Codex').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
    await dialog.getByRole('button', { name: 'use a one-time code instead' }).click({ timeout: 30000 });
    await expect(dialog.locator('.login-code')).toHaveText('FAKE-7CODE', { timeout: 30000 });
    await shot('login-codex');

    await page.context().route('http://127.0.0.1:8080/**', (route) => route.fulfill({ status: 200, body: 'enter code here' }));
    const [tab] = await Promise.all([page.context().waitForEvent('page'), dialog.getByRole('link', { name: 'Copy code and open' }).click()]);
    await tab.close();
    expect(await page.evaluate('navigator.clipboard.readText()')).toBe('FAKE-7CODE');
    await expect(dialog.getByRole('status')).toContainText('Waiting for you');
    await shot('login-codex-waiting');

    setFakeSignIn(tools(), { approved: true });
    const signedIn = page.getByRole('dialog', { name: 'Codex is signed in' });
    await expect(signedIn).toContainText('Signed in with ChatGPT as probe@example.com', { timeout: 30000 });
    await shot('login-codex-success');
    await expect(signedIn).toBeHidden({ timeout: 5000 });
    await expect(agentRow('Codex')).toContainText('Signed in with ChatGPT as probe@example.com');
    await agentRow('Codex').getByRole('button', { name: 'Sign out' }).click();
    await expect(agentRow('Codex')).toContainText('Not signed in');
  });

  test('Codex: says what to do when device sign-in is turned off', async () => {
    setFakeSignIn(tools(), { mode: 'disabled', approved: false });
    await agentRow('Codex').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
    await dialog.getByRole('button', { name: 'use a one-time code instead' }).click({ timeout: 30000 });
    await expect(dialog.getByRole('alert')).toContainText('Device code login is turned off', { timeout: 30000 });
    await expect(dialog.getByRole('link', { name: 'Open ChatGPT settings' })).toBeVisible();
    await shot('login-codex-disabled');
    await dialog.getByRole('button', { name: 'Use an API key' }).click();
    await expect(dialog.getByRole('textbox', { name: 'OpenAI API key' })).toBeFocused();
    await shot('login-codex-key');
    setFakeSignIn(tools(), { mode: 'ok' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Codex: a one-time code stays that way through a reload, and when trying again', async () => {
    setFakeSignIn(tools(), { mode: 'ok', approved: false });
    await agentRow('Codex').getByRole('button', { name: 'Sign in' }).click();
    let dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
    await dialog.getByRole('button', { name: 'use a one-time code instead' }).click({ timeout: 30000 });
    await expect(dialog.locator('.login-code')).toHaveText('FAKE-7CODE', { timeout: 30000 });
    await page.reload();
    dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
    await expect(dialog.locator('.login-code')).toHaveText('FAKE-7CODE', { timeout: 15000 });

    setFakeSignIn(tools(), { mode: 'denied' });
    await expect(dialog.getByRole('alert')).toContainText('The sign-in page didn’t approve this', { timeout: 30000 });
    setFakeSignIn(tools(), { mode: 'ok', approved: false });
    await dialog.getByRole('button', { name: 'Try again' }).click();
    await expect(dialog.locator('.login-code')).toHaveText('FAKE-7CODE', { timeout: 30000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a sign-in comes back after reloading the page', async () => {
    await agentRow('Claude').getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Claude' });
    await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible({ timeout: 30000 });
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Sign in to Claude' }).getByRole('link', { name: 'Open sign-in page' })).toBeVisible({ timeout: 15000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.goBack();
  });
});

test.describe('with agents connected', () => {
  let agentProject: Project;
  let workspace: Workspace;

  test.beforeAll(async () => {
    // The mock runs on the host, so this project opts in to host access.
    const repo = makeFixtureRepo();
    agentProject = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: repo })).id);
    await lonca.api('PATCH', `/projects/${agentProject.id}`, {
      name: 'agents-demo',
      settings: {
        network: 'host',
        env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock', MOCK_KEY: 'sk-mock' },
      },
    });
    const created = await lonca.api('POST', `/projects/${agentProject.id}/workspaces`, {});
    workspace = await lonca.waitForWorkspace(created.workspace.id);
    useMock(workspace);
    await page.goto(`${lonca.url}/w/${workspace.id}`);
    await expect(page.getByText('Optional:')).toBeVisible();
  });

  test('streams a Claude turn: thinking, command, result and the sidebar title', async () => {
    await sendAndWait('THINK first. RUN: echo from-claude > made-by-claude.txt && ls');
    await expect(page.locator('.user-message')).toContainText('THINK first');
    await expect(page.locator('.assistant-text').last()).toContainText('The command finished.');
    await expect(page.locator('.tool-thinking')).toBeVisible();
    const command = page.locator('.tool-done').filter({ hasText: 'Run the requested command' });
    await expect(command).toBeVisible();
    await expect(page.locator('.result-row').last()).toContainText(/Finished in/);
    await expect(page.getByRole('link', { name: /THINK first/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /THINK first/ })).toBeVisible();

    await command.locator('.tool-head').click();
    await expect(command.locator('.tool-command')).toContainText('echo from-claude');
    await expect(command.locator('.tool-output')).toContainText('made-by-claude.txt');
    await shot('claude-turn');
  });

  test('shows what changed, with a diff, as soon as the agent writes', async () => {
    await expect(page.getByRole('button', { name: 'made-by-claude.txt' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('tab', { name: /Changes/ }).click();
    await expect(page.getByRole('tab', { name: /Changes/ })).toContainText('1');
    await page.locator('.change-row').filter({ hasText: 'made-by-claude.txt' }).click();
    await expect(page.locator('.diff-view')).toContainText('from-claude');
    await expect(page.locator('.diff-add')).toHaveCount(1);
    await expect(page.locator('.workspace-row.active .diff-badge')).toContainText('+1');
    await shot('diff-view');
    await page.getByRole('button', { name: 'Close made-by-claude.txt' }).click();
    await page.getByRole('tab', { name: 'All files' }).click();
  });

  test('continues the conversation and queues follow-ups', async () => {
    await send('SLOW first question');
    await expect(page.locator('.working-row')).toBeVisible();
    await send('a queued follow-up');
    await expect(page.locator('.user-message.queued')).toContainText('a queued follow-up');
    await expect(page.locator('.queued-note')).toContainText('Sends when the current turn finishes');
    await shot('queued');
    await expect(page.locator('.assistant-text').last()).toContainText('You said: a queued follow-up', { timeout: 90000 });
    await expect(page.locator('.user-message.queued')).toHaveCount(0);
    await waitForTurn();
    // The follow-up reads as coming after the answer it waited for, not before it.
    const order = await page.locator('.user-message, .assistant-text').allInnerTexts();
    const firstAnswer = order.findIndex((text) => text.includes('You said: SLOW first question'));
    const followUp = order.indexOf('a queued follow-up');
    expect(firstAnswer).toBeGreaterThan(-1);
    expect(followUp).toBeGreaterThan(firstAnswer);
  });

  test('stops a running turn and can go on afterwards', async () => {
    await send('SLOW please stop me');
    await expect(page.locator('.working-row')).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.result-row').last()).toContainText('Stopped', { timeout: 15000 });
    await send('after stopping');
    await expect(page.locator('.assistant-text').last()).toContainText('You said: after stopping', { timeout: 60000 });
    await waitForTurn();
  });

  test('holds queued messages after Stop until you decide', async () => {
    await send('SLOW interrupted turn');
    await expect(page.locator('.working-row')).toBeVisible();
    await send('held back');
    await expect(page.locator('.user-message.queued')).toContainText('held back');
    await composer().fill('');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.queued-note')).toContainText('Waiting to send', { timeout: 15000 });
    await expect(page.locator('.working-row')).toHaveCount(0);
    await shot('held-message');
    await page.getByRole('button', { name: 'Send now' }).click();
    await expect(page.locator('.assistant-text').last()).toContainText('You said: held back', { timeout: 60000 });
    await waitForTurn();
  });

  test('picks up a running turn after a page reload', async () => {
    await send('SLOW reload during this');
    await expect(page.locator('.working-row')).toBeVisible();
    await page.reload();
    await expect(page.locator('.user-message').last()).toContainText('SLOW reload during this');
    await expect(page.locator('.working-row')).toBeVisible();
    await expect(page.locator('.assistant-text').last()).toContainText('You said: SLOW reload during this', { timeout: 60000 });
    await waitForTurn();
  });

  test('picks up a running turn after the server restarts', async () => {
    await send('SLOW restart the server');
    await expect(page.locator('.working-row')).toBeVisible();
    await until('the agent to start', () => dockerExec(workspace.containerName, 'pgrep -f "claude -p"').code === 0, 10000);
    await lonca.kill();
    await expect(page.getByText('Lost the connection to the Lonca server')).toBeVisible();
    await shot('disconnected');
    await lonca.start();
    await expect(page.getByText('Lost the connection to the Lonca server')).toBeHidden({ timeout: 20000 });
    await expect(page.locator('.assistant-text').last()).toContainText('You said: SLOW restart the server', { timeout: 60000 });
    await waitForTurn();
    await expect(page.getByText('You said: SLOW restart the server')).toHaveCount(1);
    await expect(page.locator('.user-message').filter({ hasText: 'SLOW restart the server' })).toHaveCount(1);
  });

  test('attaches files to a message', async () => {
    await page.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('remember this') });
    await expect(page.locator('.composer .attachment-chip')).toContainText('notes.txt');
    await sendAndWait('see attached');
    await expect(page.locator('.user-message').last().locator('.attachment-chip')).toContainText('notes.txt');
    const found = dockerExec(workspace.containerName, `cat ${workspace.path}/.context/attachments/*/notes.txt`).output;
    expect(found).toBe('remember this');
  });

  test('lists both agents in the model picker and locks a started conversation to one', async () => {
    await page.locator('.model-button').click();
    await shot('model-picker');
    await expect(page.locator('.model-popover')).toContainText('Opus 5.5');
    await expect(page.locator('.model-popover')).toContainText('Codex');
    await expect(page.getByRole('button', { name: /^GPT/ }).first()).toBeDisabled();
    await page.getByRole('button', { name: 'Sonnet 5.5' }).click();
    await page.getByRole('button', { name: 'Low', exact: true }).click();
    await expect(page.locator('.model-button')).toContainText('Sonnet 5.5');
    await expect(page.locator('.model-button')).toContainText('Low');
    await sendAndWait('now on sonnet');
    expect(mock.requests.at(-1)?.model).toBe('claude-sonnet-5-5');
    await page.locator('.model-button').click();
    await page.getByRole('button', { name: 'Opus 5.5' }).click();
    await page.getByRole('button', { name: 'High', exact: true }).click();
  });

  test('runs Codex in another tab of the same workspace', async () => {
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByText(/You’re in a new copy of/)).toBeVisible();
    await page.locator('.model-button').click();
    await page.locator('.model-popover .menu-item').filter({ hasText: /^GPT/ }).first().click();
    await expect(page.locator('.model-button')).toContainText('GPT');
    await page.keyboard.press('Escape');
    await sendAndWait('RUN: echo from-codex > made-by-codex.txt && ls');
    await expect(page.locator('.assistant-text').last()).toContainText('The command finished.');
    await expect(page.locator('.tool-done').filter({ hasText: 'echo from-codex' })).toBeVisible();
    expect(fs.readFileSync(path.join(workspace.path, 'made-by-codex.txt'), 'utf8').trim()).toBe('from-codex');
    await shot('codex-turn');
  });

  test('starts a workspace from the Create page with a first message', async () => {
    const previous = page.url();
    await page.getByRole('link', { name: 'Create', exact: true }).click();
    await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'agents-demo' });
    await page.locator('.model-button').click();
    await page.getByRole('button', { name: 'Opus 5.5' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.model-button')).toContainText('Opus 5.5');
    await page.getByRole('textbox', { name: 'First message (optional)' }).fill('RUN: echo first-message > first.txt');
    await shot('create-page');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/w\//);
    const created = await currentWorkspace();
    await lonca.waitForWorkspace(created.id);
    await expect(page.locator('.tool-done').filter({ hasText: 'echo first-message' })).toBeVisible({ timeout: 90000 });
    await expect(page.locator('.result-row')).toHaveCount(1, { timeout: 30000 });
    expect(fs.readFileSync(path.join(created.path, 'first.txt'), 'utf8').trim()).toBe('first-message');
    await lonca.api('DELETE', `/workspaces/${created.id}`);
    await page.goto(previous);
    await expect(page.locator('.session-tab').first()).toBeVisible();
  });

  test('renames and closes conversation tabs', async () => {
    const activeTab = page.locator('.session-tab.active');
    await activeTab.getByRole('button', { name: 'Rename this tab' }).click();
    await page.getByRole('textbox', { name: 'Tab name' }).fill('Codex work');
    await page.getByRole('textbox', { name: 'Tab name' }).press('Enter');
    await expect(page.locator('.session-tab.active')).toContainText('Codex work');
    await page.locator('.session-tab.active').hover();
    await page.getByRole('button', { name: 'Close Codex work' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close tab' }).click();
    await expect(page.getByRole('tab', { name: /Codex work/ })).toHaveCount(0);
    await expect(page.locator('.session-tab.active')).toContainText('THINK first');
  });

  test('searches across workspaces with the keyboard', async () => {
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('textbox').fill('made-by-claude');
    await expect(dialog.locator('.palette-row')).toContainText('made-by-claude.txt');
    await shot('search');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.file-view')).toContainText('from-claude');
    await page.getByRole('button', { name: 'Close made-by-claude.txt' }).click();
  });

  test('project settings drive setup and run scripts', async () => {
    await page.goto(`${lonca.url}/projects/${agentProject.id}`);
    await page.getByLabel('Setup script').fill('echo preparing && echo ready > setup-done.txt');
    await page.getByLabel('Run script').fill('python3 -m http.server $LONCA_PORT --bind 0.0.0.0');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.toast')).toContainText('Saved');
    await shot('project-settings');

    await page.getByRole('button', { name: 'New workspace in agents-demo' }).click();
    await expect(page).toHaveURL(/\/w\//);
    const fresh = await waitForReady();
    await until('the setup script', async () => (await lonca.workspace(fresh.id)).steps.find((step) => step.id === 'setup')?.status === 'done', 30000);
    expect(fs.readFileSync(path.join(fresh.path, 'setup-done.txt'), 'utf8').trim()).toBe('ready');
    await expect(page.getByText('Ran the setup script')).toBeVisible();
    await page.getByRole('tab', { name: 'Setup' }).click();
    await expect(terminalText()).toContainText('preparing');

    await page.getByRole('tab', { name: 'Run' }).click();
    await expect(page.locator('.port-link')).toContainText(`localhost:${fresh.port}`);
    await expect(page.getByRole('button', { name: 'Hide terminals' })).toBeInViewport();
    await page.getByRole('button', { name: 'Start the run script' }).click();
    await expect(terminalText()).toContainText(/Serving HTTP/, { timeout: 15000 });
    const response = await until('the published port', () => fetch(`http://127.0.0.1:${fresh.port}/setup-done.txt`), 15000);
    expect(await response.text()).toContain('ready');
    await shot('run-script');
    await page.getByRole('button', { name: 'Stop the run script' }).click();
    await expect(page.getByRole('button', { name: 'Start the run script' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Archive this workspace' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.workspace-banner')).toContainText('archived', { timeout: 30000 });
    await page.getByRole('button', { name: 'Delete this workspace' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page).toHaveURL(`${lonca.url}/`);
    await until('the workspace to go', async () => (await lonca.workspace(fresh.id)) === undefined, 30000);
    expect(fs.existsSync(fresh.path)).toBe(false);
  });

  test('switches between workspaces without losing either', async () => {
    await page.goto(`${lonca.url}/w/${workspace.id}`);
    await expect(page.locator('.assistant-text').last()).toBeVisible();
    await composer().fill('an unsent draft');
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Recent workspaces' })).toBeVisible();
    await shot('home-with-workspaces');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(composer()).toHaveValue('an unsent draft');
    await composer().fill('');
  });

  test('wakes a stopped workspace, then archives and restores it', async () => {
    await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
    await expect(page.locator('.workspace-banner')).toContainText('container is stopped');
    await shot('stopped');
    await page.locator('.workspace-banner').getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('.workspace-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Archive this workspace' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('uncommitted');
    await shot('archive-confirm');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Open this workspace elsewhere' }).click();
    await page.getByRole('menuitem', { name: 'Open in VS Code' }).click();
    await expect(page.getByRole('dialog')).toContainText('outside the container');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Archive this workspace' }).click();
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.workspace-banner')).toContainText('archived', { timeout: 30000 });
    expect(fs.existsSync(workspace.path)).toBe(false);
    await expect(composer()).toBeDisabled();
    await expect(page.getByRole('button', { name: '1 archived' })).toBeVisible();
    await expect(page.locator('.user-message').first()).toContainText('THINK first');

    await page.locator('.workspace-banner').getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('.workspace-banner')).toHaveCount(0, { timeout: 60000 });
    await lonca.waitForWorkspace(workspace.id);
    await expect(composer()).toBeEnabled();
    await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.user-message').first()).toContainText('THINK first');
  });

  test('stays usable in a narrow window', async () => {
    await page.setViewportSize({ width: 900, height: 700 });
    await shot('narrow');
    await page.getByRole('button', { name: 'Hide the side panel' }).click();
    await expect(page.locator('.right-panel')).toHaveCount(0);
    await expect(composer()).toBeVisible();
    await page.getByRole('button', { name: 'Show the side panel' }).click();
    await page.setViewportSize({ width: 1440, height: 840 });
  });
});

test('removes a project and everything in it', async () => {
  await page.goto(`${lonca.url}/`);
  const name = path.basename(fixture);
  const before = (await lonca.api('GET', '/state')).projects.find((project: Project) => project.name === name) as Project;
  await page.goto(`${lonca.url}/projects/${before.id}`);
  await page.getByRole('button', { name: 'Remove project' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove project' }).click();
  await expect(page).toHaveURL(`${lonca.url}/`);
  await until('the project to go', async () => !(await lonca.api('GET', '/state')).projects.some((project: Project) => project.id === before.id), 60000);
  expect(fs.existsSync(path.join(lonca.home, 'projects', before.slug))).toBe(false);
  expect(fs.existsSync(path.join(fixture, 'README.md'))).toBe(true);
  expect(execFileSync('git', ['-C', fixture, 'status', '--short'], { encoding: 'utf8' })).toBe('');
});

test('keeps the page in place when the terminal takes focus', async () => {
  await page.goto(`${lonca.url}/`);
  await expect(page.getByText('My workspaces')).toBeVisible();
  const scrolled = await page.evaluate(`
    window.scrollTo(0, 500);
    document.documentElement.scrollTop = 500;
    [window.scrollY, document.documentElement.scrollTop, document.body.scrollTop];
  `);
  expect(scrolled).toEqual([0, 0, 0]);
});

test.describe('how workspaces are isolated', () => {
  // That depends on what's on the machine, so these have a server of their own.
  async function settingsOn(env: Record<string, string>, check: (view: Page) => Promise<void>): Promise<void> {
    const server = new Lonca({ port: 47382, instance: 'e2e-isolation', firstWorkspacePort: 46700 });
    server.env = { LONCA_RUNTIME: 'auto', LONCA_SBX: FAKE_SBX, ...env };
    await server.start();
    const view = await page.context().newPage();
    try {
      await view.goto(`${server.url}/settings?token=${server.token}`);
      await check(view);
    } finally {
      await view.close();
      await server.destroy();
    }
  }

  const row = (view: Page) => view.locator('.settings-block').filter({ hasText: /Virtual machines|Containers/ }).first();
  const shotOfRow = async (view: Page, name: string) => {
    await row(view).evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await view.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };

  test('says how to get virtual machines when Docker Sandboxes isn’t installed', async () => {
    await settingsOn({ LONCA_SBX: '/nonexistent/sbx' }, async (view) => {
      await expect(row(view)).toContainText('New workspaces run in hardened containers', { timeout: 30000 });
      await expect(row(view).locator('.isolation-command')).toContainText('brew install docker/tap/sbx');
      await shotOfRow(view, 'settings-isolation-not-installed');
    });
  });

  test('moves to virtual machines by itself once signed in', async () => {
    const flag = path.join(FAKE_SBX_DIR, 'signed-out');
    fs.writeFileSync(flag, '');
    await settingsOn({}, async (view) => {
      await expect(row(view)).toContainText('isn’t signed in', { timeout: 30000 });
      await expect(row(view)).toContainText('sbx login');
      await shotOfRow(view, 'settings-isolation-signed-out');

      fs.rmSync(flag);
      await row(view).getByRole('button', { name: 'Check again' }).click();
      await expect(row(view)).toContainText('Each new workspace gets its own virtual machine', { timeout: 30000 });
      await expect(row(view).getByRole('button', { name: 'Check again' })).toHaveCount(0);
      await shotOfRow(view, 'settings-isolation-vm');
    });
  });
});

test('had no uncaught errors in the page', async () => {
  expect(pageErrors).toEqual([]);
});
