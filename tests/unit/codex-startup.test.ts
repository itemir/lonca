import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project, Workspace } from '../../shared/types.ts';

vi.mock('../../server/ssh-agent.ts', () => ({ emptyAgent: async () => '' }));
vi.mock('../../server/system.ts', () => ({
  system: { sandbox: { state: 'ready' } },
  checkSandboxes: async () => {},
  ensureSandboxImage: async () => 'template',
  ensureCustomTemplate: async () => 'template',
}));

let root: string;
let project: Project;
let workspace: Workspace;
let lifecycle: typeof import('../../server/workspaces.ts');
const pending: Promise<unknown>[] = [];
const track = <T>(promise: Promise<T>) => { pending.push(promise); return promise; };
const file = (name: string) => path.join(root, name);
const release = (name: string) => fs.rmSync(file(`hold-${name}`), { force: true });
const key = () => JSON.parse(fs.readFileSync(file('auth.json'), 'utf8')).OPENAI_API_KEY;
const PLACEHOLDER = 'oai-oat01-lonca-placeholder';

beforeEach(async () => {
  vi.resetModules();
  pending.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-codex-startup-'));
  vi.stubEnv('LONCA_HOME', root);
  vi.stubEnv('LONCA_SBX', file('sbx'));
  vi.stubEnv('LONCA_TEST_CODEX_RUNTIME', root);
  fs.writeFileSync(file('running'), '1');
  // Real lifecycle and sandbox code, with a CLI that records credentials and lets a test
  // hold a boot write or checkout creation while settings change on the host.
  fs.writeFileSync(file('sbx'), `#!${process.execPath}
const fs = require('node:fs');
const root = process.env.LONCA_TEST_CODEX_RUNTIME;
const args = process.argv.slice(2);
const hold = async (name) => {
  while (fs.existsSync(root + '/hold-' + name)) await new Promise(r => setTimeout(r, 10));
};
(async () => {
  if (args[0] === 'ls') return process.stdout.write(JSON.stringify([
    { name: 'vm', status: fs.readFileSync(root + '/running', 'utf8') === '1' ? 'running' : 'stopped' },
  ]));
  if (args[0] === 'stop' || args[0] === 'rm') fs.writeFileSync(root + '/running', '0');
  if (args[0] === 'run') fs.writeFileSync(root + '/running', '1');
  if (args[0] !== 'exec') return;
  if (args.includes('lonca-codex-setup')) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const first = !fs.existsSync(root + '/setup-entered');
    fs.writeFileSync(root + '/setup-entered', '');
    if (first) await hold('setup');
    fs.writeFileSync(root + '/auth.json', Buffer.concat(chunks));
  }
  if (args.includes('lonca-worktree')) {
    fs.writeFileSync(root + '/worktree-entered', '');
    await hold('worktree');
  }
})();
`, { mode: 0o700 });
  project = {
    id: 'p', name: 'Project', slug: 'p', remoteUrl: 'https://example.invalid/repo', localPath: null,
    githubOwner: null, status: 'ready', createdAt: 1,
    settings: { defaultBranch: 'main', env: { OPENAI_API_KEY: 'sk-first' }, image: '', network: 'internet', filesToCopy: [], setupScript: 'true', memoryGb: 0, cpus: 0 },
  };
  workspace = {
    id: 'w', projectId: project.id, name: 'prague', title: null, sandboxName: 'vm', status: 'ready', path: file('checkout'),
    branch: 'test/prague', baseBranch: 'main', port: 52000, steps: [], filesCopied: 0, diff: null, createdAt: 1, updatedAt: 1,
  };
  const { state } = await import('../../server/store.ts');
  state.projects.push(project);
  state.workspaces.push(workspace);
  lifecycle = await import('../../server/workspaces.ts');
});

afterEach(async () => {
  release('setup');
  release('worktree');
  await Promise.allSettled(pending);
  const store = await import('../../server/store.ts');
  store.flushState();
  vi.unstubAllEnvs();
  fs.rmSync(root, { force: true, recursive: true });
});

it('keeps the latest key when an update overlaps the first boot after a server restart', async () => {
  fs.writeFileSync(file('hold-setup'), '');
  const boot = track(lifecycle.runningSandbox(workspace));
  await vi.waitFor(() => expect(fs.existsSync(file('setup-entered'))).toBe(true));
  project.settings.env = {};
  const update = track(lifecycle.applyCodexSetup(project));
  // An unordered update finishes ahead of the held boot write. A queued one waits for it.
  await Promise.race([update, new Promise((resolve) => setTimeout(resolve, 1000))]);
  release('setup');
  await Promise.all([boot, update]);
  expect(key()).toBe(PLACEHOLDER);
});

it.each(['create', 'restore'] as const)('keeps a key change made while %s prepares the checkout', async (operation) => {
  fs.writeFileSync(file('hold-worktree'), '');
  const provisioned = track(new Promise<void>((resolve) => lifecycle.setSetupScriptStarter(async () => resolve())));
  workspace.status = 'error';
  workspace.pendingOperation = operation;
  lifecycle.retryWorkspace(workspace);
  await vi.waitFor(() => expect(fs.existsSync(file('worktree-entered'))).toBe(true));
  expect(key()).toBe('sk-first');
  project.settings.env = {};
  const update = track(lifecycle.applyCodexSetup(project));
  release('worktree');
  await Promise.all([provisioned, update]);
  expect(workspace.status).toBe('ready');
  expect(key()).toBe(PLACEHOLDER);
});

it.each(['start', 'rebuild'] as const)('keeps a key change made while %s is booting', async (operation) => {
  fs.writeFileSync(file('hold-setup'), '');
  workspace.status = 'stopped';
  fs.writeFileSync(file('running'), '0');
  const boot = track(operation === 'start' ? lifecycle.startWorkspace(workspace) : lifecycle.rebuildWorkspace(workspace));
  await vi.waitFor(() => expect(fs.existsSync(file('setup-entered'))).toBe(true));
  project.settings.env = { OPENAI_API_KEY: 'sk-latest' };
  const update = track(lifecycle.applyCodexSetup(project));
  release('setup');
  await Promise.all([boot, update]);
  expect(workspace.status).toBe('ready');
  expect(key()).toBe('sk-latest');
});

it('updates the running VM of a failed creation before the workspace is retried', async () => {
  await lifecycle.runningSandbox(workspace);
  // Provisioning can fail after the VM has booted, leaving it to be reused by the retry.
  workspace.status = 'error';
  workspace.pendingOperation = 'create';
  project.settings.env = {};
  await lifecycle.applyCodexSetup(project);
  const provisioned = track(new Promise<void>((resolve) => lifecycle.setSetupScriptStarter(async () => resolve())));
  lifecycle.retryWorkspace(workspace);
  await provisioned;
  expect(workspace.status).toBe('ready');
  expect(key()).toBe(PLACEHOLDER);
});

it('leaves a workspace stopped when a credential update was requested while it was stopping', async () => {
  await lifecycle.runningSandbox(workspace);
  const stopping = track(lifecycle.stopWorkspace(workspace));
  project.settings.env = {};
  const update = track(lifecycle.applyCodexSetup(project));
  await Promise.all([stopping, update]);
  expect(workspace.status).toBe('stopped');
  expect(fs.readFileSync(file('running'), 'utf8')).toBe('0');
  expect(key()).toBe('sk-first');
  await lifecycle.startWorkspace(workspace);
  expect(key()).toBe(PLACEHOLDER);
});
