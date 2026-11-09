// Archiving from the trash icon after the user said not to be asked: the server has the last word,
// since only it knows for sure whether an agent is working and what's uncommitted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Profile, Project, Session, Workspace } from '../../shared/types.ts';
import { archiveWorkspace } from '../../server/workspaces.ts';

const { state, exec, execText, stopSandbox } = vi.hoisted(() => ({
  state: {
    settings: { confirmArchive: false },
    projects: [] as Project[], workspaces: [] as Workspace[], sessions: [] as Session[],
    profiles: [{ id: 'claude', agent: 'claude', name: '' }, { id: 'codex', agent: 'codex', name: '' }] as Profile[],
  },
  exec: vi.fn(), execText: vi.fn(async () => ''), stopSandbox: vi.fn(async () => {}),
}));

vi.mock('../../server/store.ts', () => ({ state, flushState: vi.fn(), saveState: vi.fn(), deleteTranscript: vi.fn(),
  getProject: (id: string) => state.projects.find((entry) => entry.id === id),
  getWorkspace: (id: string) => state.workspaces.find((entry) => entry.id === id), getSecrets: () => ({}), boundaryValue: () => undefined,
  claudeCredential: () => undefined,
}));
vi.mock('../../server/system.ts', () => ({ system: { sandbox: { state: 'ready' } },
  ensureSandboxImage: vi.fn(), ensureCustomTemplate: vi.fn(), checkSandboxes: vi.fn(),
}));
vi.mock('../../server/sandbox.ts', () => ({ ensureSandbox: async () => 'box', isSandboxRunning: async () => true, stopSandbox,
  sandboxState: async () => 'running', exec, execText, removeSandbox: vi.fn() }));
vi.mock('../../server/projects.ts', () => ({ refreshFromLocalRepo: vi.fn(), projectLifecycle: {} }));

const gitStatus = (stdout: string, code = 0) => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(''), truncated: false });

let workspace: Workspace;
let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  exec.mockResolvedValue(gitStatus(''));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-archive-unit-'));
  state.settings.confirmArchive = false;
  state.projects = [{ id: 'p', name: 'Project', slug: 'p', remoteUrl: null, localPath: null,
    settings: { image: '', setupScript: '', filesToCopy: [], network: 'internet', env: {} } } as unknown as Project];
  workspace = { id: 'w', projectId: 'p', name: 'amman', path: dir, sandboxName: 'box', status: 'ready',
    branch: 'test/amman', baseBranch: 'main', filesCopied: 0, steps: [] } as unknown as Workspace;
  state.workspaces = [workspace];
  state.sessions = [{ id: 's', workspaceId: 'w', status: 'idle', activeRunId: null } as Session];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function expectUntouched(): void {
  expect(workspace.status).toBe('ready');
  expect(stopSandbox).not.toHaveBeenCalled();
  expect(execText).not.toHaveBeenCalled();
}

it('archives when nothing is uncommitted and no agent is working', async () => {
  await expect(archiveWorkspace(workspace, { asked: false })).resolves.toBe(true);
  expect(workspace.status).toBe('archived');
  // New files and changes in submodules count even where the repository's settings hide them.
  expect(exec).toHaveBeenCalledWith('box', ['git', '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'],
    expect.objectContaining({ workdir: dir }));
});

it('asks when Settings says to, whatever the page thought', async () => {
  state.settings.confirmArchive = true;
  await expect(archiveWorkspace(workspace, { asked: false })).resolves.toBe(false);
  expectUntouched();
  expect(exec).not.toHaveBeenCalled();
});

it('asks while an agent is working, without counting', async () => {
  state.sessions[0].status = 'running';
  await expect(archiveWorkspace(workspace, { asked: false })).resolves.toBe(false);
  expectUntouched();
  expect(exec).not.toHaveBeenCalled();
});

it('asks about a workspace that isn’t running, without waking it', async () => {
  workspace.status = 'stopped';
  await expect(archiveWorkspace(workspace, { asked: false })).resolves.toBe(false);
  expect(workspace.status).toBe('stopped');
  expect(exec).not.toHaveBeenCalled();
});

it.each([
  ['there are uncommitted changes', () => exec.mockResolvedValue(gitStatus('?? new.txt\n'))],
  ['git fails, as it does with a broken index', () => exec.mockResolvedValue(gitStatus('', 128))],
  ['git takes too long', () => exec.mockResolvedValue(gitStatus('', 124))],
  ['the sandbox can’t be reached', () => exec.mockRejectedValue(new Error('Timed out running git in the workspace’s sandbox'))],
])('asks when %s', async (_case, arrange) => {
  arrange();
  await expect(archiveWorkspace(workspace, { asked: false })).resolves.toBe(false);
  expectUntouched();
});

it('asks when an agent starts while it counts', async () => {
  exec.mockImplementation(async () => {
    state.sessions[0].status = 'running';
    return gitStatus('');
  });
  await expect(archiveWorkspace(workspace, { asked: false })).resolves.toBe(false);
  expectUntouched();
});

it('archives without checking once the user has been asked', async () => {
  state.sessions[0].status = 'running';
  state.settings.confirmArchive = true;
  await expect(archiveWorkspace(workspace)).resolves.toBe(true);
  expect(workspace.status).toBe('archived');
  expect(exec).not.toHaveBeenCalledWith('box', expect.arrayContaining(['status']), expect.anything());
});
