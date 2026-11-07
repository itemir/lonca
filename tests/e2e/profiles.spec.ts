import fs from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { AppState, Profile, Project, Session, Workspace } from '../../shared/types.ts';
import { Lonca, REPO_ROOT, makeFixtureRepo } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

// Several sign-ins for one provider. Nothing here has a proxy, so each sign-in's placeholder reaches
// the mock as it is, and the mock can put one of them at its usage limit and not the other.

const lonca = new Lonca({ port: 48461, instance: 'e2e-profiles', firstWorkspacePort: 59300 });
const SHOTS = path.join(REPO_ROOT, 'test-results', 'profiles');
const FIRST_PLACEHOLDER = 'sk-ant-oat01-lonca-placeholder';
let mock: MockLlm;
let fixture: string;
let project: Project;

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const state = () => lonca.api<AppState>('GET', '/state');
const claudeProfiles = async () => (await state()).profiles.filter((profile) => profile.agent === 'claude');
const placeholderOf = (profile: Profile) => `sk-ant-oat01-lonca-profile-${profile.id.slice('claude-'.length)}-placeholder`;

async function newWorkspace(): Promise<{ workspace: Workspace; lead: Session }> {
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, { model: 'claude-sonnet-5-5', effort: 'low' });
  return { workspace: await lonca.waitForWorkspace(created.workspace.id), lead: created.session };
}

const say = async (page: Page, text: string) => {
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(text);
  await composer.press('Enter');
};

test.beforeAll(async () => {
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  // No key of the project's own, so what reaches the mock is a sign-in's placeholder.
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}` } },
  });
  await lonca.api('PUT', '/profiles/claude/key', { key: 'sk-ant-api03-the-first-sign-in-key' });
});

test.afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('adds a second Claude sign-in, naming both, and signs in to it', async ({ page }) => {
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  const claude = page.getByRole('group', { name: 'Claude sign-ins' });
  await expect(claude.locator('.settings-row')).toHaveCount(1);
  await expect(claude.locator('.settings-row')).toContainText('Using an API key ending in -key');
  // With one, there's nothing to choose between, so nothing to say which.
  await expect(claude.getByRole('button', { name: /options/ })).toHaveCount(0);
  await shot(page, 'one-sign-in');

  await claude.getByRole('button', { name: 'Add another Claude sign-in' }).click();
  const adding = page.getByRole('dialog', { name: 'Add another Claude sign-in' });
  await expect(adding).toContainText('Claude signs in with the account your browser is using on claude.ai');
  await expect(adding).toContainText('Lonca doesn’t check them for you');
  await adding.getByRole('textbox', { name: /Name for the one you have/ }).fill('work');
  await adding.getByRole('textbox', { name: 'Name for the new one' }).fill('personal');
  await shot(page, 'add-sign-in');
  await adding.getByRole('button', { name: 'Add and sign in' }).click();

  const signIn = page.getByRole('dialog', { name: 'Sign in to Claude – personal' });
  await expect(signIn).toBeVisible();
  await signIn.getByRole('tab', { name: 'API key' }).click();
  await signIn.getByRole('textbox', { name: 'API key or token' }).fill('sk-ant-api03-the-second-sign-in-key');
  await signIn.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog', { name: 'Claude – personal is signed in' })).toBeVisible({ timeout: 30000 });

  await expect(claude.locator('.settings-row')).toHaveCount(2);
  await expect(claude.locator('.settings-row').first()).toContainText('Claude – work');
  await expect(claude.locator('.settings-row').first()).toContainText('Default');
  await expect(claude.locator('.settings-row').last()).toContainText('Claude – personal');
  await expect(claude.locator('.settings-row').last()).toContainText('Using an API key ending in -key');
  await expect(page.getByText('Each provider’s terms decide how its accounts may be used')).toBeVisible();
  await shot(page, 'two-sign-ins');

  const profiles = await claudeProfiles();
  expect(profiles.map((profile) => profile.name)).toEqual(['work', 'personal']);
  // Its credential is kept on this computer, apart from the first one's, and never in state.json.
  const secrets = JSON.parse(fs.readFileSync(path.join(lonca.home, 'secrets.json'), 'utf8'));
  expect(secrets.claudeToken).toBe('sk-ant-api03-the-first-sign-in-key');
  expect(secrets.claudeTokens[profiles[1].id]).toBe('sk-ant-api03-the-second-sign-in-key');
  expect(fs.readFileSync(path.join(lonca.home, 'boundary', profiles[1].id), 'utf8')).toBe('sk-ant-api03-the-second-sign-in-key');
  expect(fs.readFileSync(path.join(lonca.home, 'state.json'), 'utf8')).not.toContain('sign-in-key');
});

test('chooses a sign-in with the model, and runs on it', async ({ page }) => {
  const [work, personal] = await claudeProfiles();
  const { workspace } = await newWorkspace();
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  expect(session.profileId).toBe(work.id);
  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  await page.getByRole('tab').filter({ hasText: 'Untitled' }).getByRole('button').first().click();
  const picker = page.locator('.composer-bar .model-button');
  await expect(picker).toContainText('Sonnet 5.5');
  await expect(picker).toContainText('work');
  await picker.click();
  const signIns = page.getByRole('group', { name: 'Sign-in' });
  await expect(signIns.getByRole('button')).toHaveText([/work/, /personal\s*API key/]);
  await shot(page, 'picker-two-sign-ins');
  await signIns.getByRole('button', { name: /personal/ }).click();
  await expect(picker).toContainText('personal');
  await expect.poll(async () => (await lonca.session(session.id)).profileId).toBe(personal.id);

  const before = mock.requests.length;
  await say(page, 'WHICH-SIGN-IN');
  await lonca.waitForIdle(session.id);
  const sent = mock.requests.slice(before).findLast((request) => request.body.includes('WHICH-SIGN-IN'));
  expect(sent?.auth).toBe(placeholderOf(personal));
});

test('a usage limit offers to carry on on another sign-in, and the conversation goes with it', async ({ page }) => {
  const [work, personal] = await claudeProfiles();
  const { workspace, lead } = await newWorkspace();
  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  await say(page, 'first, on work');
  await expect(page.locator('.result-row')).toHaveCount(1, { timeout: 60000 });
  mock.limitedAuth.add(FIRST_PLACEHOLDER);
  try {
    await say(page, 'second');
    const banner = page.locator('.workspace-banner');
    await expect(banner).toContainText('Claude – work reached its usage limit, so the Lead is paused.', { timeout: 60000 });
    await expect(page.locator('.lead-tab .tab-state-limit')).toBeVisible();
    await expect.poll(async () => (await state()).system.profiles[work.id].limitedAt).toBeGreaterThan(0);
    await expect(banner.getByRole('button', { name: 'Use another model' })).toBeVisible();
    await shot(page, 'limit-continue');
    const before = mock.requests.length;
    await banner.getByRole('button', { name: 'Continue on Claude – personal (billed per token)' }).click();
    await expect(page.locator('.notice').filter({ hasText: 'Moved from Claude – work to Claude – personal because Claude – work reached its usage limit.' })).toBeVisible({ timeout: 30000 });
    await expect.poll(async () => (await lonca.session(lead.id)).lastOutcome, { timeout: 60000 }).toBe('completed');
    await expect(banner).toHaveCount(0);
    const continued = mock.requests.slice(before).findLast((request) => request.body.includes('Continue where you left off'));
    expect(continued?.auth).toBe(placeholderOf(personal));
    // The same conversation, on the other sign-in.
    expect(continued?.body).toContain('first, on work');
    expect((await lonca.workspace(workspace.id)).lead?.profileId).toBe(personal.id);
  } finally {
    mock.limitedAuth.delete(FIRST_PLACEHOLDER);
  }

  // The Lead's model is locked, but its sign-in isn't.
  await page.locator('.composer-bar .model-button').click();
  await expect(page.getByText('You can move it to another Claude sign-in. The conversation so far goes with it.')).toBeVisible();
  await shot(page, 'locked-model-sign-ins');
});

test('moves a conversation at its limit by itself to a sign-in chosen for that, and says so', async ({ page }) => {
  const [work, personal] = await claudeProfiles();
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  const card = page.locator('.sign-in-card').filter({ hasText: 'Claude – personal' });
  const allow = card.getByRole('checkbox', { name: /Move conversations here by themselves/ });
  await expect(allow).not.toBeChecked();
  await expect(card).toContainText('This one is an API key, so that’s billed per token.');
  await allow.check();
  await expect.poll(async () => (await claudeProfiles()).find((profile) => profile.id === personal.id)?.autoSwitch).toBe(true);
  await shot(page, 'auto-switch-on');

  const { workspace } = await newWorkspace();
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', profileId: work.id });
  mock.limitedAuth.add(FIRST_PLACEHOLDER);
  try {
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('tab').filter({ hasText: 'Untitled' }).getByRole('button').first().click();
    const before = mock.requests.length;
    await say(page, 'AUTO-SWITCHED');
    await expect(page.locator('.notice').filter({ hasText: 'Lonca moved this to Claude – personal because Claude – work reached its usage limit. You chose this in Settings.' })).toBeVisible({ timeout: 60000 });
    await expect.poll(async () => (await lonca.session(session.id)).lastOutcome, { timeout: 60000 }).toBe('completed');
    await expect(page.locator('.workspace-banner')).toHaveCount(0);
    const answered = mock.requests.slice(before).findLast((request) => request.body.includes('AUTO-SWITCHED') && request.auth === placeholderOf(personal));
    expect(answered).toBeTruthy();
    expect((await lonca.session(session.id)).profileId).toBe(personal.id);
    await shot(page, 'auto-switched');
  } finally {
    mock.limitedAuth.delete(FIRST_PLACEHOLDER);
  }
});
