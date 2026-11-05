import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import type { AppState, TerminalInfo } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, until } from '../support/harness.ts';

test('reconnects a recovered terminal after a temporary missing handle and stops retrying when closed', async ({ page }) => {
  const lonca = new Lonca({ port: 48349, instance: 'terminal-recovery-ui', firstWorkspacePort: 56000 });
  const fixture = makeFixtureRepo();
  const connections = new Map<string, { client: WebSocketRoute; server: WebSocketRoute; receivedOutput: boolean }>();
  let missingId: string | undefined;
  let rejected = 0;
  let holdSnapshot = false;
  let releaseSnapshot!: () => void;
  const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve; });

  await page.routeWebSocket((url) => url.pathname.startsWith('/ws/terminals/'), (client) => {
    const id = new URL(client.url()).pathname.split('/').at(-1)!;
    if (id === missingId) {
      rejected++;
      void client.close({ code: 4404, reason: 'No such terminal' });
    } else {
      const connection = { client, server: client.connectToServer(), receivedOutput: false };
      connection.server.onMessage((message) => {
        if (Buffer.isBuffer(message)) connection.receivedOutput = true;
        client.send(message);
      });
      connections.set(id, connection);
    }
  });
  await page.route('**/api/state', async (route) => {
    if (holdSnapshot) await snapshotReady;
    await route.continue();
  });

  try {
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    const shell = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    const input = page.locator('.terminal-view:visible .xterm-helper-textarea');
    const output = page.locator('.terminal-view:visible .xterm-rows');
    await expect(output).toContainText(workspace.name);
    await input.focus();
    // An idle shell ends with the connection to the server. A busy one outlives it.
    await page.keyboard.type("trap '' HUP TERM; touch .context/shell-ready; while true; do sleep 1; done");
    await page.keyboard.press('Enter');
    await expect.poll(() => fs.existsSync(path.join(workspace.path, '.context/shell-ready'))).toBe(true);

    // Reproduce the terminal's earlier reconnect without depending on recovery speed.
    // Delay hydration so the existing view stays mounted with the same terminal ID.
    missingId = shell.id;
    holdSnapshot = true;
    const initialConnection = connections.get(shell.id);
    await lonca.kill();
    await lonca.start();
    await expect.poll(() => rejected, { timeout: 10000 }).toBeGreaterThan(0);
    await until('the recovered terminal', async () => (await lonca.api<AppState>('GET', '/state'))
      .terminals.some((terminal) => terminal.id === shell.id && terminal.disconnected), 30000);
    missingId = undefined;
    holdSnapshot = false;
    releaseSnapshot();
    await page.getByRole('tab', { name: 'Recovered terminal', exact: true }).click();
    const restarted = page.waitForResponse((response) => response.url().endsWith(`/terminals/${shell.id}/restart`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Restart', exact: true }).click();
    expect((await restarted).ok()).toBe(true);
    await expect.poll(() => {
      const connection = connections.get(shell.id);
      return connection !== initialConnection && connection?.receivedOutput;
    }, { timeout: 15000 }).toBe(true);
    await expect(output).toContainText(workspace.name, { timeout: 15000 });
    await input.focus();
    await page.keyboard.type("printf ok > .context/recovered-input; echo recovered-output");
    await page.keyboard.press('Enter');
    const recoveredInput = path.join(workspace.path, '.context/recovered-input');
    await expect.poll(() => fs.existsSync(recoveredInput) ? fs.readFileSync(recoveredInput, 'utf8') : null).toBe('ok');
    await expect(output).toContainText('recovered-output');

    // A real deletion must still cancel any retry scheduled for the missing handle.
    missingId = shell.id;
    const before = rejected;
    const connection = connections.get(shell.id)!;
    await connection.client.close();
    await connection.server.close();
    await expect.poll(() => rejected).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'New terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Close Recovered terminal', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Recovered terminal', exact: true })).toHaveCount(0);
    const afterClose = rejected;
    await page.waitForTimeout(5500); // Longer than the reconnect delay, including its backoff.
    expect(rejected).toBe(afterClose);
  } finally {
    releaseSnapshot();
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
