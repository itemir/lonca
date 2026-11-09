import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortForward, Project, Session, Workspace } from '../../shared/types.ts';
import type { ToolCall } from '../../server/agents/process.ts';

// The real workspace lifecycle, store and Lead tools, with only the sandbox replaced: what sbx was
// asked to do is recorded, and the VM's /proc/net tables are whatever a test says.

const vm = vi.hoisted(() => ({
  running: true,
  exists: true,
  tables: '',
  publishPort: vi.fn(async (_name: string, _hostPort: number, _port: number) => {}),
  unpublishPort: vi.fn(async (_name: string, _hostPort: number, _port: number) => {}),
  stopSandbox: vi.fn(async (_name: string) => {}),
  sandboxState: vi.fn(),
  ensureSandbox: vi.fn(),
  execText: vi.fn(),
}));

vi.mock('../../server/sandbox.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/sandbox.ts')>();
  const { RuntimeStoppedError } = await import('../../server/util.ts');
  vm.ensureSandbox.mockImplementation(async (spec: { name: string }, options: { start?: boolean } = {}) => {
    if (options.start === false && !vm.running) throw new RuntimeStoppedError('The sandbox is stopped');
    vm.running = true;
    vm.exists = true;
    return spec.name;
  });
  vm.execText.mockImplementation(async () => vm.tables);
  vm.sandboxState.mockImplementation(async () => (!vm.exists ? 'missing' : vm.running ? 'running' : 'stopped'));
  return {
    ...original,
    ensureSandbox: vm.ensureSandbox,
    execText: vm.execText,
    sandboxState: vm.sandboxState,
    isSandboxRunning: async () => vm.running,
    stopSandbox: async (name: string) => {
      await vm.stopSandbox(name);
      vm.running = false;
    },
    removeSandbox: async () => {
      vm.running = false;
      vm.exists = false;
    },
    publishPort: vm.publishPort,
    unpublishPort: vm.unpublishPort,
  };
});

vi.mock('../../server/system.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/system.ts')>(),
  checkSandboxes: async () => {},
  // A new workspace waits here for its template, which is as far as these tests need it to get.
  ensureSandboxImage: () => new Promise<string>(() => {}),
}));

let home: string;
let store: typeof import('../../server/store.ts');
let ports: typeof import('../../server/ports.ts');
let workspaces: typeof import('../../server/workspaces.ts');
let runner: typeof import('../../server/agents/runner.ts');
let team: typeof import('../../server/agents/team.ts');
let HTTP_PORT: number;
let failTeardown = false;
let own: Workspace;
let other: Workspace;
const servers: net.Server[] = [];

const project = {
  id: 'project', name: 'Project', slug: 'project', remoteUrl: null, localPath: null, githubOwner: null, status: 'ready', createdAt: 0,
  settings: { defaultBranch: 'main', setupScript: '', filesToCopy: [], image: '', network: 'internet', memoryGb: 0, cpus: 0, env: {} },
} satisfies Project;

// Below the range either Linux or macOS gives out when asked for any free port.
const OWN_PORT = 20000;
const OTHER_PORT = 20010;

function makeWorkspace(id: string, port: number): Workspace {
  return {
    id, projectId: project.id, name: id, title: null, branch: `test/${id}`, baseBranch: 'main', path: path.join(home, id),
    sandboxName: `vm-${id}`, port, status: 'ready', steps: [], filesCopied: 0, diff: null, createdAt: 0, updatedAt: 0,
  };
}

function listen(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** A port held by a program listening on another address, as a dev server or Docker might. */
function listenOn(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      servers.push(server);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** A port nothing on this computer is listening on, on any address, as far as anyone can know. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await listen();
    await new Promise((resolve) => servers.pop()!.close(resolve));
    // The system only knows it's free on 127.0.0.1, and Lonca asks of every address.
    if (await workspaces.isPortFree(port)) return port;
  }
}

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const ANY4 = '00000000';
const LOOPBACK4 = '0100007F';
const ANY6 = '0'.repeat(32);
const LOOPBACK6 = '00000000000000000000000001000000';

/** A row as the kernel writes it, listening (0A) unless told otherwise. */
function row(address: string, port: number, status = '0A'): string {
  return `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} ${address.replace(/./g, '0')}:0000 ${status} 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0`;
}

function tables(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-ports-')));
  vi.stubEnv('LONCA_HOME', home);
  vi.stubEnv('PORT', '4801');
  store = await import('../../server/store.ts');
  workspaces = await import('../../server/workspaces.ts');
  // As the runner's does when an agent won't stop. It comes before the ports' own, as it does in the server.
  workspaces.onWorkspaceTeardown(async () => {
    if (failTeardown) throw new Error('An agent is still stopping. Retry once its process can be reached.');
  });
  ports = await import('../../server/ports.ts');
  runner = await import('../../server/agents/runner.ts');
  team = await import('../../server/agents/team.ts');
  ({ HTTP_PORT } = await import('../../server/config.ts'));
  (await import('../../server/system.ts')).system.sandbox = { state: 'ready' };
});

beforeEach(() => {
  vi.clearAllMocks();
  failTeardown = false;
  vm.running = true;
  vm.exists = true;
  vm.tables = tables();
  own = makeWorkspace('own', OWN_PORT);
  other = makeWorkspace('other', OTHER_PORT);
  store.state.projects = [project];
  store.state.workspaces = [own, other];
  store.state.sessions = [];
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  vi.restoreAllMocks();
});

afterAll(() => {
  store.flushTranscripts();
  store.flushState();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('choosing the port on the user’s computer', () => {
  it('uses the same number when it’s free, and records the forward before publishing it', async () => {
    const port = await freePort();
    vm.publishPort.mockImplementationOnce(async () => {
      // What would be needed to close it is already saved.
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).workspaces.find((entry: Workspace) => entry.id === own.id);
      expect(saved.forwards).toEqual([{ hostPort: port, port, since: expect.any(Number) }]);
    });
    const reply = await ports.forwardPort(own, port);
    expect(vm.publishPort).toHaveBeenCalledWith('vm-own', port, port);
    expect(own.forwards).toEqual([{ hostPort: port, port, since: expect.any(Number) }]);
    expect(reply).toContain(`Forwarded port ${port} to http://localhost:${port} on the user's computer.`);
    expect(reply).not.toContain('chose another port');
  });

  it('uses the port asked for', async () => {
    const hostPort = await freePort();
    const reply = await ports.forwardPort(own, 3000, hostPort);
    expect(vm.publishPort).toHaveBeenCalledWith('vm-own', hostPort, 3000);
    expect(reply).toContain(`http://localhost:${hostPort}`);
  });

  it.each([
    ['taken by something else', async () => listen()],
    // On macOS, sbx publishing on 127.0.0.1 would take these programs' connections.
    ['taken by something listening on 0.0.0.0', async () => listenOn('0.0.0.0')],
    ['taken by something listening on ::', async () => listenOn('::')],
    // Which would answer for localhost in place of the VM.
    ['taken by something listening on ::1', async () => listenOn('::1')],
    ['below 1024', async () => 80],
    ['Lonca’s own', async () => HTTP_PORT],
    // A browser may keep Lonca's token for these origins.
    ['Lonca’s default', async () => 4700],
    ['Lonca’s in development', async () => 5173],
    ['Codex’s sign-in port', async () => 1455],
    ['one of another workspace’s ten', async () => OTHER_PORT + 3],
    ['forwarded to another workspace', async () => {
      other.forwards = [{ hostPort: 3456, port: 80, since: 1 }];
      return 3456;
    }],
  ])('chooses a free port itself when the same number is %s, and tells sbx which', async (_why, take) => {
    const port = await take();
    const reply = await ports.forwardPort(own, port);
    const [, hostPort, published] = vm.publishPort.mock.calls[0];
    expect(published).toBe(port);
    expect(hostPort).not.toBe(port);
    expect(hostPort).toBeGreaterThanOrEqual(1024);
    expect(hostPort).not.toBe(HTTP_PORT);
    expect(hostPort).not.toBe(1455);
    expect(own.forwards).toEqual([{ hostPort, port, since: expect.any(Number) }]);
    expect(reply).toContain(`Forwarded port ${port} to http://localhost:${hostPort}`);
    expect(reply).toContain(`localhost:${port} wasn't available on the user's computer, so Lonca chose another port.`);
  });

  it.each([
    ['1023', async () => 1023, 'has to be from 1024 to 65535'],
    ['65536', async () => 65536, 'has to be from 1024 to 65535'],
    ['Lonca’s own', async () => HTTP_PORT, 'is kept for Lonca\'s own pages'],
    ['Lonca’s default', async () => 4700, 'is kept for Lonca\'s own pages'],
    ['Lonca’s in development', async () => 5173, 'is kept for Lonca\'s own pages'],
    ['Codex’s sign-in port', async () => 1455, 'is kept for signing in to Codex'],
    ['one of this workspace’s ten', async () => OWN_PORT + 3, 'is one of the ports published for this workspace'],
    ['one of another workspace’s ten', async () => OTHER_PORT + 9, 'is one of the ports published for another workspace'],
    ['forwarded here already', async () => {
      own.forwards = [{ hostPort: 3456, port: 4000, since: 1 }];
      return 3456;
    }, 'is already forwarded to port 4000 here'],
    ['forwarded to another workspace', async () => {
      other.forwards = [{ hostPort: 3456, port: 4000, since: 1 }];
      return 3456;
    }, 'is already forwarded to another workspace'],
    ['in use on this computer', async () => listen(), 'Something on the user\'s computer is already using'],
    ['in use on every interface of this computer', async () => listenOn('0.0.0.0'), 'Something on the user\'s computer is already using'],
  ])('refuses a host_port that’s %s, and says why, without asking sbx', async (_why, take, reason) => {
    const hostPort = await take();
    const before = structuredClone(own.forwards);
    await expect(ports.forwardPort(own, 3000, hostPort)).rejects.toThrow(reason);
    await expect(ports.forwardPort(own, 3000, hostPort)).rejects.toThrow('Choose another host_port, or leave it out for Lonca to choose one.');
    expect(vm.publishPort).not.toHaveBeenCalled();
    expect(own.forwards).toEqual(before);
  });

  it('chooses while no other workspace or forward is choosing, so two can’t take the same port', async () => {
    const hostPort = await freePort();
    let release!: () => void;
    // As a new workspace taking its ten ports would.
    const held = workspaces.reserveHostPorts(() => new Promise<void>((resolve) => { release = resolve; }));
    const forwarding = ports.forwardPort(own, 3000, hostPort);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(own.forwards).toBeUndefined();
      expect(vm.publishPort).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await held;
    await forwarding;
    expect(vm.publishPort).toHaveBeenCalledWith('vm-own', hostPort, 3000);
    // Once it's recorded, nobody else is given it.
    await expect(ports.forwardPort(other, 3000, hostPort)).rejects.toThrow('is already forwarded to another workspace');
    await ports.forwardPort(other, hostPort);
    expect(vm.publishPort.mock.calls[1][1]).not.toBe(hostPort);
  });
});

describe('forward_port’s replies', () => {
  it('says one of the workspace’s own ports is published already, without asking sbx', async () => {
    vm.tables = tables(row(ANY4, OWN_PORT + 2));
    const reply = await ports.forwardPort(own, OWN_PORT + 2);
    expect(reply).toContain(`Port ${OWN_PORT + 2} is one of this workspace's ten published ports, so the user can already open it at http://localhost:${OWN_PORT + 2}.`);
    expect(reply).toContain('on all interfaces');
    expect(vm.publishPort).not.toHaveBeenCalled();
    expect(own.forwards).toBeUndefined();
  });

  it('gives back a forward that exists, and won’t move it to another port until it’s closed', async () => {
    const hostPort = await freePort();
    await ports.forwardPort(own, 3000, hostPort);
    expect(await ports.forwardPort(own, 3000)).toContain(`Port 3000 is already forwarded to http://localhost:${hostPort} on the user's computer.`);
    expect(await ports.forwardPort(own, 3000, hostPort)).toContain('already forwarded');
    await expect(ports.forwardPort(own, 3000, hostPort + 1)).rejects.toThrow(`Port 3000 is already forwarded to http://localhost:${hostPort}. Close it with close_port first to forward it to localhost:${hostPort + 1} instead.`);
    expect(vm.publishPort).toHaveBeenCalledTimes(1);
    expect(own.forwards).toHaveLength(1);
  });

  it.each([
    ['on 0.0.0.0', [row(ANY4, 3000)], 'A server is listening on it on all interfaces (0.0.0.0), so the user can reach it.'],
    ['on ::, which takes IPv4 too', [row(ANY6, 3000)], 'on all interfaces (::)'],
    ['on loopback and on every interface', [row(LOOPBACK4, 3000), row(ANY6, 3000)], 'on all interfaces (127.0.0.1, ::)'],
  ])('says a server listening %s can be reached', async (_where, rows, expected) => {
    vm.tables = tables(...rows);
    const reply = await ports.forwardPort(own, 3000, await freePort());
    expect(reply).toContain(expected);
    expect(reply).not.toContain('Restart');
  });

  it.each([
    ['127.0.0.1', [row(LOOPBACK4, 3000)]],
    ['::1', [row(LOOPBACK6, 3000)]],
    ['::ffff:127.0.0.1', [row('0000000000000000FFFF00000100007F', 3000)]],
    ['127.0.0.1, ::1', [row(LOOPBACK4, 3000), row(LOOPBACK6, 3000)]],
  ])('tells the Lead to restart a server only on localhost (%s) on 0.0.0.0, and keeps the forward', async (where, rows) => {
    vm.tables = tables(...rows);
    const reply = await ports.forwardPort(own, 3000, await freePort());
    expect(reply).toContain(`A server is listening on it, but only on localhost (${where}), so the user can't reach it. Restart the server on 0.0.0.0.`);
    expect(reply).toContain('The forward stays in place meanwhile.');
    expect(own.forwards).toHaveLength(1);
  });

  it('tells the Lead to restart a server only on some other address on 0.0.0.0', async () => {
    // 172.17.0.2, as a VM's own interface might be.
    vm.tables = tables(row('020011AC', 3000));
    const reply = await ports.forwardPort(own, 3000, await freePort());
    expect(reply).toContain('A server is listening on it, but only on 172.17.0.2. Restart it on 0.0.0.0');
    expect(reply).toContain('The forward stays in place meanwhile.');
  });

  it('tells the Lead to start the server on 0.0.0.0 when nothing’s listening yet', async () => {
    // Connections on the port, and servers on others, don't count.
    vm.tables = tables(row(ANY4, 3001), row(LOOPBACK4, 3000, '01'), row(ANY6, 3002));
    const reply = await ports.forwardPort(own, 3000, await freePort());
    expect(reply).toContain('Nothing is listening on it yet: start the server on 0.0.0.0, not only localhost, for the user to reach it.');
  });

  it('still forwards when what’s listening can’t be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vm.execText.mockRejectedValueOnce(new Error('timed out'));
    const reply = await ports.forwardPort(own, 3000, await freePort());
    expect(reply).toContain('Lonca couldn\'t check what\'s listening on it.');
    expect(own.forwards).toHaveLength(1);
  });

  it('reads what’s listening from the kernel’s own tables, not with a tool the VM may lack', async () => {
    await ports.forwardPort(own, 3000, await freePort());
    expect(vm.execText).toHaveBeenCalledWith('vm-own', ['sh', '-c', expect.stringContaining('cat /proc/net/tcp /proc/net/tcp6')], expect.anything());
  });

  it('takes the record back when sbx can’t publish it', async () => {
    vm.publishPort.mockRejectedValueOnce(new Error('error: port is already allocated'));
    await expect(ports.forwardPort(own, 3000, await freePort())).rejects.toThrow('Docker Sandboxes couldn\'t forward');
    expect(own.forwards).toBeUndefined();
  });

  it.each([
    ['stopped', 'stopped', true],
    ['stopping', 'stopping', true],
    ['found stopped', 'ready', false],
  ])('refuses when the workspace is %s, without starting it', async (_case, status, running) => {
    own.status = status as Workspace['status'];
    vm.running = running;
    await expect(ports.forwardPort(own, 3000, 3001)).rejects.toThrow(`The workspace is ${status === 'ready' ? 'stopped' : status}, so nothing can be forwarded to it.`);
    expect(vm.publishPort).not.toHaveBeenCalled();
    expect(vm.ensureSandbox.mock.calls.every(([, options]) => options?.start === false)).toBe(true);
    expect(vm.running).toBe(running);
  });
});

describe('close_port', () => {
  it('unpublishes the same mapping it published, and forgets it', async () => {
    const hostPort = await freePort();
    await ports.forwardPort(own, 3000, hostPort);
    await ports.forwardPort(own, 4000, await freePort());
    expect(await ports.closePort(own, 3000)).toBe(`Stopped forwarding localhost:${hostPort} to port 3000.`);
    expect(vm.unpublishPort.mock.calls).toEqual([vm.publishPort.mock.calls[0]]);
    expect(own.forwards?.map((forward) => forward.port)).toEqual([4000]);
  });

  it('won’t close one of the ten, or a port that isn’t forwarded', async () => {
    await expect(ports.closePort(own, OWN_PORT)).rejects.toThrow('one of this workspace\'s ten published ports, which stay published while it runs');
    await ports.forwardPort(own, 4000, await freePort());
    await expect(ports.closePort(own, 3000)).rejects.toThrow('Port 3000 isn\'t forwarded. Forwarded ports: 4000.');
    expect(vm.unpublishPort).not.toHaveBeenCalled();
  });

  it('keeps the record when sbx can’t unpublish it, since it would still be there', async () => {
    await ports.forwardPort(own, 3000, await freePort());
    vm.unpublishPort.mockRejectedValueOnce(new Error('error: cannot connect to sandboxd'));
    await expect(ports.closePort(own, 3000)).rejects.toThrow('Docker Sandboxes couldn\'t stop forwarding');
    expect(own.forwards).toHaveLength(1);
  });

  it('refuses when the workspace isn’t running, without starting it', async () => {
    own.forwards = [{ hostPort: 3001, port: 3000, since: 1 }];
    own.status = 'stopped';
    vm.running = false;
    await expect(ports.closePort(own, 3000)).rejects.toThrow('The workspace is stopped, so its forwards are closed already.');
    expect(vm.unpublishPort).not.toHaveBeenCalled();
    expect(vm.running).toBe(false);
  });
});

describe('list_ports', () => {
  it('lists the ten ports and every forward, since when, with what’s listening on each', async () => {
    const hostPort = await freePort();
    await ports.forwardPort(own, 3000, hostPort);
    vm.tables = tables(row(ANY4, OWN_PORT), row(LOOPBACK4, 3000));
    const list = await ports.listPorts(own);
    expect(list).toContain(`Ports ${OWN_PORT}-${OWN_PORT + 9} are published at the same ports on the user's localhost while this workspace runs:`);
    expect(list).toContain(`- ${OWN_PORT} at http://localhost:${OWN_PORT}: A server is listening on it on all interfaces (0.0.0.0)`);
    expect(list).toContain(`- ${OWN_PORT + 9} at http://localhost:${OWN_PORT + 9}: Nothing is listening on it yet`);
    expect(list.match(/^- \d+ at /gm)).toHaveLength(10);
    const since = new Date(own.forwards![0].since).toISOString();
    expect(list).toContain(`- localhost:${hostPort} → 3000, since ${since}, at http://localhost:${hostPort}: A server is listening on it, but only on localhost (127.0.0.1)`);
  });

  it('says when nothing is forwarded', async () => {
    expect(await ports.listPorts(own)).toContain('Nothing else is forwarded.');
  });

  it('says the workspace is stopped and has no forwards, without starting it', async () => {
    own.forwards = [{ hostPort: 3001, port: 3000, since: 1 }];
    own.status = 'stopped';
    vm.running = false;
    expect(await ports.listPorts(own)).toBe(`The workspace is stopped, so there are no forwards. Ports ${OWN_PORT}-${OWN_PORT + 9} are published while it runs.`);
    expect(vm.execText).not.toHaveBeenCalled();
    expect(vm.running).toBe(false);
  });
});

describe('forwards when the workspace stops and starts', () => {
  const forwardTwo = async (): Promise<PortForward[]> => {
    await ports.forwardPort(own, 3000, await freePort());
    await ports.forwardPort(own, 4000, await freePort());
    return own.forwards!;
  };

  it('closes every forward before the sandbox stops', async () => {
    const forwards = await forwardTwo();
    await workspaces.stopWorkspace(own);
    expect(own.status).toBe('stopped');
    expect(own.forwards).toBeUndefined();
    expect(vm.unpublishPort.mock.calls).toEqual(forwards.map((forward) => ['vm-own', forward.hostPort, forward.port]));
    const lastUnpublish = Math.max(...vm.unpublishPort.mock.invocationCallOrder);
    expect(vm.stopSandbox.mock.invocationCallOrder[0]).toBeGreaterThan(lastUnpublish);
  });

  it('keeps a forward sbx couldn’t close, and stops anyway', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const [kept, closed] = await forwardTwo();
    vm.unpublishPort.mockRejectedValueOnce(new Error('error: cannot connect to sandboxd'));
    await workspaces.stopWorkspace(own);
    expect(own.status).toBe('stopped');
    expect(vm.stopSandbox).toHaveBeenCalledTimes(1);
    expect(own.forwards).toEqual([kept]);
    expect(vm.unpublishPort).toHaveBeenCalledWith('vm-own', closed.hostPort, closed.port);
  });

  it('closes forwards before anything else that could stop the stop, such as an agent that won’t stop', async () => {
    const forwards = await forwardTwo();
    failTeardown = true;
    await expect(workspaces.stopWorkspace(own)).rejects.toThrow('An agent is still stopping');
    expect(own.status).toBe('error');
    // Its VM is still running, but nothing of it is left on the user's computer.
    expect(vm.running).toBe(true);
    expect(own.forwards).toBeUndefined();
    expect(vm.unpublishPort.mock.calls).toEqual(forwards.map((forward) => ['vm-own', forward.hostPort, forward.port]));
  });

  it('closes forwards before asking sbx anything else, so a stop that fails on the way leaves none behind', async () => {
    const forwards = await forwardTwo();
    // An agent's turn makes the stop check whether the sandbox is running, which sbx can fail to answer.
    store.state.sessions = [{ id: 'turn', workspaceId: own.id, activeRunId: 'run' } as Session];
    const answer = vm.sandboxState.getMockImplementation()!;
    vm.sandboxState.mockImplementation(async () => {
      throw new Error('error: cannot connect to sandboxd');
    });
    try {
      await expect(workspaces.stopWorkspace(own)).rejects.toThrow('cannot connect to sandboxd');
    } finally {
      vm.sandboxState.mockImplementation(answer);
    }
    expect(own.status).toBe('error');
    expect(own.forwards).toBeUndefined();
    expect(vm.unpublishPort.mock.calls).toEqual(forwards.map((forward) => ['vm-own', forward.hostPort, forward.port]));
  });

  it('closes the forwards of a sandbox stopped outside Lonca, which doesn’t start it', async () => {
    const forwards = await forwardTwo();
    vm.running = false;
    await workspaces.stopWorkspace(own);
    expect(vm.unpublishPort.mock.calls).toEqual(forwards.map((forward) => ['vm-own', forward.hostPort, forward.port]));
    expect(own.forwards).toBeUndefined();
    expect(vm.running).toBe(false);
  });

  it('closes what’s left before it starts the sandbox, since sbx would publish it again or refuse to start', async () => {
    const forwards = await forwardTwo();
    // As if it stopped some other way, with no chance to close them.
    own.status = 'stopped';
    vm.running = false;
    await workspaces.startWorkspace(own);
    expect(own.status).toBe('ready');
    expect(own.forwards).toBeUndefined();
    expect(vm.unpublishPort.mock.calls).toEqual(forwards.map((forward) => ['vm-own', forward.hostPort, forward.port]));
    const started = vm.ensureSandbox.mock.invocationCallOrder.at(-1)!;
    expect(Math.max(...vm.unpublishPort.mock.invocationCallOrder)).toBeLessThan(started);
  });

  it('keeps one it couldn’t close before starting, since sbx publishes it again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const [kept] = await forwardTwo();
    own.status = 'stopped';
    vm.running = false;
    vm.unpublishPort.mockRejectedValueOnce(new Error('error: cannot connect to sandboxd'));
    await workspaces.startWorkspace(own);
    expect(own.status).toBe('ready');
    expect(own.forwards).toEqual([kept]);
  });

  it('forgets the forwards of a sandbox removed outside Lonca, without asking sbx', async () => {
    await forwardTwo();
    own.status = 'stopped';
    vm.running = false;
    vm.exists = false;
    await workspaces.startWorkspace(own);
    expect(own.status).toBe('ready');
    expect(own.forwards).toBeUndefined();
    expect(vm.unpublishPort).not.toHaveBeenCalled();
  });

  it.each(['rebuild', 'archive'] as const)('forgets a forward it couldn’t close once %s has removed the sandbox', async (operation) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(own.path, { recursive: true });
    await forwardTwo();
    vm.unpublishPort.mockRejectedValueOnce(new Error('error: cannot connect to sandboxd'));
    await (operation === 'rebuild' ? workspaces.rebuildWorkspace(own) : workspaces.archiveWorkspace(own));
    expect(own.status).toBe(operation === 'rebuild' ? 'ready' : 'archived');
    expect(own.forwards).toBeUndefined();
    // Once the sandbox has gone, there's nothing to ask sbx.
    expect(vm.unpublishPort).toHaveBeenCalledTimes(2);
  });

  it('forgets forwards once a rebuild has removed the sandbox, even when sbx can’t say it’s gone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(own.path, { recursive: true });
    await forwardTwo();
    const answer = vm.sandboxState.getMockImplementation()!;
    // Before it's removed, sbx can't be reached. After, it only says the sandbox isn't there.
    vm.sandboxState.mockImplementation(async () => {
      if (vm.exists) return answer();
      throw new Error('error: cannot connect to sandboxd');
    });
    vm.unpublishPort.mockImplementation(async () => {
      throw new Error(vm.exists ? 'error: cannot connect to sandboxd' : 'error: sandbox \'vm-own\' not found');
    });
    try {
      await workspaces.rebuildWorkspace(own);
    } finally {
      vm.sandboxState.mockImplementation(answer);
      vm.unpublishPort.mockImplementation(async () => {});
    }
    expect(own.status).toBe('ready');
    expect(own.forwards).toBeUndefined();
  });

  it('gives a new workspace no block of ports that a forward uses, even one that isn’t listening', async () => {
    const { FIRST_WORKSPACE_PORT } = await import('../../server/config.ts');
    own.port = FIRST_WORKSPACE_PORT;
    other.port = FIRST_WORKSPACE_PORT + 10;
    own.forwards = [{ hostPort: FIRST_WORKSPACE_PORT + 25, port: 3000, since: 1 }];
    const { workspace } = await workspaces.createWorkspace(project, {}, (created) => runner.createSession(created, {}));
    expect(workspace.port).toBeGreaterThanOrEqual(FIRST_WORKSPACE_PORT + 30);
  });
});

describe('the Lead’s port tools', () => {
  const call = (id: string, tool: string, args: Record<string, unknown>): ToolCall => ({ id: id.padEnd(32, '0'), tool, args });

  it('save forward_port and close_port replies, so a call repeated after a restart doesn’t act again', async () => {
    const lead = runner.createLead(own);
    const hostPort = await freePort();
    const forward = call('a', 'forward_port', { port: 3000, host_port: hostPort });
    const forwarded = await team.handleToolCall(lead, forward);
    expect(forwarded.failed).toBeUndefined();
    expect(forwarded.text).toContain(`http://localhost:${hostPort}`);
    expect(lead.toolReplies?.[forward.id]).toEqual(forwarded);
    const close = call('b', 'close_port', { port: 3000 });
    const closed = await team.handleToolCall(lead, close);
    expect(closed).toEqual({ text: `Stopped forwarding localhost:${hostPort} to port 3000.` });
    expect(await team.handleToolCall(lead, forward)).toEqual(forwarded);
    expect(await team.handleToolCall(lead, close)).toEqual(closed);
    expect(vm.publishPort).toHaveBeenCalledTimes(1);
    expect(vm.unpublishPort).toHaveBeenCalledTimes(1);
    expect(own.forwards).toBeUndefined();
  });

  it('take a port sent as text, and refuse what isn’t a port in words the Lead can act on', async () => {
    const lead = runner.createLead(own);
    const hostPort = await freePort();
    expect((await team.handleToolCall(lead, call('c', 'forward_port', { port: '3000', host_port: String(hostPort) }))).failed).toBeUndefined();
    expect(vm.publishPort).toHaveBeenCalledWith('vm-own', hostPort, 3000);
    for (const [args, words] of [
      [{}, 'port must be a port number, from 1 to 65535.'],
      [{ port: 'http' }, 'port must be a port number'],
      [{ port: 70000 }, 'port must be a port number'],
      [{ port: 3.5 }, 'port must be a port number'],
      [{ port: 3001, host_port: 0 }, 'host_port must be a port number'],
    ] as const) {
      expect(await team.handleToolCall(lead, call(`d${JSON.stringify(args)}`, 'forward_port', args))).toEqual({ text: words.endsWith('.') ? words : expect.stringContaining(words), failed: true });
    }
    expect((await team.handleToolCall(lead, call('e', 'close_port', { port: 'none' }))).failed).toBe(true);
    expect(vm.publishPort).toHaveBeenCalledTimes(1);
  });

  it('answer list_ports afresh each time', async () => {
    const lead = runner.createLead(own);
    const list = call('f', 'list_ports', {});
    expect((await team.handleToolCall(lead, list)).text).toContain('Nothing else is forwarded.');
    expect(lead.toolReplies?.[list.id]).toBeUndefined();
    await ports.forwardPort(own, 3000, await freePort());
    expect((await team.handleToolCall(lead, list)).text).toContain('→ 3000');
  });
});

describe('reading /proc/net/tcp and tcp6', () => {
  it('finds listening sockets by port and address, ignoring connections and the header', () => {
    const found = ports.parseListeners(tables(
      row(ANY4, 8080), row(LOOPBACK4, 5173), row(ANY6, 8080), row(LOOPBACK6, 5173),
      row(LOOPBACK4, 9000, '01'), 'garbage line', '',
    ));
    expect([...found.keys()].sort()).toEqual([5173, 8080]);
    expect(found.get(8080)).toEqual([{ address: '0.0.0.0', any: true, loopback: false }, { address: '::', any: true, loopback: false }]);
    expect(found.get(5173)).toEqual([{ address: '127.0.0.1', any: false, loopback: true }, { address: '::1', any: false, loopback: true }]);
  });

  it('writes other IPv6 addresses the usual short way', () => {
    // fe80::42:acff:fe11:2, each 32-bit word little-endian.
    const found = ports.parseListeners(tables(row('000080FE00000000FFAC4200020011FE', 443)));
    expect(found.get(443)).toEqual([{ address: 'fe80::42:acff:fe11:2', any: false, loopback: false }]);
  });
});
