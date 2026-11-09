// The trash icons that close a workspace, in the browser against a real server and real sandboxes.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { AppState, Project, Workspace } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, sandboxExec, sandboxRunning, until } from '../support/harness.ts';

const lonca = new Lonca({ port: 48371, instance: 'workspace-close-ui', firstWorkspacePort: 56300 });
let fixture: string;
let project: Project;

async function create(title?: string): Promise<Workspace> {
  const made = await lonca.api<{ workspace: Workspace }>('POST', `/projects/${project.id}/workspaces`, {});
  const workspace = await lonca.waitForWorkspace(made.workspace.id);
  if (title) await lonca.api('PATCH', `/workspaces/${workspace.id}`, { title });
  return workspace;
}

const workspaceUrl = (workspace: Workspace) => `${lonca.url}/w/${workspace.id}`;
const opened = (workspace: Workspace) => `${workspaceUrl(workspace)}?token=${lonca.token}`;

async function expectGone(workspace: Workspace): Promise<void> {
  await until(`${workspace.name} to go`, async () => (await lonca.workspace(workspace.id)) === undefined, 60000);
  expect(sandboxRunning(workspace.sandboxName)).toBeNull();
  expect(fs.existsSync(workspace.path)).toBe(false);
}

/** Leaves a workspace in the failed state of an operation that couldn't reach Docker Sandboxes. */
async function failWithoutSandboxes(operation: () => Promise<unknown>): Promise<void> {
  await lonca.kill();
  lonca.setOffline(true);
  await lonca.start();
  try {
    await expect(operation()).rejects.toThrow();
  } finally {
    await lonca.kill();
    lonca.setOffline(false);
    await lonca.start();
  }
}

test.beforeAll(async () => {
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.api<Project>('POST', '/projects', { path: fixture });
  await lonca.waitForProject(project.id);
});

test.afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('archives another workspace from its sidebar row, then deletes it, without leaving this one', async ({ page }) => {
  const here = await create();
  const other = await create('Is this working');
  fs.writeFileSync(path.join(other.path, 'new.txt'), 'uncommitted\n');
  await page.goto(opened(here));

  const row = page.locator('.workspace-row').filter({ hasText: 'Is this working' });
  const trash = row.getByRole('button', { name: `Archive “Is this working” (${other.name})` });
  await expect(trash).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(trash).toHaveCSS('opacity', '1');

  await trash.click();
  const dialog = page.getByRole('dialog', { name: 'Archive this workspace?' });
  await expect(dialog).toContainText('Is this working');
  await expect(dialog).toContainText(other.branch);
  await expect(dialog).toContainText('1 uncommitted change is lost.');
  await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect((await lonca.workspace(other.id)).status).toBe('ready');

  await row.hover();
  await trash.click();
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('button', { name: '1 archived' })).toBeVisible({ timeout: 60000 });
  await expect(page).toHaveURL(workspaceUrl(here));
  expect(sandboxRunning(other.sandboxName)).toBeNull();
  expect(fs.existsSync(other.path)).toBe(false);

  // Deleting for good happens from the archived list.
  await page.getByRole('button', { name: '1 archived' }).click();
  await row.hover();
  await row.getByRole('button', { name: `Delete “Is this working” (${other.name})` }).click();
  const deleting = page.getByRole('dialog', { name: 'Delete this workspace?' });
  await expect(deleting.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  await deleting.getByRole('button', { name: 'Delete permanently' }).click();
  await expectGone(other);
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(workspaceUrl(here));
});

test('archives the workspace on screen from the header, then deletes it', async ({ page }) => {
  const workspace = await create();
  await page.goto(opened(workspace));
  const header = page.locator('.workspace-header');

  // The trash icon is the one way to close it, and stopping isn't offered at all.
  await header.getByRole('button', { name: 'Workspace options' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Rebuild virtual machine', 'Project settings']);
  await page.keyboard.press('Escape');

  await header.getByRole('button', { name: 'Archive this workspace' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No uncommitted changes.');
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click();

  // Archiving stays put: the banner has its progress and the way back.
  await expect(page.locator('.workspace-banner')).toContainText('archived', { timeout: 60000 });
  await expect(page).toHaveURL(workspaceUrl(workspace));
  expect(sandboxRunning(workspace.sandboxName)).toBeNull();

  await header.getByRole('button', { name: 'Delete this workspace' }).click();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page).toHaveURL(`${lonca.url}/`);
  await expectGone(workspace);
});

test('archives without asking once told not to ask, until Settings asks again', async ({ page }) => {
  const here = await create('Stays open');
  const first = await create('Asked once');
  const second = await create('From the sidebar');
  const third = await create('From the header');
  const confirmArchive = async () => (await lonca.api<AppState>('GET', '/state')).settings.confirmArchive;
  try {
    await page.goto(opened(here));
    const row = (title: string) => page.locator('.workspace-row').filter({ hasText: title });
    const header = page.locator('.workspace-header');
    const dialog = page.getByRole('dialog', { name: 'Archive this workspace?' });
    const stopAsking = dialog.getByRole('checkbox', { name: 'Don’t ask again' });
    const trash = async (title: string, workspace: Workspace) => {
      await row(title).hover();
      await row(title).getByRole('button', { name: `Archive “${title}” (${workspace.name})` }).click();
    };

    // Ticking the box and then cancelling leaves things as they were.
    await trash('Asked once', first);
    await expect(stopAsking).not.toBeChecked();
    await stopAsking.check();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await confirmArchive()).toBe(true);

    await trash('Asked once', first);
    await expect(stopAsking).not.toBeChecked();
    await stopAsking.check();
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
    await lonca.waitForWorkspace(first.id, 'archived');
    expect(await confirmArchive()).toBe(false);

    // The server keeps it, so a page loaded afresh doesn't ask either. Nothing would press Archive
    // in a dialog, so archiving finishing shows that none was in the way.
    await page.reload();
    await trash('From the sidebar', second);
    await lonca.waitForWorkspace(second.id, 'archived');
    expect(sandboxRunning(second.sandboxName)).toBeNull();
    expect(fs.existsSync(second.path)).toBe(false);
    await expect(page).toHaveURL(workspaceUrl(here));

    await row('From the header').getByRole('link').click();
    await header.getByRole('button', { name: 'Archive this workspace' }).click();
    await lonca.waitForWorkspace(third.id, 'archived');
    await expect(page.locator('.workspace-banner')).toContainText('archived');
    await expect(page).toHaveURL(workspaceUrl(third));
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Deleting for good still asks, with nothing to tick.
    await header.getByRole('button', { name: 'Delete this workspace' }).click();
    const deleting = page.getByRole('dialog', { name: 'Delete this workspace?' });
    await expect(deleting.getByRole('button', { name: 'Delete permanently' })).toBeVisible();
    await expect(deleting.getByRole('checkbox')).toHaveCount(0);
    await deleting.getByRole('button', { name: 'Cancel' }).click();
    await expect(deleting).toBeHidden();
    expect((await lonca.workspace(third.id)).status).toBe('archived');

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const ask = page.getByRole('switch', { name: 'Ask before archiving', exact: true });
    await expect(ask).toHaveAttribute('aria-checked', 'false');
    await ask.click();
    await expect(ask).toHaveAttribute('aria-checked', 'true');
    expect(await confirmArchive()).toBe(true);

    await row('Stays open').getByRole('link').click();
    await header.getByRole('button', { name: 'Archive this workspace' }).click();
    await expect(stopAsking).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await lonca.workspace(here.id)).status).toBe('ready');
  } finally {
    // The other tests here expect to be asked.
    await lonca.api('PATCH', '/settings', { confirmArchive: true });
  }
});

test('asks anyway, with a warning, when there’s something to lose', async ({ page }) => {
  const changed = await create('Has changes');
  const stopped = await create('Stopped');
  const busy = await create('Agent at work');
  fs.writeFileSync(path.join(changed.path, 'new.txt'), 'uncommitted\n');
  // An agent can hide new files from git status, and they still count. Every workspace shares this
  // setting, and this one's VM is still there to undo it at the end.
  const gitConfig = (args: string) => expect(sandboxExec(busy.sandboxName, `cd '${busy.path}' && git config ${args}`).code).toBe(0);
  gitConfig('status.showUntrackedFiles no');
  await lonca.api('POST', `/workspaces/${stopped.id}/stop`);
  await lonca.api('PATCH', '/settings', { confirmArchive: false });
  try {
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      for (const session of state.sessions) if (session.workspaceId === busy.id) session.status = 'running';
      await route.fulfill({ response, json: state });
    });
    await page.goto(opened(changed));
    const row = (title: string) => page.locator('.workspace-row').filter({ hasText: title });
    const trash = page.locator('.workspace-header').getByRole('button', { name: 'Archive this workspace' });
    const dialog = page.getByRole('dialog', { name: 'Archive this workspace?' });
    const warnings = dialog.locator('.close-warning');

    // Not being asked has already been chosen, so there's nothing to tick.
    await trash.click();
    await expect(warnings).toHaveText(['1 uncommitted change is lost.']);
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // A stopped one isn't woken to count them.
    await row('Stopped').hover();
    await row('Stopped').getByRole('button', { name: `Archive “Stopped” (${stopped.name})` }).click();
    await expect(warnings).toHaveText(['Any uncommitted changes are lost. They can’t be counted while it isn’t running.']);
    expect(sandboxRunning(stopped.sandboxName)).toBe(false);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await row('Agent at work').hover();
    await row('Agent at work').getByRole('button', { name: `Archive “Agent at work” (${busy.name})` }).click();
    await expect(warnings).toHaveText(['An agent is working here and will be stopped.']);
    await expect(dialog).toContainText('No uncommitted changes.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Archive still archives, and leaves the choice as it was.
    await trash.click();
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
    await lonca.waitForWorkspace(changed.id, 'archived');
    expect((await lonca.api<AppState>('GET', '/state')).settings.confirmArchive).toBe(false);
    expect((await lonca.workspace(stopped.id)).status).toBe('stopped');
    expect((await lonca.workspace(busy.id)).status).toBe('ready');
  } finally {
    // The other tests here expect to be asked, and to see new files.
    await lonca.api('PATCH', '/settings', { confirmArchive: true });
    gitConfig('--unset status.showUntrackedFiles');
  }
});

test('warns of an agent that only the server knows is working', async ({ page }) => {
  const workspace = await create();
  await lonca.api('PATCH', '/settings', { confirmArchive: false });
  try {
    // A page that has fallen behind still shows the agent as idle.
    await page.route('**/api/workspaces/*/archive', (route) => route.fulfill({ json: { ask: true, agentWorking: true } }));
    await page.goto(opened(workspace));
    await page.getByRole('button', { name: 'Archive this workspace' }).click();
    await expect(page.getByRole('dialog').locator('.close-warning')).toHaveText(['An agent is working here and will be stopped.']);
    expect((await lonca.workspace(workspace.id)).status).toBe('ready');
  } finally {
    await lonca.api('PATCH', '/settings', { confirmArchive: true });
  }
});

test('doesn’t wake a stopped workspace to count its changes', async ({ page }) => {
  const workspace = await create();
  await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
  await page.goto(opened(workspace));

  await page.getByRole('button', { name: 'Archive this workspace' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Any uncommitted changes are lost.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(sandboxRunning(workspace.sandboxName)).toBe(false);
});

test('says when an agent is working', async ({ page }) => {
  const workspace = await create();
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    for (const session of state.sessions) if (session.workspaceId === workspace.id) session.status = 'running';
    await route.fulfill({ response, json: state });
  });
  await page.goto(opened(workspace));

  await page.getByRole('button', { name: 'Archive this workspace' }).click();
  await expect(page.getByRole('dialog')).toContainText('An agent is working here and will be stopped.');
});

test('offers nothing while a workspace is changing state', async ({ page }) => {
  const workspace = await create('Changing state');
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    for (const entry of state.workspaces) if (entry.id === workspace.id) entry.status = 'starting';
    await route.fulfill({ response, json: state });
  });
  await page.goto(opened(workspace));

  await expect(page.locator('.workspace-banner')).toContainText('Starting');
  await expect(page.getByRole('button', { name: 'Archive this workspace' })).toBeDisabled();
  await expect(page.locator('.workspace-row').filter({ hasText: 'Changing state' }).getByRole('button')).toHaveCount(0);
});

test('keeps Archive as a way out of a failed operation, and restores from it', async ({ page }) => {
  const workspace = await create();
  await failWithoutSandboxes(() => lonca.api('POST', `/workspaces/${workspace.id}/recreate`));
  expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: 'rebuild' });
  await page.goto(opened(workspace));

  await page.getByRole('button', { name: 'Archive this workspace' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Any uncommitted changes are lost.');
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
  const banner = page.locator('.workspace-banner');
  await expect(banner).toContainText('archived', { timeout: 60000 });
  expect(sandboxRunning(workspace.sandboxName)).toBeNull();

  await banner.getByRole('button', { name: 'Restore' }).click();
  await lonca.waitForWorkspace(workspace.id);
  expect(fs.existsSync(path.join(workspace.path, 'README.md'))).toBe(true);
});

for (const operation of ['archive', 'delete'] as const) {
  test(`offers Delete as the way out of a failed ${operation}`, async ({ page }) => {
    const workspace = await create();
    await failWithoutSandboxes(() => operation === 'delete'
      ? lonca.api('DELETE', `/workspaces/${workspace.id}`)
      : lonca.api('POST', `/workspaces/${workspace.id}/archive`));
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: operation });
    await page.goto(opened(workspace));

    await page.getByRole('button', { name: 'Delete this workspace' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this workspace?' });
    await expect(dialog.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page).toHaveURL(`${lonca.url}/`);
    await expectGone(workspace);
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('reaches the trash icons without hovering', async ({ page }) => {
    const here = await create();
    const other = await create('Is this working');
    await page.goto(opened(here));

    // The header drops what a phone can't use so that the trash icon fits.
    await expect(page.getByRole('button', { name: 'Open this workspace elsewhere' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Archive this workspace' })).toBeInViewport();

    await page.getByRole('button', { name: 'Show the sidebar' }).tap();
    const trash = page.getByRole('button', { name: `Archive “Is this working” (${other.name})` });
    await expect(trash).toHaveCSS('opacity', '1');
    expect(await trash.boundingBox()).toMatchObject({ width: 44, height: 44 });
    await expect(page.getByRole('button', { name: `${project.name} options` })).toHaveCSS('opacity', '1');

    await trash.tap();
    const dialog = page.getByRole('dialog', { name: 'Archive this workspace?' });
    const [archive, cancel] = await Promise.all(['Archive', 'Cancel'].map(async (name) => {
      const box = await dialog.getByRole('button', { name, exact: true }).boundingBox();
      expect(box?.height).toBe(44);
      return box!.y;
    }));
    expect(archive).toBeLessThan(cancel);
    // Cancel stays nearest the thumb, and the box above the buttons is as easy to hit.
    const stopAsking = await dialog.locator('label').filter({ has: page.getByRole('checkbox', { name: 'Don’t ask again' }) }).boundingBox();
    expect(stopAsking?.height).toBe(44);
    expect(stopAsking!.y).toBeLessThan(archive);
    await dialog.getByRole('button', { name: 'Cancel' }).tap();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(workspaceUrl(here));
  });

  test('a double tap on the trash icon can’t land on what opens under it', async ({ page }) => {
    const here = await create();
    await page.goto(opened(here));
    await page.getByRole('button', { name: 'Archive this workspace' }).waitFor();

    const reachable = await page.evaluate(`(async () => {
      document.querySelector('button[aria-label="Archive this workspace"]').click();
      await new Promise(requestAnimationFrame);
      const button = [...document.querySelectorAll('.modal-actions .button')].find((entry) => entry.textContent === 'Archive');
      const box = button.getBoundingClientRect();
      const underFinger = () => document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
      const atFirst = underFinger();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { atFirst, afterAMoment: underFinger() };
    })()`);
    expect(reachable).toEqual({ atFirst: false, afterAMoment: true });
  });
});
