import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project, Session, Workspace, WorkspaceOperation } from '../../shared/types.ts';
import { archiveWorkspace, deleteWorkspace, markInterruptedWork, retryWorkspace, runningContainer, setSetupScriptStarter } from '../../server/workspaces.ts';
import { RuntimeStoppedError } from '../../server/util.ts';

const { state, flushState, execText, ensureContainer } = vi.hoisted(() => ({
  state: { projects: [] as Project[], workspaces: [] as Workspace[], sessions: [] as Session[] },
  flushState: vi.fn(), execText: vi.fn(async () => ''), ensureContainer: vi.fn(async () => 'container'),
}));

vi.mock('../../server/store.ts', () => ({ state, flushState, saveState: vi.fn(), deleteTranscript: vi.fn(),
  getProject: (id: string) => state.projects.find((entry) => entry.id === id),
  getWorkspace: (id: string) => state.workspaces.find((entry) => entry.id === id), getSecrets: () => ({}),
}));
vi.mock('../../server/system.ts', () => ({ system: { sandbox: { state: 'off' } }, secretEnv: () => [],
  ensureImage: async () => 'image', ensureSandboxImage: vi.fn(), ensureCustomTemplate: vi.fn(), checkSandboxes: vi.fn(),
}));
vi.mock('../../server/containers.ts', () => ({ ensureContainer, isContainerRunning: async () => true, stopContainer: vi.fn() }));
vi.mock('../../server/docker.ts', () => ({ execText, exec: async () => ({ code: 0 }), homeVolume: () => 'home', removeContainer: vi.fn(), removeVolume: vi.fn() }));
vi.mock('../../server/projects.ts', () => ({ refreshFromLocalRepo: vi.fn(), projectLifecycle: {} }));

let workspace: Workspace;
let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-recovery-unit-'));
  state.projects = [{ id: 'p', name: 'Project', slug: 'p', remoteUrl: null, localPath: null,
    settings: { image: '', setupScript: 'setup', filesToCopy: [], network: 'internet' } } as unknown as Project];
  workspace = { id: 'w', projectId: 'p', name: 'amman', path: dir, containerName: 'container', status: 'error',
    branch: 'test/amman', baseBranch: 'main', filesCopied: 0,
    steps: ['image', 'container', 'worktree', 'files', 'setup'].map((id) => ({ id, status: 'pending' })),
  } as Workspace;
  state.workspaces = [workspace];
  state.sessions = [];
  setSetupScriptStarter(async () => {});
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it.each([
  ['creating', 'create'], ['restoring', 'restore'], ['starting', 'start'], ['stopping', 'stop'],
  ['rebuilding', 'rebuild'], ['archiving', 'archive'], ['deleting', 'delete'],
] as const)('preserves an interrupted %s operation across repeated restarts', (status, operation) => {
  workspace.status = status;
  workspace.pendingOperation = operation;
  markInterruptedWork();
  expect(workspace).toMatchObject({ status: 'error', pendingOperation: operation });
  markInterruptedWork();
  expect(workspace).toMatchObject({ status: 'error', pendingOperation: operation });
});

it('does not touch runtime or checkout resources when saving operation intent fails', async () => {
  workspace.status = 'ready';
  flushState.mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(archiveWorkspace(workspace)).rejects.toThrow('disk full');
  expect(workspace).toMatchObject({ status: 'error', pendingOperation: 'archive' });
  expect(ensureContainer).not.toHaveBeenCalled();
  expect(execText).not.toHaveBeenCalled();
});

it.each(['create', 'restore'] as WorkspaceOperation[])('keeps %s usable when launching its setup script fails', async (operation) => {
  workspace.pendingOperation = operation;
  setSetupScriptStarter(async () => { throw new Error('setup launch failed'); });
  retryWorkspace(workspace);
  await vi.waitFor(() => expect(workspace.steps.find((step) => step.id === 'setup')).toMatchObject({ status: 'error', detail: 'setup launch failed' }));
  expect(workspace.status).toBe('ready');
  expect(workspace.pendingOperation).toBeUndefined();
  expect(() => retryWorkspace(workspace)).toThrow('ready');
});

it('does not recreate a runtime when duplicate deletions were queued before removal finished', async () => {
  workspace.status = 'ready';
  await Promise.all([deleteWorkspace(workspace), deleteWorkspace(workspace)]);
  expect(state.workspaces).toEqual([]);
  expect(ensureContainer).toHaveBeenCalledTimes(1);
});

it('keeps the saved runtime state when a passive lookup cannot reach Docker', async () => {
  workspace.status = 'ready';
  ensureContainer.mockRejectedValueOnce(new Error('Docker is unreachable'));
  await expect(runningContainer(workspace)).rejects.toThrow('Docker is unreachable');
  expect(workspace.status).toBe('ready');
});

it.each(['in progress', 'completed'] as const)('does not overwrite a newer lifecycle operation that is %s when an old lookup reports stopped', async (phase) => {
  workspace.status = 'ready';
  workspace.updatedAt = 1;
  let reject!: (error: Error) => void;
  ensureContainer.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const lookup = runningContainer(workspace);
  workspace.status = phase === 'in progress' ? 'rebuilding' : 'ready';
  workspace.pendingOperation = phase === 'in progress' ? 'rebuild' : undefined;
  workspace.updatedAt = 2;
  reject(new RuntimeStoppedError('The old runtime stopped'));
  await expect(lookup).rejects.toThrow();
  expect(workspace.status).toBe(phase === 'in progress' ? 'rebuilding' : 'ready');
});
