import fs from 'node:fs';
import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { AppState, Project, Session, SlackStatus, Workspace } from '../../shared/types.ts';
import { Lonca, REPO_ROOT, makeFixtureRepo, until } from '../support/harness.ts';
import { type FakeSlack, OWNER, TOKENS, startFakeSlack } from '../support/fake-slack.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 47431, instance: 'e2e-slack', firstWorkspacePort: 47000 });
const SHOTS = path.join(REPO_ROOT, 'test-results', 'slack');
let slack: FakeSlack;
let mock: MockLlm;
let fixture: string;

const state = () => lonca.api<AppState>('GET', '/state');

async function shot(target: Page | Locator, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.beforeAll(async () => {
  slack = await startFakeSlack();
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  lonca.env = { LONCA_SLACK_API_URL: slack.url };
  await lonca.start();
});

test.afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  await slack?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('sets Slack up, pairs and disconnects from Settings', async ({ page }) => {
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Slack', exact: true }) });
  await expect(section.getByText('"socket_mode_enabled": true')).toBeVisible();
  await expect(section.getByRole('link', { name: 'Create a Slack app' })).toHaveAttribute('href', 'https://api.slack.com/apps?new_app=1');
  await shot(section, 'setup');

  const bot = section.getByRole('textbox', { name: 'Bot token' });
  const app = section.getByRole('textbox', { name: 'App-level token' });
  await bot.fill('xoxb-1-not-one-slack-knows');
  await app.fill(TOKENS.app);
  await section.getByRole('button', { name: 'Save tokens' }).click();
  await expect(page.getByText('Slack didn’t accept the bot token (invalid_auth).')).toBeVisible();
  await bot.fill(TOKENS.bot);
  await section.getByRole('button', { name: 'Save tokens' }).click();
  await expect(section.getByText('Connected to Fake Team')).toBeVisible();
  // Only the ends of the tokens are ever shown.
  await expect(section.getByText(`The bot token ends in ${TOKENS.bot.slice(-4)}`)).toBeVisible();
  expect(await page.content()).not.toContain(TOKENS.bot);

  const code = (await section.locator('.login-code').textContent())!;
  expect(code).toMatch(/^\w{4}-\w{4}-\w{4}$/);
  await shot(section, 'pairing');
  slack.say(OWNER, code);
  await expect(section.getByText(/Paired with the Slack user/)).toContainText(OWNER);
  const replies = section.getByRole('switch', { name: 'Send Leads’ replies to Slack' });
  await expect(replies).toHaveAttribute('aria-checked', 'true');
  await replies.click();
  await expect(replies).toHaveAttribute('aria-checked', 'false');
  expect((await state()).settings.slackReplies).toBe(false);
  await replies.click();
  await expect(replies).toHaveAttribute('aria-checked', 'true');
  await shot(section, 'paired');

  await section.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(section.getByRole('button', { name: 'Save tokens' })).toBeVisible();
  expect((await state()).slack).toEqual({ connection: 'off' });
});

test('marks what the user wrote in Slack in the Lead’s chat', async ({ page }) => {
  const project = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', env: {
    ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock',
  } } });
  const saved = await lonca.api<SlackStatus>('PUT', '/slack', { botToken: TOKENS.bot, appToken: TOKENS.app });
  await until('Slack to connect', async () => (await state()).slack.connection === 'connected');
  slack.say(OWNER, saved.pairing!.code);
  await until('pairing', async () => (await state()).slack.owner?.user === OWNER);
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  const workspace = await lonca.waitForWorkspace(created.workspace.id);
  await lonca.api('POST', `/sessions/${created.session.id}/messages`, { text: 'Typed in Lonca', attachments: [] });
  await lonca.waitForIdle(created.session.id);
  const thread = await until('the thread', async () => (await lonca.workspace(workspace.id)).slack?.thread, 60000);
  slack.say(OWNER, 'Written in Slack', { thread });
  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  const fromSlack = page.locator('.user-message', { hasText: 'Written in Slack' });
  await expect(fromSlack.locator('.message-from')).toHaveText('From Slack');
  await expect(page.locator('.user-message', { hasText: 'Typed in Lonca' }).locator('.message-from')).toHaveCount(0);
  await lonca.waitForIdle(created.session.id);
  await shot(page, 'chat');
});
