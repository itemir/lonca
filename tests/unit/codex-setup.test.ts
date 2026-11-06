import { beforeEach, expect, it, vi } from 'vitest';
import type { Profile, Project, Workspace } from '../../shared/types.ts';
import { applyCodexSetup, setUpCodex } from '../../server/workspaces.ts';

const { state, execs } = vi.hoisted(() => ({
  state: {
    settings: { branchPrefix: 'test' }, projects: [] as Project[], workspaces: [] as Workspace[],
    profiles: [{ id: 'claude', agent: 'claude', name: '', createdAt: 0 }, { id: 'codex', agent: 'codex', name: '', createdAt: 0 }] as Profile[],
  },
  execs: [] as { stdin: string; done: () => void }[],
}));

vi.mock('../../server/store.ts', () => ({
  state,
  getProject: () => undefined,
  getWorkspace: (id: string) => state.workspaces.find((workspace) => workspace.id === id),
  getSecrets: () => ({}),
  boundaryValue: () => undefined,
  claudeCredential: () => undefined,
  flushState: vi.fn(),
  saveState: vi.fn(),
  deleteTranscript: vi.fn(),
}));

vi.mock('../../server/system.ts', () => ({
  checkSandboxes: async () => {},
  system: { sandbox: { state: 'ready' } },
  ensureSandboxImage: vi.fn(),
  ensureCustomTemplate: vi.fn(),
}));

vi.mock('../../server/sandbox.ts', async (original) => ({
  ...(await original<object>()),
  isSandboxRunning: async () => true,
  execText: (_name: string, _command: string[], options: { stdin: string }) => new Promise<void>((resolve) => {
    execs.push({ stdin: options.stdin, done: resolve });
  }),
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const keyOf = (stdin: string) => JSON.parse(stdin).OPENAI_API_KEY;
const PLACEHOLDER = 'oai-oat01-lonca-placeholder';
let project: Project;
let workspace: Workspace;

beforeEach(() => {
  execs.length = 0;
  project = { id: 'project', settings: { env: { OPENAI_API_KEY: 'sk-first' } } } as unknown as Project;
  workspace = { id: 'workspace', name: 'prague', projectId: 'project', status: 'ready', sandboxName: 'vm' } as Workspace;
  state.workspaces = [workspace];
});

it('updates a VM one at a time, each with the settings as they are by then', async () => {
  const first = applyCodexSetup(project);
  await tick();
  project.settings = { env: { OPENAI_API_KEY: 'sk-second' } } as unknown as Project['settings'];
  const second = applyCodexSetup(project);
  project.settings = { env: {} } as unknown as Project['settings'];
  const third = applyCodexSetup(project);
  await tick();
  // The one already on its way can't be called back, so nothing starts until it's landed.
  expect(execs.map(({ stdin }) => keyOf(stdin))).toEqual(['sk-first']);
  execs[0].done();
  await tick();
  expect(execs.map(({ stdin }) => keyOf(stdin))).toEqual(['sk-first', PLACEHOLDER]);
  execs[1].done();
  await tick();
  expect(execs.map(({ stdin }) => keyOf(stdin))).toEqual(['sk-first', PLACEHOLDER, PLACEHOLDER]);
  execs[2].done();
  await Promise.all([first, second, third]);
});

it('has a turn wait for an update on its way, and take the latest', async () => {
  const update = applyCodexSetup(project);
  await tick();
  project.settings = { env: {} } as unknown as Project['settings'];
  const turn = setUpCodex(workspace, project);
  await tick();
  expect(execs.length).toBe(1);
  execs[0].done();
  await tick();
  expect(keyOf(execs[1].stdin)).toBe(PLACEHOLDER);
  execs[1].done();
  await Promise.all([update, turn]);
});
