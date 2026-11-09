// The pull request at the top of a workspace's side panel: what it says, Merge and Archive. gh in
// the sandbox is tests/support/fake-gh, so nothing reaches GitHub. Where only the look is being
// tested, the browser's reads are answered directly instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Checks, Project, Workspace } from '../../shared/types.ts';
import { Lonca, REPO_ROOT, asRoot, git, makeFixtureRepo, sandboxExec, sandboxRunning, sbx } from '../support/harness.ts';

const lonca = new Lonca({ port: 48463, instance: 'pull-request-ui', firstWorkspacePort: 59700 });
const REPO = 'lonca-test/merge-fixture';
const SHOTS = path.join(REPO_ROOT, 'test-results', 'shots');
let fixture: string;
let scratch: string;
let project: Project;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface Ready {
  workspace: Workspace;
  head: string;
}

async function create(): Promise<Ready> {
  const made = await lonca.api<{ workspace: Workspace }>('POST', `/projects/${project.id}/workspaces`, {});
  const workspace = await lonca.waitForWorkspace(made.workspace.id);
  sbx('cp', path.join(REPO_ROOT, 'tests', 'support', 'fake-gh'), `${workspace.sandboxName}:/var/tmp/fake-gh-script`);
  asRoot(workspace.sandboxName, `
    real=$(command -v gh)
    mv "$real" "$real.real"
    install -m 755 /var/tmp/fake-gh-script "$real"
    install -d -m 777 /var/tmp/fake-gh
  `);
  const head = sandboxExec(workspace.sandboxName, `git -C ${quote(workspace.path)} rev-parse HEAD`).output;
  return { workspace, head };
}

function answer({ workspace }: Ready, files: Record<string, string | object | null>): void {
  const lines = Object.entries(files).map(([name, content]) => {
    if (content === null) return `rm -f /var/tmp/fake-gh/${name}`;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return `printf %s ${quote(Buffer.from(text).toString('base64'))} | base64 -d > /var/tmp/fake-gh/${name}`;
  });
  const result = sandboxExec(workspace.sandboxName, lines.join(' && '));
  if (result.code !== 0) throw new Error(result.output);
}

function merges({ workspace }: Ready): number {
  return sandboxExec(workspace.sandboxName, 'cat /var/tmp/fake-gh/calls.log 2>/dev/null').output.split('\n').filter((line) => line.startsWith('pr\x1fmerge\x1f')).length;
}

function view({ workspace, head }: Ready, overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'Name terminals after the project and branch',
    url: `https://github.com/${REPO}/pull/7`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    headRefOid: head,
    baseRefName: 'main',
    createdAt: new Date(workspace.createdAt + 60_000).toISOString(),
    mergedAt: null,
    closedAt: null,
    autoMergeRequest: null,
    ...overrides,
  };
}

const GRAPHQL = {
  data: {
    repository: {
      mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH', viewerPermission: 'ADMIN',
      pullRequest: { isInMergeQueue: false, isMergeQueueEnabled: false },
    },
  },
};

/** GraphQL's answer for a base branch with a merge queue. */
const queueGraphql = (queued: boolean) => ({
  data: { repository: { ...GRAPHQL.data.repository, pullRequest: { isInMergeQueue: queued, isMergeQueueEnabled: true } } },
});

const opened = (workspace: Workspace) => `${lonca.url}/w/${workspace.id}?token=${lonca.token}`;
const header = (page: Page) => page.locator('.right-header');
const named = (label: string) => `Pull request #7: ${/[.…]$/.test(label) ? label : `${label}.`} Opens GitHub.`;
const status = (page: Page) => header(page).locator('.pr-status');

/** A read as the server would answer it, for tests of how each state looks. */
function scripted({ workspace, head }: Ready, pr: Record<string, unknown> | null, extra: Partial<Checks> = {}): Checks {
  return {
    github: 'connected',
    pr: pr && {
      number: 7, title: 'Name terminals after the project and branch', url: `https://github.com/${REPO}/pull/7`, state: 'OPEN', isDraft: false,
      reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: head, baseRefName: 'main',
      createdAt: new Date(workspace.createdAt + 60_000).toISOString(), mergedAt: null, closedAt: null, autoMergeRequest: false, ...pr,
    } as Checks['pr'],
    checks: [{ name: 'test', status: 'success' }],
    repo: GRAPHQL.data.repository,
    queue: { enabled: false, queued: false },
    local: { head, unpushed: 0, uncommitted: 0 },
    checkedAt: Date.now(),
    ...extra,
  } as Checks;
}

/** Answers the page's reads of the pull request with whatever `current` holds. */
async function routeChecks(page: Page, ready: Ready, current: { checks: Checks }): Promise<void> {
  await page.route(`**/api/workspaces/${ready.workspace.id}/checks`, (route) => route.fulfill({ json: { ...current.checks, checkedAt: Date.now() } }));
}

async function refresh(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Checks' }).click();
  await page.getByRole('button', { name: 'Refresh checks' }).click();
}

/** Makes the page believe these sessions are taking a turn, as the server would say if they were. */
async function routeWorking(page: Page, sessionIds: string[]): Promise<void> {
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    for (const session of state.sessions) session.status = sessionIds.includes(session.id) ? 'running' : 'idle';
    await route.fulfill({ response, json: state });
  });
}

const TEXT_3 = 'rgb(138, 134, 129)';
const TEXT_2 = 'rgb(180, 177, 172)';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // The project's remote is on GitHub, where the host's Git can't reach, so it imports what's on disk.
  fixture = makeFixtureRepo();
  git(fixture, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-merge-ui-'));
  const config = path.join(scratch, 'gitconfig');
  fs.writeFileSync(config, '[http "https://github.com/"]\n\tproxy = http://127.0.0.1:9\n');
  lonca.env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, NO_PROXY: '', no_proxy: '' };
  await lonca.start();
  await lonca.api('PUT', '/secrets/github', { token: 'github_pat_not_a_real_token' });
  project = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: fixture })).id);
});

test.afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('says what the pull request is waiting for, and offers only what it can do', async ({ page }) => {
  const ready = await create();
  const current = { checks: scripted(ready, null) };
  await routeChecks(page, ready, current);
  await page.goto(opened(ready.workspace));
  await expect(page.locator('[data-step="sandbox"]')).toContainText('Running in its own virtual machine');

  const cases: { name: string; pr: Record<string, unknown>; extra?: Partial<Checks>; label: string; button: string | null }[] = [
    { name: 'ready', pr: {}, label: 'Ready to merge', button: 'Merge pull request #7' },
    { name: 'draft', pr: { isDraft: true, mergeStateStatus: 'DRAFT' }, label: 'Draft', button: null },
    { name: 'checking', pr: { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, label: 'Checking…', button: null },
    { name: 'conflicts', pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, label: 'Has conflicts', button: null },
    { name: 'failing', pr: { mergeStateStatus: 'BLOCKED' }, extra: { checks: [{ name: 'a', status: 'failure' }, { name: 'b', status: 'failure' }] }, label: '2 checks failing', button: null },
    { name: 'needs-review', pr: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, label: 'Needs review', button: null },
    { name: 'behind', pr: { mergeStateStatus: 'BEHIND' }, label: 'Out of date', button: null },
    { name: 'checks-running', pr: { mergeStateStatus: 'BLOCKED' }, extra: { checks: [{ name: 'e2e', status: 'pending' }] }, label: 'Checks running', button: null },
    { name: 'not-pushed', pr: {}, extra: { local: { head: 'e'.repeat(40), unpushed: 2, uncommitted: 0 } }, label: '2 not pushed', button: 'Merge pull request #7' },
    { name: 'not-committed', pr: {}, extra: { local: { head: ready.head, unpushed: 0, uncommitted: 3 } }, label: '3 not committed', button: 'Merge pull request #7' },
    { name: 'local-unknown', pr: {}, extra: { local: null }, label: 'Local work unknown', button: 'Merge pull request #7' },
    { name: 'merged', pr: { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, label: 'Merged', button: 'Archive this workspace' },
    { name: 'closed', pr: { state: 'CLOSED' }, label: 'Closed', button: null },
  ];
  for (const { name, pr, extra, label, button } of cases) {
    current.checks = scripted(ready, pr, extra);
    await refresh(page);
    await expect(status(page), name).toHaveAccessibleName(named(label));
    await expect(status(page)).toHaveAttribute('href', `https://github.com/${REPO}/pull/7`);
    await expect(header(page).getByRole('button')).toHaveCount(button ? 1 : 0);
    if (button) await expect(header(page).getByRole('button', { name: button })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, `pr-header-${name}.png`), clip: { x: 1440 - 340, y: 0, width: 340, height: 160 } });
  }

  // Ready is the only state that offers Merge as the primary action, and merged offers Archive that way.
  current.checks = scripted(ready, {});
  await refresh(page);
  await expect(header(page).getByRole('button', { name: 'Merge pull request #7' })).toHaveClass(/button-primary/);
  await expect(status(page)).toHaveAttribute('title', 'GitHub can merge it, its checks passed, and everything in this workspace is in it.');
  await expect(page.locator('.pr-state')).toContainText('Ready to merge.');
  // Without any checks, it doesn't claim they passed.
  current.checks = scripted(ready, {}, { checks: [] });
  await refresh(page);
  await expect(status(page)).toHaveAttribute('title', 'GitHub can merge it, no checks ran, and everything in this workspace is in it.');
  await expect(page.locator('.pr-state li')).toHaveText([
    'Ready to merge. GitHub can merge it, no checks ran, and everything in this workspace is in it.',
    'No checks ran on it, so only the Lead’s report says whether it works.',
  ]);
  current.checks = scripted(ready, {}, { local: null });
  await refresh(page);
  await expect(status(page)).toHaveAttribute('title', 'Lonca couldn’t read this workspace, so it can’t tell whether everything here is in #7.');

  // The Checks tab lists every reason, where the header has room for one.
  current.checks = scripted(ready, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, { checks: [], local: { head: ready.head, unpushed: 0, uncommitted: 3 } });
  await refresh(page);
  await expect(page.locator('.pr-state li')).toHaveText([
    'Conflicts with main.',
    '3 changes here aren’t committed.',
    'No checks ran on it, so only the Lead’s report says whether it works.',
  ]);
  await expect(page.locator('.checks').getByRole('button')).toHaveCount(0);

  // No pull request: Create PR, as before, once there's work to put in one.
  current.checks = scripted(ready, null);
  sandboxExec(ready.workspace.sandboxName, `echo new > ${quote(path.join(ready.workspace.path, 'new.txt'))}`);
  await refresh(page);
  await expect(header(page).getByRole('button', { name: 'Create PR' })).toBeVisible({ timeout: 15000 });
  await expect(status(page)).toHaveCount(0);
});

test('keeps the last known state when GitHub can’t be reached, or the workspace is stopped, and never offers Merge then', async ({ page }) => {
  const ready = await create();
  answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL });
  await page.goto(opened(ready.workspace));
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Ready to merge. Opens GitHub.');

  // A failed read isn't the same as no pull request, which would offer to open another.
  answer(ready, { 'view.err': 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' });
  await refresh(page);
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Open. Opens GitHub.');
  await expect(status(page)).toHaveClass(/is-stale/);
  await expect(status(page)).toHaveAttribute('title', /^As of [^.]+\. HTTP 502/);
  await expect(status(page).locator('.pr-unreachable')).toBeVisible();
  await expect(header(page).getByRole('button')).toHaveCount(0);
  // Dimmed by colour, not opacity, so the number stays as readable as ever.
  await expect(status(page)).toHaveCSS('opacity', '1');
  await expect(status(page).locator('.pr-label')).toHaveCSS('color', TEXT_3);
  await expect(status(page).locator('.pr-icon')).toHaveCSS('color', TEXT_3);
  await expect(status(page).locator('.pr-number')).toHaveCSS('color', TEXT_3);
  await page.screenshot({ path: path.join(SHOTS, 'pr-header-unreachable.png'), clip: { x: 1440 - 340, y: 0, width: 340, height: 60 } });
  // The hover fill is lighter, so the label lightens with it to stay readable.
  await status(page).hover();
  await expect(status(page).locator('.pr-label')).toHaveCSS('color', TEXT_2);
  await page.mouse.move(0, 0);

  await lonca.api('POST', `/workspaces/${ready.workspace.id}/stop`);
  await expect(page.locator('.workspace-banner')).toContainText('is stopped');
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Open. Opens GitHub.');
  await expect(status(page)).toHaveAttribute('title', /^As of [^.]+\. Start the workspace to check again\.$/);
  await expect(header(page).getByRole('button')).toHaveCount(0);
  // And it's still there after a reload, when nothing has been read since.
  await page.reload();
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Open. Opens GitHub.');
  expect(sandboxRunning(ready.workspace.sandboxName)).toBe(false);

  // Merged while the workspace was running: Archive stays on offer, at full strength, once it stops.
  await lonca.api('POST', `/workspaces/${ready.workspace.id}/start`);
  answer(ready, { 'view.err': null, 'view.json': view(ready, { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) });
  await refresh(page);
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Merged. Opens GitHub.');
  await expect(status(page)).not.toHaveClass(/is-stale/);
  await lonca.api('POST', `/workspaces/${ready.workspace.id}/stop`);
  await expect(page.locator('.workspace-banner')).toContainText('is stopped');
  await expect(status(page)).toHaveClass(/is-stale/);
  await expect(status(page).locator('.pr-label')).toHaveCSS('color', TEXT_3);
  const archive = header(page).getByRole('button', { name: 'Archive this workspace' });
  await expect(archive).toHaveCSS('opacity', '1');
  await expect(archive).toHaveClass(/button-primary/);
  await page.screenshot({ path: path.join(SHOTS, 'pr-header-stopped-merged.png'), clip: { x: 1440 - 340, y: 0, width: 340, height: 60 } });
});

test('merges from a dialog that waits for a decision, then offers to archive', async ({ page }) => {
  const ready = await create();
  answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL });
  sandboxExec(ready.workspace.sandboxName, `echo loose > ${quote(path.join(ready.workspace.path, 'loose.txt'))}`);
  await page.goto(opened(ready.workspace));
  await expect(status(page)).toHaveAccessibleName('Pull request #7: 1 not committed. Opens GitHub.');
  await expect(status(page)).toHaveAttribute('title', '1 change here isn’t committed.');

  const merge = header(page).getByRole('button', { name: 'Merge pull request #7' });
  await merge.click();
  const dialog = page.getByRole('dialog', { name: 'Merge #7 into main?' });
  await expect(dialog).toContainText('Name terminals after the project and branch');
  await expect(dialog).toContainText(`${ready.workspace.branch} → main`);
  await expect(dialog).toContainText('2 checks passed');
  await expect(dialog.locator('.close-warning')).toHaveText(['1 uncommitted change isn’t in the pull request.']);
  await page.screenshot({ path: path.join(SHOTS, 'pr-merge-dialog.png') });

  // Enter by habit doesn't merge.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect(merges(ready)).toBe(0);
  await expect(merge).toBeFocused();

  sandboxExec(ready.workspace.sandboxName, `rm ${quote(path.join(ready.workspace.path, 'loose.txt'))}`);
  await refresh(page);
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Ready to merge. Opens GitHub.');
  await merge.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.close-warning')).toHaveCount(0);

  // Tab goes round the dialog, never to the page behind it.
  const focusInside = () => page.evaluate('document.querySelector(\'[role="dialog"]\').contains(document.activeElement)');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInside()).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focusInside()).toBe(true);
  }

  // The methods are a radio group that the arrow keys move through.
  const methods = dialog.getByRole('radiogroup', { name: 'How to merge' });
  await expect(methods.getByRole('radio')).toHaveCount(3);
  await expect(methods.getByRole('radio', { name: 'Squash' })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Squash and merge' })).toBeVisible();
  await methods.getByRole('radio', { name: 'Squash' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(methods.getByRole('radio', { name: 'Merge commit' })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Create a merge commit' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('button', { name: 'Rebase and merge' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(methods.getByRole('radio', { name: 'Squash' })).toBeChecked();

  answer(ready, { 'merge.sleep': '2', 'after-view.json': view(ready, { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) });
  await dialog.getByRole('button', { name: 'Squash and merge' }).click();
  await expect(dialog.getByRole('button', { name: 'Merging…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Merging…' })).toBeFocused();
  // Dimmed, but readable: it's the only word of progress in the dialog.
  await expect(dialog.getByRole('button', { name: 'Merging…' })).toHaveCSS('opacity', '0.55');
  // The spinner on a white button turns in the button's own dark ink.
  await expect(dialog.locator('.button-primary .spinner-arc')).toHaveCSS('stroke', 'rgb(27, 25, 23)');
  await expect(dialog.locator('.button-primary .spinner-track')).toHaveCSS('stroke', 'rgba(27, 25, 23, 0.25)');
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Merging… Opens GitHub.');
  await expect(dialog).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.toast')).toContainText('Merged #7 into main.');
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Merged. Opens GitHub.');
  const archive = header(page).getByRole('button', { name: 'Archive this workspace' });
  await expect(archive).toBeFocused();
  await expect(page.locator('.pr-announcer')).toHaveText('Pull request #7 merged.');
  expect(merges(ready)).toBe(1);
  await page.screenshot({ path: path.join(SHOTS, 'pr-header-after-merge.png'), clip: { x: 1440 - 340, y: 0, width: 340, height: 60 } });

  await archive.click();
  const closing = page.getByRole('dialog', { name: 'Archive this workspace?' });
  await expect(closing).toContainText('#7 is merged into main.');
  await expect(closing.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await closing.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.locator('.workspace-banner')).toContainText('archived', { timeout: 60000 });
  expect(sandboxRunning(ready.workspace.sandboxName)).toBeNull();
  // The record of it outlives the workspace's virtual machine.
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Merged. Opens GitHub.');
  await expect(header(page).getByRole('button')).toHaveCount(0);
});

test('keeps a merge going when its dialog is closed, and says how it went', async ({ page }) => {
  const ready = await create();
  answer(ready, {
    'view.json': view(ready),
    'graphql.json': GRAPHQL,
    'merge.sleep': '2',
    'merge.code': '1',
    'merge.stderr': 'X Pull request lonca-test/merge-fixture#7 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\n',
  });
  await page.goto(opened(ready.workspace));
  await header(page).getByRole('button', { name: 'Merge pull request #7' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge #7 into main?' });
  await dialog.getByRole('button', { name: 'Squash and merge' }).click();
  // Cancel says what it does now: the merge carries on without the dialog.
  await dialog.locator('.modal-actions').getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Merging… Opens GitHub.');
  // Merge can't be pressed while it merges, but it keeps focus, which the dialog just gave back to it.
  const merge = header(page).getByRole('button', { name: 'Merge pull request #7' });
  await expect(merge).toHaveAttribute('aria-disabled', 'true');
  await expect(merge).toBeFocused();
  // Forced, since Playwright itself waits for an aria-disabled button to be enabled before clicking it.
  await merge.click({ force: true });
  await expect(dialog).toBeHidden();
  await expect(merge).toBeFocused();
  await expect(page.locator('.toast').filter({ hasText: '#7 is not mergeable: the base branch policy prohibits the merge.' })).toBeVisible({ timeout: 30000 });
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Ready to merge. Opens GitHub.');

  // With the dialog still open, it says so there instead.
  await header(page).getByRole('button', { name: 'Merge pull request #7' }).click();
  answer(ready, { 'merge.sleep': null });
  await dialog.getByRole('button', { name: 'Squash and merge' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('#7 is not mergeable: the base branch policy prohibits the merge.');
  await expect(dialog).toBeVisible();
});

test('fits a narrow panel, and marks the panel’s button while the panel is closed', async ({ page }) => {
  const ready = await create();
  answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL });
  await page.addInitScript(() => localStorage.setItem('lonca.size.right', '240'));
  const current = { checks: scripted(ready, {}, { local: { head: ready.head, unpushed: 0, uncommitted: 3 } }) };
  await routeChecks(page, ready, current);
  await page.goto(opened(ready.workspace));
  await expect(status(page)).toHaveAccessibleName('Pull request #7: 3 not committed. Opens GitHub.');
  const fits = () => header(page).evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(await fits()).toBe(true);
  // The number goes first, and the button's icon, while the link keeps the number in its name.
  await expect(status(page).locator('.pr-number')).toBeHidden();
  await page.screenshot({ path: path.join(SHOTS, 'pr-header-240.png'), clip: { x: 1440 - 240, y: 0, width: 240, height: 60 } });
  // Read again by reloading: at this width the tabs below push Refresh out of the panel.
  for (const [pr, label] of [[{ state: 'MERGED' }, 'Merged'], [{ mergeStateStatus: 'BEHIND' }, 'Out of date'], [{ reviewDecision: 'CHANGES_REQUESTED' }, 'Changes requested']] as const) {
    current.checks = scripted(ready, pr);
    await page.reload();
    await expect(status(page)).toHaveAccessibleName(named(label));
    expect(await fits(), label).toBe(true);
  }

  current.checks = scripted(ready, {});
  await page.reload();
  await expect(status(page)).toHaveAccessibleName(named('Ready to merge'));
  const toggle = page.getByRole('button', { name: 'Hide the side panel' });
  await toggle.click();
  const closed = page.getByRole('button', { name: 'Show the side panel. #7 is ready to merge.' });
  await expect(closed.locator('.panel-dot')).toHaveCSS('background-color', 'rgb(143, 191, 127)');
  // A ring in the header's colour keeps it apart from the icon's strokes.
  await expect(closed.locator('.panel-dot')).toHaveCSS('box-shadow', 'rgb(27, 25, 23) 0px 0px 0px 2px');
  await page.screenshot({ path: path.join(SHOTS, 'pr-panel-dot.png'), clip: { x: 1440 - 400, y: 0, width: 400, height: 44 } });
  current.checks = scripted(ready, { state: 'MERGED' });
  // Coming back to the window reads it again, but not twice in a row.
  await page.waitForTimeout(2500);
  await page.evaluate('window.dispatchEvent(new Event("focus"))');
  await expect(page.getByRole('button', { name: 'Show the side panel. #7 is merged.' })).toBeVisible({ timeout: 10000 });
});

test('warns in the merge dialog of everything the header would, while it still offers Merge', async ({ page }) => {
  const ready = await create();
  const current = {
    checks: scripted(ready, { mergeStateStatus: 'UNSTABLE', reviewDecision: 'CHANGES_REQUESTED' }, {
      checks: [{ name: 'lint', status: 'success' }, { name: 'e2e', status: 'pending' }, { name: 'unit', status: 'pending' }],
      local: null,
    }),
  };
  await routeChecks(page, ready, current);
  await page.goto(opened(ready.workspace));
  await expect(status(page)).toHaveAccessibleName('Pull request #7: Changes requested. Opens GitHub.');
  await header(page).getByRole('button', { name: 'Merge pull request #7' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge #7 into main?' });
  await expect(dialog).toContainText('3 checks: 2 running, 1 passed');
  await expect(dialog.locator('.close-warning')).toHaveText([
    'Lonca couldn’t check whether everything here is in the pull request.',
    '2 checks are still running.',
    'Changes were requested on #7.',
  ]);
  await page.screenshot({ path: path.join(SHOTS, 'pr-merge-dialog-warnings.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(merges(ready)).toBe(0);
});

test('fits every label that sits beside Merge without cutting it short, hiding the number first where it must', async ({ page }) => {
  const ready = await create();
  const own = await lonca.api<{ id: string }>('POST', `/workspaces/${ready.workspace.id}/sessions`, {});
  const lead = (await lonca.api<{ sessions: { id: string; workspaceId: string; role?: string }[] }>('GET', '/state')).sessions
    .find((session) => session.workspaceId === ready.workspace.id && session.role === 'lead')!;
  const current = { checks: scripted(ready, {}) };
  await routeChecks(page, ready, current);
  const cut = () => status(page).locator('.pr-label').evaluate((label) => label.scrollWidth > label.clientWidth);
  const cases: [Record<string, unknown>, Partial<Checks>, string][] = [
    [{}, {}, 'Ready to merge'],
    [{ mergeStateStatus: 'UNSTABLE' }, { checks: [{ name: 'a', status: 'failure' }, { name: 'b', status: 'failure' }] }, '2 checks failing'],
    [{ mergeStateStatus: 'UNSTABLE' }, {}, 'Checks not passing'],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, {}, 'Changes requested'],
    [{}, { local: { head: 'e'.repeat(40), unpushed: 12, uncommitted: 0 } }, '12 not pushed'],
    [{}, { local: null }, 'Local work unknown'],
    [{}, { local: { head: 'e'.repeat(40), unpushed: null, uncommitted: 0 } }, 'Differs from the PR'],
    [{}, { local: { head: ready.head, unpushed: 0, uncommitted: 250 } }, '99+ not committed'],
    [{}, { checks: [{ name: 'e2e', status: 'pending' }] }, 'Checks running'],
  ];
  // The default width, and either side of where the number goes: the last with it, the first without.
  for (const [width, numbered] of [[340, true], [332, true], [331, false]] as const) {
    await page.unroute('**/api/state');
    await page.goto(opened(ready.workspace));
    // The link's token is only kept once the page has connected, and a reload before then would lose it.
    await expect(page.getByRole('tab', { name: 'Checks' })).toBeVisible();
    await page.evaluate(`localStorage.setItem('lonca.size.right', '${width}')`);
    await page.reload();
    for (const [pr, extra, label] of cases) {
      current.checks = scripted(ready, pr, extra);
      await refresh(page);
      await expect(status(page)).toHaveAccessibleName(named(label));
      await expect(header(page).getByRole('button', { name: 'Merge pull request #7' })).toBeVisible();
      await expect(status(page).locator('.pr-number')).toBeVisible({ visible: numbered });
      expect(await cut(), `${label} at ${width}px`).toBe(false);
    }
    current.checks = scripted(ready, {});
    for (const [sessions, label] of [[[lead.id], 'Lead is working'], [[own.id], 'An agent is working']] as const) {
      await page.unroute('**/api/state');
      await routeWorking(page, [...sessions]);
      await page.reload();
      await expect(status(page)).toHaveAccessibleName(named(label));
      await expect(header(page).getByRole('button', { name: 'Merge pull request #7' })).toBeVisible();
      expect(await cut(), `${label} at ${width}px`).toBe(false);
      if (width === 340) {
        await page.screenshot({ path: path.join(SHOTS, `pr-header-${label.toLowerCase().replaceAll(' ', '-')}.png`), clip: { x: 1440 - 340, y: 0, width: 340, height: 60 } });
      }
    }
  }
});

test('leaves focus where the user moved it while a merge finished', async ({ page }) => {
  const ready = await create();
  answer(ready, {
    'view.json': view(ready),
    'graphql.json': GRAPHQL,
    'merge.sleep': '3',
    'after-view.json': view(ready, { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
  });
  await page.goto(opened(ready.workspace));
  await header(page).getByRole('button', { name: 'Merge pull request #7' }).click();
  await page.getByRole('dialog', { name: 'Merge #7 into main?' }).getByRole('button', { name: 'Squash and merge' }).click();
  // Search, opened over the merge dialog while it merges, keeps focus when the merge is done.
  await page.keyboard.press('Control+k');
  const search = page.getByRole('textbox', { name: 'Search workspaces, projects and files' });
  await expect(search).toBeFocused();
  await expect(page.locator('.toast').filter({ hasText: 'Merged #7 into main.' })).toBeVisible({ timeout: 30000 });
  await expect(header(page).getByRole('button', { name: 'Archive this workspace' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(search).toBeFocused();
});

test('gives focus to the pull request’s link when the Merge that opened the dialog has gone', async ({ page }) => {
  const ready = await create();
  // A base branch with a merge queue reports BLOCKED until a pull request goes through it.
  answer(ready, {
    'view.json': view(ready, { mergeStateStatus: 'BLOCKED' }),
    'graphql.json': queueGraphql(false),
    'after-graphql.json': queueGraphql(true),
  });
  await page.goto(opened(ready.workspace));
  await expect(status(page)).toHaveAccessibleName(named('Ready to merge'));
  const merge = header(page).getByRole('button', { name: 'Merge pull request #7' });
  await merge.click();
  const dialog = page.getByRole('dialog', { name: 'Merge #7 into main?' });
  await expect(dialog).toContainText('main uses a merge queue, so GitHub merges #7 from it when it’s ready.');
  await expect(dialog.getByRole('radiogroup')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add to merge queue' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.toast').filter({ hasText: 'GitHub will merge #7 when it’s ready.' })).toBeVisible();
  await expect(status(page)).toHaveAccessibleName(named('Queued to merge'));
  await expect(status(page)).toBeFocused();

  // Merged elsewhere, by an agent perhaps, while the dialog was open.
  answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL, 'after-graphql.json': null });
  await refresh(page);
  await expect(status(page)).toHaveAccessibleName(named('Ready to merge'));
  await merge.click();
  await expect(dialog).toBeVisible();
  answer(ready, { 'view.json': view(ready, { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }) });
  // Coming back to the window reads it again.
  await page.waitForTimeout(2500);
  await page.evaluate('window.dispatchEvent(new Event("focus"))');
  await expect(status(page)).toHaveAccessibleName(named('Merged'));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toBeFocused();
  expect(merges(ready)).toBe(1);
});

test('stops showing a merge as under way once the workspace stops, or once it’s given up on', async ({ page }) => {
  const ready = await create();
  answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL });
  // Time runs as usual, and can be moved on.
  await page.clock.install();
  await page.goto(opened(ready.workspace));
  // gh finishes, but GitHub still says it's open.
  const mergeLeftPending = async () => {
    await header(page).getByRole('button', { name: 'Merge pull request #7' }).click();
    await page.getByRole('dialog', { name: 'Merge #7 into main?' }).getByRole('button', { name: 'Squash and merge' }).click();
    await expect(page.locator('.toast').filter({ hasText: 'GitHub accepted the merge, but #7 isn’t merged yet. Lonca keeps checking.' }).first()).toBeVisible();
    await expect(status(page)).toHaveAccessibleName(named('Merging…'));
  };
  await mergeLeftPending();
  // GitHub usually shows it in seconds. After two minutes, Lonca stops waiting for it.
  await page.clock.fastForward('02:01');
  await expect(status(page)).toHaveAccessibleName(named('Ready to merge'));

  await mergeLeftPending();
  await lonca.api('POST', `/workspaces/${ready.workspace.id}/stop`);
  await expect(page.locator('.workspace-banner')).toContainText('is stopped');
  await expect(status(page)).toHaveAccessibleName(named('Open'));
  await expect(status(page)).toHaveClass(/is-stale/);
});

test('reads only while the page is visible, and once for a return that brings both focus and visibility', async ({ page }) => {
  const ready = await create();
  answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL });
  // The page starts hidden, as one opened in a background tab is.
  await page.addInitScript(`
    let hidden = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    window.setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  `);
  let reads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/workspaces/${ready.workspace.id}/checks`)) reads++;
  });
  await page.goto(opened(ready.workspace));
  await expect(page.locator('[data-step="sandbox"]')).toContainText('Running in its own virtual machine');
  await page.waitForTimeout(3000);
  expect(reads).toBe(0);

  await page.evaluate('window.setHidden(false)');
  await expect(status(page)).toHaveAccessibleName(named('Ready to merge'));
  expect(reads).toBe(1);
  // Coming back to a window usually brings both events together. They read it once between them.
  await page.waitForTimeout(2500);
  await page.evaluate('window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"))');
  await page.waitForTimeout(1500);
  expect(reads).toBe(2);
  // Even when the second comes once the first one's read is done.
  await page.waitForTimeout(1500);
  await page.evaluate('window.dispatchEvent(new Event("focus"))');
  await expect.poll(() => reads).toBe(3);
  await page.waitForTimeout(600);
  await page.evaluate('document.dispatchEvent(new Event("visibilitychange"))');
  await page.waitForTimeout(1000);
  expect(reads).toBe(3);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('reads the pull request with the panel closed, and merges from a sheet', async ({ page }) => {
    const ready = await create();
    answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL });
    await page.goto(opened(ready.workspace));
    // The side panel starts closed on a phone, and its button says what's waiting.
    const toggle = page.getByRole('button', { name: 'Show the side panel. #7 is ready to merge.' });
    await expect(toggle.locator('.panel-dot')).toBeVisible();
    await toggle.tap();
    const merge = header(page).getByRole('button', { name: 'Merge pull request #7' });
    // Below the touch areas of the header's buttons, which reach down into the panel, at either width.
    const clearance = () => page.evaluate(`(() => {
      const merge = document.querySelector('.right-header button[aria-label="Merge pull request #7"]').getBoundingClientRect();
      const reach = [...document.querySelectorAll('.workspace-header button')].map((button) => {
        const box = button.getBoundingClientRect();
        if (box.width === 0) return 0;
        const after = getComputedStyle(button, '::after');
        const below = after.content !== 'none' && after.position === 'absolute' ? Math.max(0, -parseFloat(after.bottom) || 0) : 0;
        return box.bottom + below;
      });
      return { top: merge.top, reach: Math.max(...reach), buttons: reach.filter((bottom) => bottom > 0).length };
    })()`) as Promise<{ top: number; reach: number; buttons: number }>;
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(merge).toBeVisible();
      const { top, reach, buttons } = await clearance();
      expect(buttons, `header buttons at ${width}px`).toBeGreaterThan(2);
      expect(top, `Merge at ${width}px`).toBeGreaterThanOrEqual(reach);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await merge.tap();

    const dialog = page.getByRole('dialog', { name: 'Merge #7 into main?' });
    const [confirm, cancel] = await Promise.all(['Squash and merge', 'Cancel'].map(async (name) => {
      const found = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(found.height).toBe(44);
      return found.y;
    }));
    expect(confirm).toBeLessThan(cancel);
    expect((await dialog.locator('.merge-methods').boundingBox())!.height).toBe(40);
    const sheet = (await dialog.boundingBox())!;
    expect(sheet.y + sheet.height).toBe(844);
    await page.screenshot({ path: path.join(SHOTS, 'pr-merge-sheet.png') });
    await dialog.getByRole('button', { name: 'Cancel' }).tap();
    await expect(dialog).toBeHidden();
    expect(merges(ready)).toBe(0);
  });

  test('keeps a long base branch’s name inside the merge sheet', async ({ page }) => {
    const ready = await create();
    // One long word, with nowhere a browser would break it by itself.
    const base = 'release_candidate_for_the_customer_integration_environment_20261109';
    await routeChecks(page, ready, { checks: scripted(ready, { baseRefName: base }) });
    await page.goto(opened(ready.workspace));
    await page.getByRole('button', { name: 'Show the side panel. #7 is ready to merge.' }).tap();
    await header(page).getByRole('button', { name: 'Merge pull request #7' }).tap();
    const dialog = page.getByRole('dialog', { name: `Merge #7 into ${base}?` });
    await expect(dialog).toBeVisible();
    const close = (await dialog.locator('.modal-header').getByRole('button', { name: 'Close' }).boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(390);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, 'pr-merge-sheet-long-base.png') });
  });

  test('a double tap on Merge can’t land on what opens under it', async ({ page }) => {
    const ready = await create();
    answer(ready, { 'view.json': view(ready), 'graphql.json': GRAPHQL });
    await page.goto(opened(ready.workspace));
    await page.getByRole('button', { name: 'Show the side panel. #7 is ready to merge.' }).tap();
    await header(page).getByRole('button', { name: 'Merge pull request #7' }).waitFor();

    const reachable = await page.evaluate(`(async () => {
      document.querySelector('.right-header button[aria-label="Merge pull request #7"]').click();
      const button = await new Promise((resolve) => {
        const look = () => {
          const found = [...document.querySelectorAll('.modal-actions .button')].find((entry) => entry.textContent === 'Squash and merge');
          if (found) resolve(found); else requestAnimationFrame(look);
        };
        look();
      });
      const box = button.getBoundingClientRect();
      const underFinger = () => document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
      const atFirst = underFinger();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { atFirst, afterAMoment: underFinger() };
    })()`);
    expect(reachable).toEqual({ atFirst: false, afterAMoment: true });
    expect(merges(ready)).toBe(0);
  });
});
