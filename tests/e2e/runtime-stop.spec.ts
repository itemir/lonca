import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, sandboxRunning, until, sbx } from '../support/harness.ts';

for (const automaticTerminal of [false, true]) {
  test(`keeps an externally stopped workspace stopped with ${automaticTerminal ? 'automatic terminal creation' : 'an open browser polling'}`, async ({ page }) => {
    const lonca = new Lonca({ port: 48368, instance: 'runtime-stop-ui', firstWorkspacePort: 58400 });
    const fixture = makeFixtureRepo();
    try {
      await lonca.start();
      await until('initial checks', async () => (await lonca.api<AppState>('GET', '/state')).system.agentsChecked);
      const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
      const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
      const url = `${lonca.url}/w/${workspace.id}?token=${lonca.token}`;
      const routePattern = `**/api/workspaces/${workspace.id}/**`;
      if (automaticTerminal) {
        // Isolate the automatic POST: a fix confined to GET requests must fail here.
        await page.route(routePattern, async (route) => {
          if (route.request().method() === 'GET') await route.fulfill({ status: 409, json: { error: 'Read held back by test' } });
          else await route.continue();
        });
      } else {
        await page.goto(url);
        await expect(page.locator('.terminal-view:visible .xterm-rows')).toContainText(workspace.name);
      }
      sbx('stop', workspace.sandboxName);
      expect(sandboxRunning(workspace.sandboxName)).toBe(false);
      if (automaticTerminal) {
        const opening = page.waitForResponse((response) => response.url().endsWith('/terminals') && response.request().method() === 'POST');
        await page.goto(url);
        expect((await opening).status()).toBe(409);
      }
      await expect(page.locator('.workspace-banner')).toContainText('is stopped', { timeout: 15000 });
      // Cover another full polling interval, including stale requests and resizes.
      await page.waitForTimeout(5500);
      expect(sandboxRunning(workspace.sandboxName)).toBe(false);
      if (automaticTerminal) await page.unroute(routePattern);
      await page.locator('.workspace-banner').getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page.locator('.workspace-banner')).toHaveCount(0);
      expect(sandboxRunning(workspace.sandboxName)).toBe(true);
      await expect(page.getByRole('button', { name: 'src', exact: true })).toBeVisible();
    } finally {
      await lonca.destroy();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}
