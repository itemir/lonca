import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Lonca, git, makeFixtureRepo, until, sleep } from '../support/harness.ts';

test('repository setup scripts can be stopped and rerun from the terminal panel', async ({ page }) => {
  const lonca = new Lonca({ port: 48297, instance: 'setup-ui-test', firstWorkspacePort: 50500 });
  const fixture = makeFixtureRepo();
  try {
    fs.writeFileSync(path.join(fixture, 'lonca.json'), JSON.stringify({ scripts: { setup: 'echo setup-started; sleep 300' } }));
    git(fixture, 'add', '.');
    git(fixture, 'commit', '--quiet', '-m', 'Add repository setup');
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    const made = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(made.workspace.id);
    const status = async () => (await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup')?.status;
    await until('running setup', async () => await status() === 'running');
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByRole('button', { name: 'Stop the setup script', exact: true }).click();
    await expect.poll(status).toBe('error');
    await page.getByRole('button', { name: 'Start the setup script', exact: true }).click();
    await expect.poll(status).toBe('running');
    await expect(page.getByRole('button', { name: 'Stop the setup script', exact: true })).toBeVisible();

    // A surviving script must regain its Stop control after the server loses its TTY handle.
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: "trap '' HUP; sleep 300" } });
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    await lonca.kill();
    await lonca.start();
    await page.reload();
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop the setup script', exact: true })).toBeVisible();
    await expect(page.getByText('its connection was lost')).toHaveCount(0);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: '' } });

    // The stop control must stay available even if the script is removed while running.
    fs.writeFileSync(path.join(workspace.path, 'lonca.json'), '{}');
    await expect.poll(async () => (await lonca.api('GET', `/workspaces/${workspace.id}/scripts`)).setup).toBe(false);
    await page.reload();
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByRole('button', { name: 'Stop the setup script', exact: true }).click();
    await expect.poll(status).toBe('error');
    await expect(page.getByRole('button', { name: 'Start the setup script', exact: true })).toHaveCount(0);
  } finally {
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('shows the Setup tab only for a project with a setup script', async ({ page }) => {
  const lonca = new Lonca({ port: 48375, instance: 'setup-tab-ui', firstWorkspacePort: 59000 });
  const fixture = makeFixtureRepo();
  const setScript = (setupScript: string) => lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript } });
  const scriptsLoaded = () => page.waitForResponse((response) => response.url().endsWith('/scripts'));
  const setupTab = page.getByRole('tab', { name: 'Setup', exact: true });
  const start = page.getByRole('button', { name: 'Start the setup script', exact: true });
  const screen = page.locator('.terminal-view:visible .xterm-rows');
  let project: { id: string };
  try {
    await lonca.start();
    project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    let loaded = scriptsLoaded();
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await loaded;
    await expect(screen).toContainText(workspace.name, { timeout: 20000 });
    await expect(setupTab).toHaveCount(0);
    await expect(page.getByText('Optional:')).toBeVisible();

    // A repository can carry its own, which is found when the panel next looks.
    const config = path.join(workspace.path, 'lonca.json');
    fs.writeFileSync(config, JSON.stringify({ scripts: { setup: 'echo from-repository' } }));
    await page.reload();
    await expect(setupTab).toBeVisible();
    fs.rmSync(config);
    loaded = scriptsLoaded();
    await page.reload();
    await loaded;
    await expect(setupTab).toHaveCount(0);

    // A script in the settings shows straight away. There's nothing to move to a window.
    await setScript('echo from-settings');
    await setupTab.click();
    await expect(page.getByText('No output to show. Press play to run the setup script.')).toBeVisible();
    await expect(page.getByRole('button', { name: /separate window/ })).toHaveCount(0);

    // With nothing left to show, the panel goes back to a terminal.
    await setScript('');
    await expect(setupTab).toHaveCount(0);
    await expect(screen).toContainText(workspace.name);
    await expect(page.getByRole('button', { name: /separate window/ })).toBeVisible();

    await setScript('echo from-settings');
    await setupTab.click();
    await start.click();
    await expect(screen).toContainText('from-settings');
    await expect(page.getByText('Ran the setup script')).toBeVisible();
    await expect(page.getByText('The setup script exited.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0);

    // What ran stays readable after the script is gone, with nothing left to start.
    await setScript('');
    await expect(start).toHaveCount(0);
    await expect(setupTab).toHaveAttribute('aria-selected', 'true');
    await expect(screen).toContainText('from-settings');

    // The chat goes on pointing to the tab when the workspace stops and takes the output with it.
    await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
    await expect(page.getByText('No output to show.', { exact: true })).toBeVisible();
    await expect(setupTab).toBeVisible();
    await expect(page.getByText('Its output is in the Setup tab')).toBeVisible();
  } finally {
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
