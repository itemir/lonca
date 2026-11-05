import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppState, TerminalInfo, Workspace } from '../../shared/types.ts';
import { Lonca, sandboxExec, makeFixtureRepo } from '../support/harness.ts';

const lonca = new Lonca({ port: 48373, instance: 'terminal-window-ui', firstWorkspacePort: 58700 });
let fixture: string;
let projectId: string;

test.beforeAll(async () => {
  fixture = makeFixtureRepo();
  await lonca.start();
  projectId = (await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id)).id;
});

test.afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

const screen = (view: Page) => view.locator('.terminal-view:visible .xterm-rows');
const moveButton = (view: Page, title = 'Terminal') => view.getByRole('button', { name: `Move ${title} to a separate window` });
const away = (view: Page) => view.getByText('This terminal is in a separate window');

async function run(view: Page, command: string): Promise<void> {
  await view.locator('.terminal-view:visible .xterm-helper-textarea').focus();
  await view.keyboard.type(command);
  await view.keyboard.press('Enter');
}

/** What the program in the terminal is told its size is. */
async function ttySize(view: Page): Promise<string> {
  const marker = `size${Math.random().toString(36).slice(2, 8)}`;
  await run(view, `echo ${marker}=$(stty size)`);
  await expect(screen(view)).toContainText(new RegExp(`${marker}=\\d`));
  return new RegExp(`${marker}=(\\d+ \\d+)`).exec(await screen(view).innerText())![1];
}

/** A new size takes a moment to reach a terminal in a virtual machine, and a line typed meanwhile can come out garbled. */
const settle = (view: Page) => view.waitForTimeout(1500);

const rowHeight = (view: Page) => view.locator('.terminal-view:visible .xterm-rows > div').first().evaluate((row) => row.getBoundingClientRect().height);

async function terminalInfo(id: string): Promise<TerminalInfo | undefined> {
  return (await lonca.api<AppState>('GET', '/state')).terminals.find((terminal) => terminal.id === id);
}

/** A new workspace open in `page`, its first terminal ready in the panel. */
async function openWorkspace(page: Page): Promise<{ workspace: Workspace; terminal: TerminalInfo }> {
  const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${projectId}/workspaces`, {})).workspace.id);
  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  await expect(screen(page)).toContainText(workspace.name, { timeout: 20000 });
  await settle(page);
  const { terminals } = await lonca.api<AppState>('GET', '/state');
  return { workspace, terminal: terminals.find((terminal) => terminal.workspaceId === workspace.id)! };
}

async function moveToWindow(page: Page, title = 'Terminal'): Promise<Page> {
  const opening = page.context().waitForEvent('page');
  await moveButton(page, title).click();
  const view = await opening;
  await expect(view.locator('.terminal-view')).toBeVisible();
  await settle(view);
  return view;
}

test('moves a terminal to a window of its own and back, as the same shell at each one’s size', async ({ page }) => {
  const { workspace, terminal } = await openWorkspace(page);
  const panelSize = await ttySize(page);
  const panelRows = await rowHeight(page);
  await run(page, 'export STILL=the-same-shell');

  // A window loads the font afresh. Measured before it arrives, every row would come out wrong.
  await page.context().route('**/*.woff2', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  const view = await moveToWindow(page);
  await expect(screen(view)).toContainText(workspace.name);
  // Typed where it wrapped, it still reads as one line here, where it fits.
  await expect(screen(view)).toContainText('export STILL=the-same-shell');
  expect(new URL(view.url()).pathname).toBe(`/terminals/${terminal.id}`);
  await expect(view).toHaveTitle(`${workspace.name} — Terminal`);
  // A real window, without the browser's own tabs and toolbars.
  expect(await view.evaluate('window.toolbar.visible')).toBe(false);
  expect(await rowHeight(view)).toBe(panelRows);

  // The panel gives the terminal up, and its room with it.
  await expect(away(page)).toBeVisible();
  await expect(page.locator('.terminal-view')).toHaveCount(0);
  expect(await page.locator('.right-bottom').evaluate((panel) => panel.getBoundingClientRect().height)).toBeLessThan(150);

  await run(view, 'echo $STILL > .context/typed-in-window');
  const typed = path.join(workspace.path, '.context/typed-in-window');
  await expect.poll(() => fs.existsSync(typed) && fs.readFileSync(typed, 'utf8').trim()).toBe('the-same-shell');

  // The program follows the window as it's resized.
  const windowSize = await ttySize(view);
  expect(windowSize).not.toBe(panelSize);
  await view.setViewportSize({ width: 620, height: 420 });
  await expect.poll(() => ttySize(view)).not.toBe(windowSize);

  // Asking again finds the same window, without reloading it or opening another.
  await view.evaluate('window.kept = true');
  let opened = 0;
  page.context().on('page', () => { opened++; });
  await page.getByRole('button', { name: 'Show the window for Terminal' }).click();
  await page.waitForTimeout(500);
  expect(opened).toBe(0);
  expect(await view.evaluate('window.kept')).toBe(true);

  // Closing the window leaves the shell running and hands it back.
  await view.close();
  await expect(screen(page)).toContainText(workspace.name);
  await expect(away(page)).toBeHidden();
  await expect.poll(() => ttySize(page)).toBe(panelSize);
  await run(page, 'echo back=$STILL');
  await expect(screen(page)).toContainText('back=the-same-shell');
  expect(await terminalInfo(terminal.id)).toMatchObject({ status: 'running' });
  expect((await terminalInfo(terminal.id))?.windowed).toBeUndefined();
});

test('keeps the terminal in its window through reloads of either page', async ({ page }) => {
  const { workspace, terminal } = await openWorkspace(page);
  const view = await moveToWindow(page);
  await expect(screen(view)).toContainText(workspace.name);
  const size = await ttySize(view);

  // A panel that attached even briefly would shrink the terminal under the window.
  const attached: string[] = [];
  page.on('websocket', (socket) => attached.push(new URL(socket.url()).pathname));
  await page.reload();
  await expect(away(page)).toBeVisible();
  expect(attached).not.toContain(`/ws/terminals/${terminal.id}`);
  expect(await ttySize(view)).toBe(size);

  await view.reload();
  await expect(screen(view)).toContainText(workspace.name);
  expect((await terminalInfo(terminal.id))?.windowed).toBe(true);
  await page.waitForTimeout(1500);
  await expect(away(page)).toBeVisible();
  expect(attached).not.toContain(`/ws/terminals/${terminal.id}`);
  expect(await ttySize(view)).toBe(size);

  // Anything else still attached can't take it back from the window, by typing or by resizing.
  const stale = await lonca.openTerminal(terminal.id);
  stale.socket.send(JSON.stringify({ type: 'resize', cols: 40, rows: 10 }));
  stale.send('echo from-another-view\n');
  await view.waitForTimeout(300);
  await expect(screen(view)).not.toContainText('from-another-view');
  expect(await ttySize(view)).toBe(size);
  stale.socket.close();

  // The panel can bring it back without going to find the window.
  const closing = view.waitForEvent('close');
  await page.getByRole('button', { name: 'Bring it back' }).click();
  await closing;
  await expect(screen(page)).toContainText(workspace.name);
  expect((await terminalInfo(terminal.id))?.windowed).toBeUndefined();
});

test('lets a newer window replace an older one opened from another browser tab', async ({ page }) => {
  const { workspace, terminal } = await openWorkspace(page);
  const first = await moveToWindow(page);
  await expect(screen(first)).toContainText(workspace.name);

  // A separate tab can't find the first window by its name, so this opens a second one.
  const other = await page.context().newPage();
  await other.goto(`${lonca.url}/w/${workspace.id}`);
  await expect(away(other)).toBeVisible();
  const closing = first.waitForEvent('close');
  const opening = page.context().waitForEvent('page');
  await other.getByRole('button', { name: 'Show the window for Terminal' }).click();
  const second = await opening;
  await closing;
  await expect(screen(second)).toContainText(workspace.name);
  await run(second, 'echo from-the-newer-window');
  await expect(screen(second)).toContainText('from-the-newer-window');
  expect((await terminalInfo(terminal.id))?.windowed).toBe(true);

  await second.close();
  await expect(screen(page)).toContainText(workspace.name);
  await expect(screen(other)).toContainText(workspace.name);
});

test('keeps a disconnected window dismissed when its retry arrives', async ({ page }) => {
  await page.context().addInitScript(`
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        if (new URL(args[0]).pathname.endsWith('/window')) window.testTerminalSocket = this;
      }
    };
  `);
  const { workspace, terminal } = await openWorkspace(page);
  const view = await moveToWindow(page);
  await expect(screen(view)).toContainText(workspace.name);
  await expect(away(page)).toBeVisible();

  // Hold just this socket's retry, so the user can bring it back while disconnected.
  await view.evaluate(`new Promise((resolve) => {
    const socket = window.testTerminalSocket;
    const onclose = socket.onclose;
    socket.onclose = (event) => {
      const setTimeout = window.setTimeout;
      window.setTimeout = (callback) => { window.retryTerminal = callback; return 0; };
      try { onclose.call(socket, event); }
      finally { window.setTimeout = setTimeout; }
      resolve();
    };
    socket.close();
  })`);
  await page.getByRole('button', { name: 'Bring it back' }).click();
  await expect(screen(page)).toContainText(workspace.name);
  expect((await terminalInfo(terminal.id))?.windowed).toBeUndefined();

  const closing = view.waitForEvent('close');
  // Let evaluate return before the retry causes the popup to close itself.
  await view.evaluate('setTimeout(window.retryTerminal, 100)');
  await closing;
  await expect(away(page)).toBeHidden();
  await run(page, 'echo still-in-the-panel');
  await expect(screen(page)).toContainText('still-in-the-panel');
  expect((await terminalInfo(terminal.id))?.windowed).toBeUndefined();

  // A fresh, explicitly opened window is allowed after the old one was dismissed.
  const reopened = await moveToWindow(page);
  await expect(screen(reopened)).toContainText('still-in-the-panel');
  await reopened.close();
  await expect(away(page)).toBeHidden();
});

test('doesn’t answer old terminal queries at the prompt each time a view attaches', async ({ page }) => {
  const { workspace } = await openWorkspace(page);
  // The answer is read here, so it's only left on the prompt if the query gets answered again.
  await run(page, `printf '\\033[c'; read -rs -t 2 -d c answer; printf 'answered=%q\\n' "$answer"`);
  await expect(screen(page)).toContainText(/answered=\$'\\E\[\?1;2'/);
  // However the prompt wraps, nothing has been typed after it.
  const endsAtPrompt = async (view: Page) => (await screen(view).innerText()).replace(/\s/g, '').endsWith(`:${workspace.name}$`);

  await page.reload();
  await expect(screen(page)).toContainText('answered=');
  await page.waitForTimeout(400);
  expect(await endsAtPrompt(page)).toBe(true);

  const view = await moveToWindow(page);
  await expect(screen(view)).toContainText('answered=');
  await view.waitForTimeout(400);
  expect(await endsAtPrompt(view)).toBe(true);

  // Programs still get their answers: one asked for now is the real thing.
  await run(view, `printf '\\033[c'; read -rs -t 2 -d c answer; printf 'live=%q\\n' "$answer"`);
  await expect(screen(view)).toContainText(/live=\$'\\E\[\?1;2'/);
  await view.close();
  await expect(screen(page)).toContainText('live=');

  // So does one asked while nothing is attached, as when working in another workspace meanwhile.
  await run(page, `sleep 1.5; printf '\\033[c'; read -rs -t 10 -d c answer; printf 'late=%q\\n' "$answer"`);
  await page.getByRole('button', { name: 'Hide terminals' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Terminals' }).click();
  await expect(screen(page)).toContainText(/late=\$'\\E\[\?1;2'/);
});

test('shows a terminal ending in its window, and closes with the terminal', async ({ page }) => {
  const { workspace, terminal } = await openWorkspace(page);
  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();

  // The panel carries on with the other terminal, rather than sitting empty.
  const view = await moveToWindow(page);
  await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute('aria-selected', 'true');
  await expect(screen(page)).toContainText(workspace.name);
  await expect(away(page)).toBeHidden();

  await expect(screen(view)).toContainText(workspace.name);
  await run(view, 'exit 3');
  await expect(view.getByText('This terminal exited with code 3.')).toBeVisible();
  await view.getByRole('button', { name: 'Restart' }).click();
  await expect(view.getByText('This terminal exited')).toBeHidden();
  await run(view, 'echo restarted-here');
  await expect(screen(view)).toContainText('restarted-here');

  // Selecting it shows where it went.
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await expect(away(page)).toBeVisible();

  const closing = view.waitForEvent('close');
  await page.getByRole('button', { name: 'Close Terminal', exact: true }).click();
  await closing;
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCount(0);
  expect(await terminalInfo(terminal.id)).toBeUndefined();
});

test('fits a terminal when its tab is selected, even if the panel changed size behind it', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute('aria-selected', 'true');
  await expect(screen(page)).toContainText('$');
  const before = await ttySize(page);
  // Short enough for the panel's height limit to take effect.
  await page.setViewportSize({ width: 1440, height: 300 });
  await expect.poll(() => ttySize(page)).not.toBe(before);
  const after = await ttySize(page);

  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await expect(screen(page)).toContainText('$');
  await expect.poll(() => ttySize(page)).toBe(after);
});

test('explains a blocked pop-up and leaves the terminal where it is', async ({ page }) => {
  await page.addInitScript('window.open = () => null');
  const { workspace, terminal } = await openWorkspace(page);
  await moveButton(page).click();
  await expect(page.locator('.toast')).toContainText('blocked the new window');
  await expect(screen(page)).toContainText(workspace.name);
  await expect(away(page)).toBeHidden();
  expect((await terminalInfo(terminal.id))?.windowed).toBeUndefined();
});

test('recovers and closes a legacy Run process even when it is the only terminal', async ({ page }) => {
  const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${projectId}/workspaces`, {})).workspace.id);
  await lonca.api('PATCH', `/projects/${projectId}`, { settings: { setupScript: 'exec sleep 600' } });
  try {
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
  } finally {
    await lonca.api('PATCH', `/projects/${projectId}`, { settings: { setupScript: '' } });
  }
  const record = `/var/tmp/lonca/tty/${workspace.id}`;
  const pid = sandboxExec(workspace.sandboxName, `cat ${record}-setup.pid`).output;
  expect(pid).toMatch(/^\d+$/);
  await lonca.kill();
  // The old Run feature used the same process records with a different suffix.
  expect(sandboxExec(workspace.sandboxName, `for suffix in pid pid.identity pid.launch; do mv ${record}-setup.$suffix ${record}-run.$suffix; done`).code).toBe(0);
  await lonca.start();
  const id = `${workspace.id}-run`;
  await expect.poll(() => terminalInfo(id), { timeout: 20000 }).toMatchObject({ kind: 'shell', status: 'running', disconnected: true });
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);

  await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
  await expect(page.getByRole('tab', { name: 'Recovered run script', exact: true })).toBeVisible();
  expect((await lonca.api<AppState>('GET', '/state')).terminals.filter((entry) => entry.workspaceId === workspace.id)).toHaveLength(1);
  await page.getByRole('button', { name: 'Close Recovered run script', exact: true }).click();
  await expect.poll(() => sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
  await expect.poll(() => terminalInfo(id)).toBeUndefined();
  await expect(screen(page)).toContainText(workspace.name);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('has no window to offer, and leaves the terminal’s controls big enough to tap', async ({ page }) => {
    const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${projectId}/workspaces`, {})).workspace.id);
    await page.goto(`${lonca.url}/w/${workspace.id}?token=${lonca.token}`);
    await page.getByRole('button', { name: 'Show the side panel' }).tap();
    await expect(screen(page)).toContainText(workspace.name, { timeout: 20000 });
    await expect(moveButton(page)).toBeHidden();
    expect(await page.getByRole('button', { name: 'New terminal' }).boundingBox()).toMatchObject({ width: 44, height: 44 });
    expect(await page.getByRole('button', { name: 'Hide terminals' }).boundingBox()).toMatchObject({ width: 44, height: 44 });
  });
});
