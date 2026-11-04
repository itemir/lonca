import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { Lonca, docker, makeFixtureRepo } from '../support/harness.ts';

test('says why a workspace couldn’t start, and starts it once that’s fixed', async ({ page }) => {
  const lonca = new Lonca({ port: 48299, instance: 'start-failure-ui', firstWorkspacePort: 57000 });
  const fixture = makeFixtureRepo();
  try {
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
    // Starting now has to make a new container, from an image that isn't there.
    docker('rm', '-f', workspace.containerName);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: 'lonca-image-that-does-not-exist:nope' } });
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/start`)).rejects.toThrow();
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    const banner = page.locator('.workspace-banner');
    await expect(banner).toContainText('Could not start the workspace');
    await expect(banner).toContainText('lonca-image-that-does-not-exist');
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: '' } });
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(async () => (await lonca.workspace(workspace.id)).status, { timeout: 60000 }).toBe('ready');
    await expect(page.locator('.workspace-banner')).toHaveCount(0);
  } finally {
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
