import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/types.ts';

const { state, isContainerRunning, execText, execTty } = vi.hoisted(() => ({
  state: { workspaces: [] as Workspace[] },
  isContainerRunning: vi.fn(), execText: vi.fn(), execTty: vi.fn(),
}));
vi.mock('../../server/containers.ts', () => ({ isContainerRunning, stopContainer: vi.fn() }));
vi.mock('../../server/docker.ts', () => ({ execText, execTty }));
vi.mock('../../server/env.ts', () => ({ execEnv: () => [] }));
vi.mock('../../server/events.ts', () => ({ publish: vi.fn() }));
vi.mock('../../server/store.ts', () => ({ state, flushState: vi.fn(), getProject: vi.fn() }));
vi.mock('../../server/system.ts', () => ({ system: { sandbox: { state: 'ready' } } }));
vi.mock('../../server/workspaces.ts', () => ({
  publishWorkspace: vi.fn(), runningContainer: async () => 'sandbox:test', runtimeHandle: () => 'sandbox:test',
}));

let workspace: Workspace;
let stream: PassThrough;
let now: number;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  state.workspaces = [];
  workspace = { id: 'abcdefghijkl', runtime: 'sandbox', status: 'ready', steps: [{ id: 'setup', status: 'pending' }] } as Workspace;
  isContainerRunning.mockResolvedValue(true);
  execText.mockResolvedValue('');
  stream = new PassThrough();
  execTty.mockResolvedValue({ stream, resize: async () => {}, exitCode: async () => 137 });
});
afterEach(() => {
  stream.destroy();
  vi.restoreAllMocks();
});

it('does not inspect a new workspace whose live terminals are already tracked', async () => {
  const terminals = await import('../../server/terminals.ts');
  state.workspaces.push(workspace);
  await terminals.createShell(workspace);
  execText.mockClear();
  isContainerRunning.mockClear();
  await terminals.reconcileTerminals();
  expect(execText).not.toHaveBeenCalled();
  expect(isContainerRunning).not.toHaveBeenCalled();
});

it('recovers preexisting terminals and retires them without exec when their runtime stops', async () => {
  state.workspaces.push(workspace);
  const terminals = await import('../../server/terminals.ts');
  const { TTY_DIR } = await import('../../server/config.ts');
  execText.mockResolvedValue(`${TTY_DIR}/abcdefghijkl-run.pid\tleader\n`);
  await terminals.reconcileTerminals();
  expect(terminals.listTerminals()).toEqual([expect.objectContaining({ id: 'abcdefghijkl-run', status: 'running', disconnected: true })]);
  execText.mockClear();
  isContainerRunning.mockResolvedValue(false);
  await terminals.reconcileTerminals();
  expect(terminals.listTerminals()[0].status).toBe('exited');
  expect(execText).not.toHaveBeenCalled();
});

it.each([false, true])('defers an interrupted terminal check and retains its result with runtime running=%s', async (running) => {
  const terminals = await import('../../server/terminals.ts');
  state.workspaces.push(workspace);
  const terminal = await terminals.runScript(workspace, 'setup', 'sleep 600');
  execText.mockClear();
  // Shutdown closes the exec stream before the runtime stops reporting running.
  stream.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(terminal).toMatchObject({ status: 'running', disconnected: true });
  await terminals.reconcileTerminals();
  expect(execText).not.toHaveBeenCalled();

  now += 6000;
  isContainerRunning.mockResolvedValue(running);
  const { TTY_DIR } = await import('../../server/config.ts');
  execText.mockResolvedValue(`${TTY_DIR}/${terminal.id}.pid\tdead\n`);
  await terminals.reconcileTerminals();
  expect(terminal).toMatchObject({ status: 'exited', exitCode: 137 });
  expect(workspace.steps[0]).toMatchObject({ status: 'error', detail: 'The setup script exited with code 137.' });
  expect(execText).toHaveBeenCalledTimes(running ? 1 : 0);
});
