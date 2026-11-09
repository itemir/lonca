import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, Session, Workspace } from '../../shared/types.ts';
import { createWorkspace, sandboxNameFor } from '../../server/workspaces.ts';
import { projectLifecycle } from '../../server/projects.ts';

const { state, ports } = vi.hoisted(() => ({
  ports: { pending: null as null | (() => void)[] },
  state: {
    settings: { branchPrefix: 'test' },
    projects: [] as Project[],
    workspaces: [] as Workspace[],
  },
}));

vi.mock('../../server/store.ts', () => ({
  state,
  getProject: (id: string) => state.projects.find((project) => project.id === id),
  getWorkspace: (id: string) => state.workspaces.find((workspace) => workspace.id === id),
  getSecrets: () => ({}),
  flushState: vi.fn(),
  saveState: vi.fn(),
  deleteTranscript: vi.fn(),
}));

vi.mock('../../server/system.ts', () => ({
  checkSandboxes: async () => {},
  system: { sandbox: { state: 'ready' } },
  // Keep provisioning waiting on its template; this test exercises allocation, without sandboxes.
  ensureSandboxImage: () => new Promise<string>(() => {}),
  ensureCustomTemplate: vi.fn(),
}));

vi.mock('node:net', () => ({
  default: {
    // Every port is free, and each probe yields just as real socket operations do.
    createServer: () => ({
      once() {},
      listen(_port: number, _host: string, ready: () => void) {
        if (ports.pending) ports.pending.push(ready);
        else queueMicrotask(ready);
      },
      close(done: () => void) { queueMicrotask(done); },
    }),
  },
}));

afterEach(() => {
  ports.pending = null;
  vi.restoreAllMocks();
});

describe('workspace allocation', () => {
  it('reserves names within a project and port blocks across simultaneous requests', async () => {
    const first = { id: 'first', name: 'First', slug: 'first', status: 'ready', settings: { defaultBranch: 'main', image: '' } } as Project;
    const second = { ...first, id: 'second', name: 'Second', slug: 'second' };
    state.projects = [first, second];
    state.workspaces = [];
    // Both requests would select the same city if it wasn't reserved before the next allocation.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const makeSession = (workspace: Workspace) => ({ id: `session-${workspace.id}`, workspaceId: workspace.id }) as Session;
    const made = await Promise.all([
      createWorkspace(first, {}, makeSession),
      createWorkspace(first, {}, makeSession),
      createWorkspace(second, {}, makeSession),
    ]);
    const workspaces = made.map(({ workspace }) => workspace);
    expect(workspaces[0].name).not.toBe(workspaces[1].name);
    expect(workspaces[0].branch).not.toBe(workspaces[1].branch);
    expect(new Set(workspaces.map((workspace) => workspace.path)).size).toBe(3);
    expect(new Set(workspaces.map((workspace) => workspace.sandboxName)).size).toBe(3);
    expect(new Set(workspaces.map((workspace) => workspace.port)).size).toBe(3);
    expect(state.workspaces).toHaveLength(3);
  });

  it('finishes an in-flight allocation before project removal snapshots its workspaces', async () => {
    const project = { id: 'allocating', name: 'Allocating', slug: 'allocating', status: 'ready', settings: { defaultBranch: 'main', image: '' } } as Project;
    state.projects = [project];
    state.workspaces = [];
    ports.pending = [];
    const creating = createWorkspace(project, {}, (workspace) => ({ id: 'session', workspaceId: workspace.id }) as Session);
    await vi.waitFor(() => expect(ports.pending).toHaveLength(10));
    const snapshot = vi.fn(async () => [...state.workspaces]);
    const removing = projectLifecycle.run(project.id, snapshot);
    await Promise.resolve();
    expect(snapshot).not.toHaveBeenCalled();
    // A port is probed on several addresses in turn, and only the first probes were held.
    const held = ports.pending;
    ports.pending = null;
    for (const ready of held) ready();
    const { workspace } = await creating;
    expect(await removing).toEqual([workspace]);
  });

  it('rejects a queued allocation after its project has been removed', async () => {
    const project = { id: 'removed', name: 'Removed', status: 'ready' } as Project;
    state.projects = [project];
    state.workspaces = [];
    let finishRemoval!: () => void;
    const paused = new Promise<void>((resolve) => { finishRemoval = resolve; });
    const removing = projectLifecycle.run(project.id, async () => {
      await paused;
      state.projects = [];
    });
    const makeSession = vi.fn();
    const creating = createWorkspace(project, {}, makeSession);
    const rejected = expect(creating).rejects.toThrow('This project no longer exists');
    finishRemoval();
    await removing;
    await rejected;
    expect(state.workspaces).toEqual([]);
    expect(makeSession).not.toHaveBeenCalled();
  });
});

describe('naming a workspace’s container or sandbox', () => {
  it('keeps the plain name when it fits', () => {
    expect(sandboxNameFor('lonca', 'saillogger', 'milan', 'abcdefabcdef')).toBe('lonca-saillogger-milan');
  });

  it('stays within the 63 characters Docker Sandboxes allows, and apart from similar projects', () => {
    const long = 'a-repository-whose-name-goes-on-and-on-for-quite-a-while';
    const first = sandboxNameFor('lonca', long, 'wellington', 'abcdefabcdef');
    const second = sandboxNameFor('lonca', `${long}-too`, 'wellington', 'abcdefabcdef');
    for (const name of [first, second]) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^lonca-a-repository-.*-wellington$/);
      expect(name).not.toMatch(/--/);
    }
    expect(first).not.toBe(second);
    expect(sandboxNameFor('lonca-operation-recovery-sandbox', 'lonca-fixture-neir3f', 'wellington', 'abcdefabcdef').length).toBeLessThanOrEqual(63);
  });

  it('falls back to the workspace’s ID, and refuses a prefix too long for even that', () => {
    const prefix = `lonca-${'x'.repeat(40)}`;
    expect(sandboxNameFor(prefix, 'project', 'cape-town-12', 'abcdefabcdef')).toBe(`${prefix}-abcdefabcdef`);
    expect(() => sandboxNameFor(`lonca-${'x'.repeat(60)}`, 'project', 'milan', 'abcdefabcdef')).toThrow(/LONCA_INSTANCE/);
  });
});
