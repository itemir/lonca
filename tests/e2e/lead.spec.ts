import fs from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Project, Session, Workspace } from '../../shared/types.ts';
import { Lonca, REPO_ROOT, sandboxExec, makeFixtureRepo, until } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 47421, instance: 'e2e-lead', firstWorkspacePort: 46900 });
const SHOTS = path.join(REPO_ROOT, 'test-results', 'lead');
let mock: MockLlm;
let fixture: string;
let project: Project;

const spawn = (label: string, task: string, extra: Record<string, unknown> = {}) =>
  `TOOL: spawn_agent ${JSON.stringify({ label, task, model: 'claude-sonnet-5-5', job: 'analyze', ...extra })}`;

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function newWorkspace(options: Record<string, unknown> = {}): Promise<{ workspace: Workspace; lead: Session }> {
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, options);
  const workspace = await lonca.waitForWorkspace(created.workspace.id);
  sandboxExec(workspace.sandboxName, `cat > ~/.codex/config.toml <<EOF
cli_auth_credentials_store = "file"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://host.docker.internal:${mock.port}/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
supports_websockets = false
EOF`);
  return { workspace, lead: created.session };
}

const open = async (page: Page, workspace: Workspace) => {
  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  await expect(page.locator('.lead-tab')).toBeVisible();
};

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
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: {
      network: 'host',
      env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock', OPENAI_API_KEY: 'sk-mock', MOCK_KEY: 'sk-mock' },
    },
  });
});

test.afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('a new workspace opens on its Lead, whose model locks with the first message', async ({ page }) => {
  const { workspace } = await newWorkspace();
  await open(page, workspace);
  await expect(page.locator('.lead-tab')).toHaveClass(/active/);
  await expect(page.getByText('Your Lead is ready.')).toBeVisible();
  await expect(page.getByText('The Lead’s model locks when you send the first message.')).toBeVisible();
  await expect(page.locator('.lead-tab').getByRole('button', { name: 'Rename this tab' })).toHaveCount(0);
  await shot(page, 'lead-before-first-message');

  await page.locator('.model-button').click();
  await page.getByRole('button', { name: 'Sonnet 5.5' }).click();
  await page.getByRole('button', { name: 'Low', exact: true }).click();
  await expect(page.locator('.model-button')).toContainText('Sonnet 5.5');
  await expect.poll(async () => (await lonca.workspace(workspace.id)).lead?.model).toBe('claude-sonnet-5-5');
  const settings = (await lonca.api('GET', '/state')).settings;
  expect(settings.leadDefault.model).toBe('claude-opus-5-5');

  await say(page, 'hello');
  await expect(page.locator('.result-row')).toHaveCount(1, { timeout: 60000 });
  await expect(page.getByText('The Lead’s model locks when you send the first message.')).toHaveCount(0);
  await page.locator('.model-button').click();
  await expect(page.getByText('The Lead stays on Sonnet 5.5 Low for this workspace.')).toBeVisible();
  await expect(page.locator('.model-popover')).toHaveCount(0);
  await shot(page, 'lead-locked');
});

test('agents appear in tabs, and everything between them goes through the Lead', async ({ page }) => {
  const { workspace, lead } = await newWorkspace();
  await open(page, workspace);
  await say(page, [
    spawn('Analysis', 'SLOW Find the root cause. Report how sure you are.', { effort: 'max' }),
    spawn('Analysis', 'SLOW Find the root cause. Report how sure you are.', { model: 'gpt-5.5', effort: 'low' }),
  ].join('\n'));

  const agentTabs = page.locator('.team-tab:not(.lead-tab)');
  await expect(agentTabs).toHaveCount(2, { timeout: 60000 });
  await expect(agentTabs.first()).toContainText('Sonnet 5.5');
  await expect(agentTabs.last()).toContainText('GPT-5.5');
  await expect(page.locator('.team-card .team-row')).toHaveCount(2);
  await expect(page.locator('.tool').filter({ hasText: 'Started Analysis' })).toHaveCount(2);
  await expect(page.getByText(/Waiting for 2 agents/)).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('button', { name: 'Stop the agents' })).toBeVisible();
  await shot(page, 'lead-delegating');

  // The sidebar and the agent's tab agree that it's at work.
  await page.locator('.team-card .team-row').first().click();
  await expect(agentTabs.first()).toHaveClass(/active/);
  await expect(page.locator('.user-message.from-lead')).toContainText('Find the root cause');
  await expect(page.locator('.user-message.from-lead')).toContainText('From Lead');
  await expect(page.getByText('You’re in a new copy of')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', /Message this agent directly/);
  await page.locator('.model-button').click();
  await expect(page.getByText(/The Lead chose Sonnet 5.5 Max for this agent/)).toBeVisible();
  await page.keyboard.press('Escape');
  await shot(page, 'agent-tab');

  // They finish, the Lead is woken, and what it was told isn't shown as if the user wrote it.
  await page.locator('.lead-tab').getByRole('button', { name: 'Lead', exact: true }).click();
  await expect(page.locator('.wake-row')).toContainText('2 agents finished', { timeout: 90000 });
  await expect(page.locator('.user-text').filter({ hasText: 'Update from Lonca' })).toHaveCount(0);
  await expect(page.locator('.team-card')).toHaveCount(0);
  await shot(page, 'lead-woken');

  // Nobody has read what they found, until someone looks.
  await expect.poll(async () => (await lonca.session((await lonca.api('GET', '/state')).sessions.find((session: Session) => session.workspaceId === workspace.id && session.role === 'agent').id)).unread).toBe(true);
  await expect(agentTabs.first().locator('.unread-dot')).toBeVisible();
  await agentTabs.first().getByRole('button').first().click();
  await expect(agentTabs.first().locator('.unread-dot')).toHaveCount(0);

  // A Lead that's finished and been read needs nothing; one that's finished unread does.
  await expect.poll(async () => (await lonca.session(lead.id)).unread).toBe(true);
  await expect(page.locator('.workspace-row.active .unread-dot')).toBeVisible();
  await expect(page).toHaveTitle('● Lonca');
  await page.locator('.lead-tab').getByRole('button', { name: 'Lead', exact: true }).click();
  await expect.poll(async () => (await lonca.session(lead.id)).unread).toBe(false);
  await expect(page.locator('.workspace-row.active .unread-dot')).toHaveCount(0);
});

test('hovering a tab to close it leaves every tab where it was', async ({ page }) => {
  const { workspace } = await newWorkspace();
  await open(page, workspace);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.locator('.session-tab:not(.team-tab)')).toHaveClass(/active/);
  await page.mouse.move(0, 0);

  const places = () => page.locator('.tab-bar > *').evaluateAll((elements) => elements.map((element) => {
    const { x, width } = element.getBoundingClientRect();
    return { tab: element.textContent, x, width };
  }));
  const resting = await places();
  for (const tab of await page.locator('.tab-bar .session-tab').all()) {
    await tab.hover();
    await expect(tab.locator('.tab-close')).toHaveCSS('opacity', '1');
    expect(await places()).toEqual(resting);
  }
  await shot(page, 'tab-hover');
});

test('stopping the agents holds them, and shows it', async ({ page }) => {
  const { workspace, lead } = await newWorkspace();
  await open(page, workspace);
  await say(page, spawn('Stoppable', 'SLOW Take your time.'));
  await expect(page.getByText(/Waiting for 1 agent/)).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Stop the agents' }).click();
  await expect(page.locator('.tab-state-stopped')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.team-card')).toHaveCount(0);
  expect((await lonca.session(lead.id)).status).toBe('idle');
});

test('closing the Lead leaves its conversation readable, and a new one takes over', async ({ page }) => {
  const { workspace } = await newWorkspace({ model: 'claude-sonnet-5-5', effort: 'low' });
  await open(page, workspace);
  await say(page, spawn('Survivor', 'SLOW Keep going.'));
  await expect(page.getByText(/Waiting for 1 agent/)).toBeVisible({ timeout: 60000 });

  await page.locator('.lead-tab').hover();
  await page.getByRole('button', { name: 'Close Lead' }).click();
  const dialog = page.getByRole('dialog', { name: 'Close the Lead?' });
  await expect(dialog).toContainText('1 agent is still working');
  await expect(dialog).toContainText('stays on Sonnet 5.5 Low');
  await shot(page, 'close-lead');
  await dialog.getByRole('button', { name: 'Keep them working' }).click();
  await expect(page.locator('.lead-tab')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Lead', exact: true })).toBeVisible();
  await expect(page.locator('.team-tab')).toHaveCount(1);
  await shot(page, 'no-lead');

  await page.getByRole('button', { name: 'Workspace options' }).click();
  await page.getByRole('menuitem', { name: /Read the Lead closed/ }).click();
  await expect(page.getByRole('tab', { name: /Earlier Lead/ })).toBeVisible();
  await expect(page.getByText('This Lead was closed')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
  await expect(page.locator('.tool').filter({ hasText: 'Started Survivor' })).toBeVisible();
  await shot(page, 'earlier-lead');

  await page.getByRole('button', { name: 'New Lead', exact: true }).click();
  await expect(page.locator('.lead-tab')).toHaveClass(/active/);
  await say(page, 'what do I have?');
  await expect(page.getByText(/What this Lead was told/)).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.notice').filter({ hasText: 'What this Lead was told' })).toContainText('Survivor');
  await expect(page.locator('.model-button')).toContainText('Sonnet 5.5');
  await expect(page.locator('.lead-tab')).toHaveCount(1);
});

test('a usage limit pauses the Lead, with a way to try again or move to another model', async ({ page }) => {
  const { workspace, lead } = await newWorkspace({ model: 'claude-sonnet-5-5' });
  await open(page, workspace);
  await say(page, 'first');
  await expect(page.locator('.result-row')).toHaveCount(1, { timeout: 60000 });
  mock.limited.add('claude-sonnet-5-5');
  try {
    await say(page, 'second');
    await expect(page.locator('.workspace-banner')).toContainText('usage limit was reached, so the Lead is paused', { timeout: 60000 });
    await expect(page.locator('.lead-tab .tab-state-limit')).toBeVisible();
    await expect(page.locator('.workspace-row.active .tab-state-limit')).toBeVisible();
    await shot(page, 'limit');
    await page.locator('.workspace-banner').getByRole('button', { name: 'Use another model' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move the Lead to another model' });
    await expect(dialog.getByRole('button', { name: 'Move the Lead' })).toBeDisabled();
    await dialog.locator('.model-button').click();
    await dialog.getByRole('button', { name: 'Opus 5.5' }).click();
    await dialog.getByRole('button', { name: 'High', exact: true }).click();
    await dialog.getByRole('button', { name: 'Move the Lead' }).click();
  } finally {
    mock.limited.delete('claude-sonnet-5-5');
  }
  await expect(page.getByText(/The Lead moved from Sonnet 5.5 to Opus 5.5/)).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.model-button')).toContainText('Opus 5.5');
  await expect.poll(async () => (await lonca.session(lead.id)).lastOutcome, { timeout: 60000 }).toBe('completed');
  await expect(page.locator('.workspace-banner')).toHaveCount(0);

  // Moving to another provider starts a new Lead, and that's the one on screen afterwards.
  mock.limited.add('claude-opus-5-5');
  try {
    await say(page, 'third');
    await expect(page.locator('.workspace-banner')).toContainText('usage limit was reached', { timeout: 60000 });
    await page.locator('.workspace-banner').getByRole('button', { name: 'Use another model' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move the Lead to another model' });
    await dialog.locator('.model-button').click();
    await dialog.locator('.model-popover .menu-item').filter({ hasText: 'GPT-5.5' }).click();
    await expect(dialog).toContainText('a new Lead takes over');
    await dialog.getByRole('button', { name: 'Low', exact: true }).click();
    await dialog.getByRole('button', { name: 'Move the Lead' }).click();
  } finally {
    mock.limited.delete('claude-opus-5-5');
  }
  await expect(page.locator('.notice').filter({ hasText: 'What this Lead was told' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.lead-tab')).toHaveClass(/active/);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(page.locator('.model-button')).toContainText('GPT-5.5');
});

test('a replacement Lead shows its retired locked model and can move to an available one', async ({ page }) => {
  const { workspace, lead } = await newWorkspace({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  await lonca.api('POST', `/sessions/${lead.id}/messages`, { text: 'Lock the Lead model with a completed turn.' });
  await lonca.waitForIdle(lead.id);
  await lonca.api('POST', `/sessions/${lead.id}/close`, {});
  await lonca.stop();
  const stateFile = path.join(lonca.home, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { workspaces: Workspace[] };
  const retired = 'claude-retired-test-model';
  // A previously available model can disappear while a workspace keeps its locked choice.
  state.workspaces.find((entry) => entry.id === workspace.id)!.lead!.model = retired;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await lonca.start();

  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  await page.getByRole('button', { name: 'Start a new Lead', exact: true }).click();
  await expect(page.locator('.composer-bar .model-button')).toContainText(retired);
  await expect(page.locator('.workspace-banner')).toContainText('is no longer available');
  await expect(page.getByRole('button', { name: 'Use another model' })).toBeVisible();
  await shot(page, 'replacement-lead-retired');
  await page.reload();
  await expect(page.locator('.composer-bar .model-button')).toContainText(retired);
  await page.getByRole('button', { name: 'Use another model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move the Lead to another model' });
  await dialog.locator('.model-button').click();
  await dialog.getByRole('button', { name: 'Sonnet 5.5' }).click();
  await dialog.getByRole('button', { name: 'Low', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move the Lead' }).click();
  await expect(page.locator('.composer-bar .model-button')).toContainText('Sonnet 5.5');
  await expect(page.locator('.workspace-banner')).toHaveCount(0);
  await say(page, 'Continue with the available model.');
  await expect(page.locator('.user-message').last()).toContainText('Continue with the available model.');
  const current = (await lonca.api<{ sessions: Session[] }>('GET', '/state')).sessions.find((entry) => entry.workspaceId === workspace.id && entry.role === 'lead' && !entry.closedAt)!;
  await lonca.waitForIdle(current.id);
  expect(await lonca.session(current.id)).toMatchObject({ model: 'claude-sonnet-5-5', lastOutcome: 'completed' });
  await expect(page.locator('.result-row').last()).toBeVisible();
  await shot(page, 'replacement-lead-recovered');
});

test('the default Lead and playbook are set in Settings, and a project can have its own', async ({ page }) => {
  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  await expect(page.getByRole('heading', { name: 'Sign-ins' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Agents at once' }).selectOption('3');
  await expect.poll(async () => (await lonca.api('GET', '/state')).settings.leadMaxAgents).toBe(3);
  await page.getByRole('button', { name: 'Edit playbook' }).click();
  const editor = page.getByRole('textbox', { name: 'Lead playbook' });
  await expect(editor).toHaveValue(/You answer to the user for the outcome/);
  await expect(page.getByRole('button', { name: 'Reset to the template' })).toHaveCount(0);
  await shot(page, 'settings-lead');
  await editor.fill('# Mine\n\nAlways ask first.');
  await page.getByRole('button', { name: 'Save playbook' }).click();
  await expect(page.locator('.toast')).toContainText('Leads follow it from their next turn');
  await expect(page.getByRole('button', { name: 'Reset to the template' })).toBeVisible();
  expect(fs.readFileSync(path.join(lonca.home, 'lead.md'), 'utf8')).toContain('Always ask first');

  await page.goto(`${lonca.url}/projects/${project.id}?token=${lonca.token}`);
  const projectEditor = page.getByRole('textbox', { name: 'Lead playbook' });
  await expect(projectEditor).toHaveValue(/Always ask first/);
  await expect(page.getByText('This project uses the playbook from Settings.')).toBeVisible();
  await projectEditor.fill('# Just this project');
  await page.getByRole('button', { name: 'Save playbook' }).click();
  await expect(page.getByText('This project has its own playbook')).toBeVisible();
  await shot(page, 'project-playbook');
  await page.getByRole('button', { name: 'Use the default' }).click();
  await expect(projectEditor).toHaveValue(/Always ask first/);

  await page.goto(`${lonca.url}/settings?token=${lonca.token}`);
  await page.getByRole('button', { name: 'Edit playbook' }).click();
  await page.getByRole('button', { name: 'Reset to the template' }).click();
  await expect(page.getByRole('textbox', { name: 'Lead playbook' })).toHaveValue(/You answer to the user for the outcome/);
  await lonca.api('PATCH', '/settings', { leadMaxAgents: 4 });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test('moves between the Lead and its agents from a list instead of tabs', async ({ page }) => {
    const { workspace } = await newWorkspace();
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(page.locator('.tab-bar')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message' })).not.toBeFocused();
    await shot(page, 'phone-new-lead');

    // Enter is a new line on an on-screen keyboard, and the button sends.
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill(spawn('Analysis', 'SLOW Find the root cause.'));
    await composer.press('Enter');
    await expect(composer).toHaveValue(/\n$/);
    const box = await page.getByRole('button', { name: 'Send' }).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'Send' }).tap();

    const strip = page.locator('.team-strip');
    await expect(strip).toContainText('1 agent working', { timeout: 60000 });
    await shot(page, 'phone-lead-delegating');
    await strip.tap();
    const sheet = page.getByRole('dialog', { name: 'Tabs in this workspace' });
    await expect(sheet.locator('.sheet-row')).toHaveCount(2);
    await expect(sheet.getByRole('button', { name: 'Stop the agents' })).toBeVisible();
    await shot(page, 'phone-tabs');
    await sheet.locator('.sheet-row').filter({ hasText: 'Analysis' }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.phone-title')).toContainText('Analysis');
    await expect(page.locator('.user-message.from-lead')).toContainText('Find the root cause');
    await shot(page, 'phone-agent');
    await page.getByRole('button', { name: 'Lead' }).tap();
    await expect(page.locator('.phone-back')).toHaveCount(0);
    await expect(page.locator('.wake-row')).toContainText('Analysis finished', { timeout: 60000 });
    await expect(strip).toHaveCount(0);
    await expect(page.locator('.result-row').last()).toBeVisible({ timeout: 60000 });
    await shot(page, 'phone-lead-finished');

    // Everything a tab bar does has to be possible from the list too.
    await expect(page.locator('.working-row')).toHaveCount(0, { timeout: 60000 });
    await page.getByRole('button', { name: 'Show all tabs' }).tap();
    await sheet.getByRole('button', { name: 'Close Lead' }).tap();
    await page.getByRole('dialog', { name: 'Close the Lead?' }).getByRole('button', { name: 'Close the Lead' }).tap();
    await expect(page.locator('.tab-state-limit, .lead-tab')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show all tabs' }).tap();
    await sheet.getByRole('button', { name: 'New Lead' }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(composer).toHaveAttribute('placeholder', /Tell the Lead what you want done/);
  });
});
