import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Lonca, git, makeFixtureRepo, until } from '../support/harness.ts';

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
