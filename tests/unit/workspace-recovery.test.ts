import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Project, Session, Workspace, WorkspaceOperation } from '../../shared/types.ts';
import { archiveWorkspace, deleteWorkspace, markInterruptedWork, retryWorkspace, runningSandbox, setSetupScriptStarter } from '../../server/workspaces.ts';
import { RuntimeStoppedError } from '../../server/util.ts';

const { state, flushState, execText, ensureSandbox, stopSandbox } = vi.hoisted(() => ({
  state: { projects: [] as Project[], workspaces: [] as Workspace[], sessions: [] as Session[] },
  flushState: vi.fn(), execText: vi.fn(async () => ''), ensureSandbox: vi.fn(async () => 'box'), stopSandbox: vi.fn(async () => {}),
}));

vi.mock('../../server/store.ts', () => ({ state, flushState, saveState: vi.fn(), deleteTranscript: vi.fn(),
  getProject: (id: string) => state.projects.find((entry) => entry.id === id),
  getWorkspace: (id: string) => state.workspaces.find((entry) => entry.id === id), getSecrets: () => ({}), boundaryValue: () => undefined,
}));
vi.mock('../../server/system.ts', () => ({ system: { sandbox: { state: 'ready' } },
  ensureSandboxImage: vi.fn(), ensureCustomTemplate: vi.fn(), checkSandboxes: vi.fn(),
}));
vi.mock('../../server/sandbox.ts', () => ({ ensureSandbox, isSandboxRunning: async () => true, stopSandbox, sandboxState: async () => 'running', execText, exec: async () => ({ code: 0 }), removeSandbox: vi.fn() }));
vi.mock('../../server/projects.ts', () => ({ refreshFromLocalRepo: vi.fn(), projectLifecycle: {} }));

let workspace: Workspace;
let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-recovery-unit-'));
  state.projects = [{ id: 'p', name: 'Project', slug: 'p', remoteUrl: null, localPath: null,
    settings: { image: '', setupScript: 'setup', filesToCopy: [], network: 'internet', env: {} } } as unknown as Project];
  workspace = { id: 'w', projectId: 'p', name: 'amman', path: dir, sandboxName: 'box', status: 'error',
    branch: 'test/amman', baseBranch: 'main', filesCopied: 0,
    steps: ['image', 'sandbox', 'worktree', 'files', 'setup'].map((id) => ({ id, status: 'pending' })),
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

it('does not touch the sandbox or checkout resources when saving operation intent fails', async () => {
  workspace.status = 'ready';
  flushState.mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(archiveWorkspace(workspace)).rejects.toThrow('disk full');
  expect(workspace).toMatchObject({ status: 'error', pendingOperation: 'archive' });
  expect(ensureSandbox).not.toHaveBeenCalled();
  expect(execText).not.toHaveBeenCalled();
});

it.each(['archive', 'delete'] as const)('shuts the runtime down when %s fails starting it for cleanup', async (operation) => {
  workspace.status = 'ready';
  // Booting can fail with the runtime already up, for the fallback as well as the first attempt.
  ensureSandbox.mockRejectedValueOnce(new Error('boot failed')).mockRejectedValueOnce(new Error('boot failed again'));
  await expect(operation === 'archive' ? archiveWorkspace(workspace) : deleteWorkspace(workspace)).rejects.toThrow('boot failed again');
  expect(workspace).toMatchObject({ status: 'error', pendingOperation: operation });
  expect(stopSandbox.mock.invocationCallOrder.at(-1)).toBeGreaterThan(ensureSandbox.mock.invocationCallOrder.at(-1)!);
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
  expect(ensureSandbox).toHaveBeenCalledTimes(1);
});

it('keeps the saved runtime state when a passive lookup cannot reach Docker', async () => {
  workspace.status = 'ready';
  ensureSandbox.mockRejectedValueOnce(new Error('Docker is unreachable'));
  await expect(runningSandbox(workspace)).rejects.toThrow('Docker is unreachable');
  expect(workspace.status).toBe('ready');
});

it.each(['in progress', 'completed'] as const)('does not overwrite a newer lifecycle operation that is %s when an old lookup reports stopped', async (phase) => {
  workspace.status = 'ready';
  workspace.updatedAt = 1;
  let reject!: (error: Error) => void;
  ensureSandbox.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const lookup = runningSandbox(workspace);
  workspace.status = phase === 'in progress' ? 'rebuilding' : 'ready';
  workspace.pendingOperation = phase === 'in progress' ? 'rebuild' : undefined;
  workspace.updatedAt = 2;
  reject(new RuntimeStoppedError('The old runtime stopped'));
  await expect(lookup).rejects.toThrow();
  expect(workspace.status).toBe(phase === 'in progress' ? 'rebuilding' : 'ready');
});
