import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ChangeSet } from '../../shared/types.ts';
import { Lonca, sandboxExec, git, makeFixtureRepo } from '../support/harness.ts';

test('shows rename metadata and only the edited lines of a renamed file', async ({ page }) => {
  const lonca = new Lonca({ port: 48343, instance: 'rename-diff-test', firstWorkspacePort: 55400 });
  const fixture = makeFixtureRepo();
  const oldPath = 'src/original [one].js';
  const newPath = 'src/renamed [one].js';
  const original = Array.from({ length: 10 }, (_, index) => `console.log("line ${index + 1}");`).join('\n') + '\n';
  try {
    fs.writeFileSync(path.join(fixture, oldPath), original);
    git(fixture, 'add', '.');
    git(fixture, 'commit', '--quiet', '-m', 'Add a file to rename');
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    expect(sandboxExec(workspace.sandboxName, `cd '${workspace.path}' && git mv '${oldPath}' '${newPath}'`).code).toBe(0);
    const changes = await lonca.api<ChangeSet>('GET', `/workspaces/${workspace.id}/changes`);
    expect(changes.files).toEqual([expect.objectContaining({ status: 'R', path: newPath, oldPath, added: 0, removed: 0 })]);
    const query = new URLSearchParams({ path: newPath, oldPath });
    const diff = await lonca.api<string>('GET', `/workspaces/${workspace.id}/diff?${query}`);
    expect(diff).toContain(`rename from ${oldPath}`);
    expect(diff).toContain(`rename to ${newPath}`);
    expect(diff).not.toContain('@@');
    await expect(lonca.api('GET', `/workspaces/${workspace.id}/diff?${new URLSearchParams({ path: newPath, oldPath: '../outside.js' })}`)).rejects.toThrow(/400/);

    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('tab', { name: /Changes/ }).click();
    await page.locator('.change-row').filter({ hasText: 'renamed [one].js' }).click();
    await expect(page.locator('.diff-note')).toHaveText([`rename from ${oldPath}`, `rename to ${newPath}`]);
    await expect(page.locator('.diff-add, .diff-del')).toHaveCount(0);

    fs.writeFileSync(path.join(workspace.path, newPath), original.replace('line 5', 'updated line 5'));
    await expect(page.locator('.diff-add')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.diff-add code')).toHaveText('console.log("updated line 5");');
    await expect(page.locator('.diff-del')).toHaveCount(1);
    await expect(page.locator('.diff-del code')).toHaveText('console.log("line 5");');
    await expect(page.locator('.diff-del .line-number').first()).toHaveText('5');
    await expect(page.locator('.diff-add .line-number').nth(1)).toHaveText('5');
    await expect(page.locator('.diff-note')).toHaveText([`rename from ${oldPath}`, `rename to ${newPath}`]);
  } finally {
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
