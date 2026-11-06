import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Workspace } from '../../shared/types.ts';

const { state, isSandboxRunning, execText, execTty, setUpCodex } = vi.hoisted(() => ({
  state: { workspaces: [] as Workspace[] },
  isSandboxRunning: vi.fn(), execText: vi.fn(), execTty: vi.fn(), setUpCodex: vi.fn(),
}));
vi.mock('../../server/sandbox.ts', () => ({ isSandboxRunning, stopSandbox: vi.fn(), execText, execTty }));
vi.mock('../../server/env.ts', () => ({ execEnv: () => [] }));
vi.mock('../../server/events.ts', () => ({ publish: vi.fn() }));
vi.mock('../../server/store.ts', () => ({ state, flushState: vi.fn(), getProject: vi.fn() }));
vi.mock('../../server/system.ts', () => ({ system: { sandbox: { state: 'ready' } } }));
vi.mock('../../server/workspaces.ts', () => ({
  publishWorkspace: vi.fn(), runningSandbox: async () => 'test', setUpCodex,
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
  workspace = { id: 'abcdefghijkl', sandboxName: 'test', status: 'ready', steps: [{ id: 'setup', status: 'pending' }] } as Workspace;
  isSandboxRunning.mockResolvedValue(true);
  execText.mockResolvedValue('');
  stream = new PassThrough();
  execTty.mockResolvedValue({ stream, resize: async () => {}, exitCode: async () => 137 });
});
afterEach(() => {
  stream.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function socket(): WebSocket {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  }) as unknown as WebSocket;
}

it('opens a terminal even when Codex can’t be set up', async () => {
  const terminals = await import('../../server/terminals.ts');
  state.workspaces.push(workspace);
  setUpCodex.mockRejectedValue(new Error('mktemp: Permission denied'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const terminal = await terminals.createShell(workspace);
  expect(terminal.status).toBe('running');
  expect(error).toHaveBeenCalledWith(expect.stringContaining('could not set Codex up'), 'mktemp: Permission denied');
  terminals.closeTerminalWindow(terminal.id);
});

it('keeps a dismissed window from reclaiming its terminal after a disconnect', async () => {
  const terminals = await import('../../server/terminals.ts');
  const terminal = await terminals.createShell(workspace);
  const first = socket();
  terminals.attachTerminal(terminal.id, first, 'first-window');
  first.emit('close');
  terminals.closeTerminalWindow(terminal.id);

  const reconnect = socket();
  terminals.attachTerminal(terminal.id, reconnect, 'first-window');
  expect(reconnect.send).toHaveBeenCalledWith(JSON.stringify({ type: 'window-closed' }));
  expect(reconnect.close).toHaveBeenCalled();
  expect(terminal.windowed).toBeUndefined();
  expect(reconnect.listenerCount('message')).toBe(0);

  // An explicit new window can still take ownership.
  const next = socket();
  terminals.attachTerminal(terminal.id, next, 'next-window');
  expect(terminal.windowed).toBe(true);
  expect(next.close).not.toHaveBeenCalled();
  terminals.closeTerminalWindow(terminal.id);
});

it('keeps an older disconnected window from replacing a newer one', async () => {
  const terminals = await import('../../server/terminals.ts');
  const terminal = await terminals.createShell(workspace);
  const first = socket();
  terminals.attachTerminal(terminal.id, first, 'first-window');
  first.emit('close');
  const next = socket();
  terminals.attachTerminal(terminal.id, next, 'next-window');

  const reconnect = socket();
  terminals.attachTerminal(terminal.id, reconnect, 'first-window');
  expect(reconnect.close).toHaveBeenCalled();
  expect(next.close).not.toHaveBeenCalled();
  expect(terminal.windowed).toBe(true);
  terminals.closeTerminalWindow(terminal.id);
});

it('lets an undismissed window reconnect after the reload grace period', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const terminals = await import('../../server/terminals.ts');
  const terminal = await terminals.createShell(workspace);
  const first = socket();
  terminals.attachTerminal(terminal.id, first, 'first-window');
  first.emit('close');
  vi.advanceTimersByTime(2000);
  expect(terminal.windowed).toBeUndefined();

  const reconnect = socket();
  terminals.attachTerminal(terminal.id, reconnect, 'first-window');
  expect(reconnect.close).not.toHaveBeenCalled();
  expect(terminal.windowed).toBe(true);
  terminals.closeTerminalWindow(terminal.id);
});

it.each(['leader', 'jobs'])('recovers a legacy Run script with %s alive and can close it', async (record) => {
  state.workspaces.push(workspace);
  const terminals = await import('../../server/terminals.ts');
  const { TTY_DIR } = await import('../../server/config.ts');
  const id = `${workspace.id}-run`;
  execText.mockResolvedValue(`${TTY_DIR}/${id}.pid\t${record}\n`);
  await terminals.reconcileTerminals();
  expect(terminals.listTerminals()).toEqual([expect.objectContaining({
    id, kind: 'shell', title: 'Recovered run script', status: 'running', disconnected: true,
    ...(record === 'jobs' ? { jobsOnly: true } : {}),
  })]);
  expect(workspace.steps[0].status).toBe('pending');

  execText.mockClear();
  await terminals.closeTerminal(id);
  expect(execText).toHaveBeenCalledWith('test', expect.arrayContaining(['stop', `${TTY_DIR}/${id}.pid`]), expect.anything());
  expect(terminals.listTerminals()).toEqual([]);
});

it('does not adopt another workspace’s legacy Run record', async () => {
  state.workspaces.push(workspace);
  const terminals = await import('../../server/terminals.ts');
  const { TTY_DIR } = await import('../../server/config.ts');
  execText.mockResolvedValue(`${TTY_DIR}/mnopqrstuvwx-run.pid\tleader\n`);
  await terminals.reconcileTerminals();
  expect(terminals.listTerminals()).toEqual([]);
});

it('does not inspect a new workspace whose live terminals are already tracked', async () => {
  const terminals = await import('../../server/terminals.ts');
  state.workspaces.push(workspace);
  await terminals.createShell(workspace);
  execText.mockClear();
  isSandboxRunning.mockClear();
  await terminals.reconcileTerminals();
  expect(execText).not.toHaveBeenCalled();
  expect(isSandboxRunning).not.toHaveBeenCalled();
});

it('recovers preexisting terminals and retires them without exec when their runtime stops', async () => {
  state.workspaces.push(workspace);
  const terminals = await import('../../server/terminals.ts');
  const { TTY_DIR } = await import('../../server/config.ts');
  execText.mockResolvedValue(`${TTY_DIR}/abcdefghijkl-setup.pid\tleader\n`);
  await terminals.reconcileTerminals();
  expect(terminals.listTerminals()).toEqual([expect.objectContaining({ id: 'abcdefghijkl-setup', status: 'running', disconnected: true })]);
  execText.mockClear();
  isSandboxRunning.mockResolvedValue(false);
  await terminals.reconcileTerminals();
  expect(terminals.listTerminals()[0].status).toBe('exited');
  expect(execText).not.toHaveBeenCalled();
});

it.each([false, true])('defers an interrupted terminal check and retains its result with runtime running=%s', async (running) => {
  const terminals = await import('../../server/terminals.ts');
  state.workspaces.push(workspace);
  const terminal = await terminals.runSetupScript(workspace, 'sleep 600');
  execText.mockClear();
  // Shutdown closes the exec stream before the runtime stops reporting running.
  stream.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(terminal).toMatchObject({ status: 'running', disconnected: true });
  await terminals.reconcileTerminals();
  expect(execText).not.toHaveBeenCalled();

  now += 6000;
  isSandboxRunning.mockResolvedValue(running);
  const { TTY_DIR } = await import('../../server/config.ts');
  execText.mockResolvedValue(`${TTY_DIR}/${terminal.id}.pid\tdead\n`);
  await terminals.reconcileTerminals();
  expect(terminal).toMatchObject({ status: 'exited', exitCode: 137 });
  expect(workspace.steps[0]).toMatchObject({ status: 'error', detail: 'The setup script exited with code 137.' });
  expect(execText).toHaveBeenCalledTimes(running ? 1 : 0);
});
