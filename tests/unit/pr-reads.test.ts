import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Workspace } from '../../shared/types.ts';

const { project, workspaces, exec, published } = vi.hoisted(() => ({
  project: {
    id: 'p', name: 'lonca', slug: 'lonca', remoteUrl: 'https://github.com/itemir/lonca.git', localPath: null, githubOwner: 'itemir',
    status: 'ready', createdAt: 0, settings: { env: { GH_TOKEN: 'placeholder' } },
  } as unknown as Project,
  workspaces: [] as Workspace[],
  exec: vi.fn(),
  published: [] as string[],
}));

vi.mock('../../server/sandbox.ts', () => ({ exec, execText: vi.fn() }));
vi.mock('../../server/env.ts', () => ({ execEnv: () => [] }));
vi.mock('../../server/store.ts', () => ({
  getProject: () => project,
  getSecrets: () => ({}),
  getWorkspace: (id: string) => workspaces.find((workspace) => workspace.id === id),
}));
vi.mock('../../server/workspaces.ts', () => ({
  runningSandbox: async () => 'sandbox',
  publishWorkspace: (workspace: Workspace) => published.push(workspace.pr?.state ?? 'none'),
}));

const { getChecks } = await import('../../server/inspect.ts');

const HEAD = 'a'.repeat(40);
const answer = (stdout: string, code = 0) => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(''), truncated: false });
const view = (state: string) => JSON.stringify({
  number: 7, title: 'T', url: 'https://github.com/itemir/lonca/pull/7', state, isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE',
  mergeStateStatus: state === 'OPEN' ? 'CLEAN' : 'UNKNOWN', statusCheckRollup: [], headRefOid: HEAD, baseRefName: 'main',
  createdAt: '2026-11-02T10:00:00Z', mergedAt: null, closedAt: null,
});

describe('reads that overlap', () => {
  let workspace: Workspace;

  beforeEach(() => {
    workspace = {
      id: 'w', name: 'salzburg', branch: 'itemir/salzburg', path: '/w', status: 'ready', createdAt: Date.parse('2026-11-01T00:00:00Z'), pr: null,
    } as Workspace;
    workspaces.splice(0, workspaces.length, workspace);
    published.length = 0;
    // Both reads begin in the same millisecond, which a comparison of times can't put in order.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-09T12:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    exec.mockReset();
  });

  it('keeps the newer read when an older one finishes after it', async () => {
    let finishOlder!: () => void;
    const olderView = new Promise<void>((resolve) => { finishOlder = resolve; });
    let views = 0;
    exec.mockImplementation(async (_sandbox: string, cmd: string[]) => {
      if (cmd[1] === 'pr' && cmd[2] === 'view') {
        // The first read began first, and saw the pull request before it was merged, but GitHub was slow to say so.
        if (++views === 1) {
          await olderView;
          return answer(view('OPEN'));
        }
        return answer(view('MERGED'));
      }
      if (cmd[1] === 'api') return answer('{"data":{"repository":null}}');
      return answer(`${HEAD} 0 0\n`);
    });

    const older = getChecks(workspace);
    const newer = getChecks(workspace);
    expect((await newer).pr?.state).toBe('MERGED');
    expect(workspace.pr?.state).toBe('MERGED');
    finishOlder();
    // Its own answer is still what it saw, but it doesn't replace what the workspace keeps.
    expect((await older).pr?.state).toBe('OPEN');
    expect(workspace.pr?.state).toBe('MERGED');
    expect(published).toEqual(['MERGED']);
  });

  it('starts nothing more in the VM once Stop has begun, since that would start it again', async () => {
    exec.mockImplementation(async (_sandbox: string, cmd: string[]) => {
      // Stop begins while GitHub answers.
      if (cmd[1] === 'pr' && cmd[2] === 'view') workspace.status = 'stopping';
      return answer(cmd[1] === 'pr' ? view('OPEN') : `${HEAD} 0 0\n`);
    });
    expect(await getChecks(workspace)).toMatchObject({ github: 'error', error: 'salzburg is stopping' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('still takes a newer read over an older one that finished first', async () => {
    exec.mockImplementation(async (_sandbox: string, cmd: string[]) => {
      if (cmd[1] === 'pr' && cmd[2] === 'view') return answer(view(published.length === 0 ? 'OPEN' : 'MERGED'));
      if (cmd[1] === 'api') return answer('{"data":{"repository":null}}');
      return answer(`${HEAD} 0 0\n`);
    });
    await getChecks(workspace);
    expect(workspace.pr?.state).toBe('OPEN');
    await getChecks(workspace);
    expect(workspace.pr?.state).toBe('MERGED');
    expect(published).toEqual(['OPEN', 'MERGED']);
  });
});
