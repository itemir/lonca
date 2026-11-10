import net, { type AddressInfo } from 'node:net';
import type { PortForward, Workspace } from '../shared/types.ts';
import { DEFAULT_HTTP_PORT, DEV_PORT, HTTP_PORT, PORTS_PER_WORKSPACE } from './config.ts';
import { execText, publishPort, sandboxState, unpublishPort } from './sandbox.ts';
import { flushState, state, uiPorts } from './store.ts';
import { HttpError, KeyedQueue, errorMessage } from './util.ts';
import { isPortFree, onSandboxChange, publishWorkspace, reserveHostPorts, runningSandbox } from './workspaces.ts';

// A Lead can forward a port on the user's localhost to any port in its workspace's VM, beyond the
// ten every workspace has. sbx publishes a sandbox's ports again whenever it starts, and won't
// start it if one of them has been taken by then, so forwards are closed before Lonca stops a
// sandbox, and whatever is left of them before Lonca starts it again.

// Codex's sign-in page sends the browser back to this port, where Lonca listens while signing in.
const CODEX_SIGN_IN_PORT = 1455;
const LOWEST_HOST_PORT = 1024;
const HIGHEST_PORT = 65535;
// Browsers won't open these whatever is there: the Fetch standard's bad ports from 1024 up.
const BROWSER_BLOCKED_PORTS = [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];
// Ports the system offers can be ones Lonca keeps for something else, so it may take a few.
const PICK_ATTEMPTS = 20;

// One change at a time to a workspace's ports, including those its lifecycle makes.
const changes = new KeyedQueue();

function forwardsOf(workspace: Workspace): PortForward[] {
  return workspace.forwards ?? [];
}

function setForwards(workspace: Workspace, forwards: PortForward[]): void {
  workspace.forwards = forwards.length > 0 ? forwards : undefined;
  publishWorkspace(workspace);
}

function url(hostPort: number): string {
  return `http://localhost:${hostPort}`;
}

function isOwnPort(workspace: Workspace, port: number): boolean {
  return port >= workspace.port && port < workspace.port + PORTS_PER_WORKSPACE;
}

/** The sandbox, if it's running. Finding out doesn't start it. */
async function runningVm(workspace: Workspace, refusal: string): Promise<string> {
  // A VM found stopped leaves the status alone if something else changed it meanwhile.
  const notRunning = () => new HttpError(409, `The workspace is ${workspace.status === 'ready' ? 'stopped' : workspace.status}, so ${refusal}.`);
  if (workspace.status !== 'ready') throw notRunning();
  try {
    return await runningSandbox(workspace);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) throw notRunning();
    throw error;
  }
}

// What's listening is read from the kernel, rather than with ss or netstat, which a custom
// template may not have. A missing table, as with IPv6 turned off, is no answer from it.
const LISTENERS_SCRIPT = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; true';
const LISTEN_STATE = '0A';

export interface Listener {
  address: string;
  /** Bound to every interface: 0.0.0.0, or :: which takes IPv4 as well. */
  any: boolean;
  loopback: boolean;
}

/** An address as /proc/net writes it: each 32-bit word in the machine's byte order, little-endian in these VMs. */
function readAddress(hex: string): Listener {
  const bytes = (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
  const ordered = bytes.flatMap((_, index) => (index % 4 === 0 ? bytes.slice(index, index + 4).reverse() : []));
  const any = ordered.every((byte) => byte === 0);
  if (ordered.length === 4) return { address: ordered.join('.'), any, loopback: ordered[0] === 127 };
  const mapped = ordered.slice(0, 10).every((byte) => byte === 0) && ordered[10] === 255 && ordered[11] === 255;
  if (mapped) return { address: `::ffff:${ordered.slice(12).join('.')}`, any: false, loopback: ordered[12] === 127 };
  const groups = Array.from({ length: 8 }, (_, index) => ((ordered[index * 2] << 8) | ordered[index * 2 + 1]).toString(16));
  // URLs write IPv6 addresses in their usual short form.
  const address = new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1);
  return { address, any, loopback: address === '::1' };
}

/** Who's listening on each TCP port, from the contents of /proc/net/tcp and /proc/net/tcp6. */
export function parseListeners(tables: string): Map<number, Listener[]> {
  const found = new Map<number, Listener[]>();
  for (const line of tables.split('\n')) {
    const [, local, , status] = line.trim().split(/\s+/);
    const match = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(local ?? '');
    if (!match || status !== LISTEN_STATE) continue;
    const port = parseInt(match[2], 16);
    const listener = readAddress(match[1]);
    const known = found.get(port) ?? [];
    if (!known.some((entry) => entry.address === listener.address)) found.set(port, [...known, listener]);
  }
  return found;
}

/** Null if they couldn't be read, which shouldn't hold up what was asked for. */
async function listenersIn(sandbox: string): Promise<Map<number, Listener[]> | null> {
  try {
    return parseListeners(await execText(sandbox, ['sh', '-c', LISTENERS_SCRIPT], { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 }));
  } catch (error) {
    console.error('could not read what’s listening in a workspace:', errorMessage(error));
    return null;
  }
}

type Reach = 'unknown' | 'nothing' | 'everywhere' | 'localhost' | 'elsewhere';

/** Whether the user could reach a server on this port. sbx connects from outside the VM, so loopback isn't enough. */
function reachOf(listeners: Map<number, Listener[]> | null, port: number): Reach {
  const found = listeners?.get(port) ?? [];
  if (!listeners) return 'unknown';
  if (found.length === 0) return 'nothing';
  if (found.some((listener) => listener.any)) return 'everywhere';
  return found.every((listener) => listener.loopback) ? 'localhost' : 'elsewhere';
}

/** What's listening on a port, and what to do about it for the user to reach it. */
function describeListening(listeners: Map<number, Listener[]> | null, port: number): string {
  const where = (listeners?.get(port) ?? []).map((listener) => listener.address).join(', ');
  switch (reachOf(listeners, port)) {
    case 'unknown': return 'Lonca couldn\'t check what\'s listening on it.';
    case 'nothing': return 'Nothing is listening on it yet: start the server on 0.0.0.0, not only localhost, for the user to reach it.';
    case 'everywhere': return `A server is listening on it on all interfaces (${where}), so the user can reach it.`;
    case 'localhost': return `A server is listening on it, but only on localhost (${where}), so the user can't reach it. Restart the server on 0.0.0.0.`;
    case 'elsewhere': return `A server is listening on it, but only on ${where}. Restart it on 0.0.0.0 to be sure the user can reach it.`;
  }
}

/** Why a port on the user's computer can't be forwarded to, or null if it can. */
async function hostPortProblem(workspace: Workspace, hostPort: number): Promise<string | null> {
  if (!Number.isInteger(hostPort) || hostPort < LOWEST_HOST_PORT || hostPort > HIGHEST_PORT) {
    return `A port on the user's computer has to be from ${LOWEST_HOST_PORT} to ${HIGHEST_PORT}, so localhost:${hostPort} can't be used.`;
  }
  // A browser keeps Lonca's token for each origin it opened Lonca on, where a page the VM served could
  // read it, or install a service worker that takes over Lonca's pages whenever it's back on that port.
  if ([HTTP_PORT, DEFAULT_HTTP_PORT, DEV_PORT, ...uiPorts()].includes(hostPort)) return `localhost:${hostPort} is kept for Lonca's own pages.`;
  if (hostPort === CODEX_SIGN_IN_PORT) return `localhost:${hostPort} is kept for signing in to Codex.`;
  if (BROWSER_BLOCKED_PORTS.includes(hostPort)) return `Browsers won't open localhost:${hostPort}.`;
  const owner = state.workspaces.find((entry) => isOwnPort(entry, hostPort));
  if (owner) return `localhost:${hostPort} is one of the ports published for ${owner === workspace ? 'this workspace' : 'another workspace'}.`;
  for (const entry of state.workspaces) {
    const forward = forwardsOf(entry).find((existing) => existing.hostPort === hostPort);
    if (forward) return `localhost:${hostPort} is already forwarded to ${entry === workspace ? `port ${forward.port} here` : 'another workspace'}.`;
  }
  if (!await isPortFree(hostPort)) return `Something on the user's computer is already using localhost:${hostPort}.`;
  return null;
}

/** A port the system has free, as it would choose for sbx, but known before sbx is asked. */
function portTheSystemPicks(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The port asked for, or else the same as in the VM, or else one the system has free. */
async function chooseHostPort(workspace: Workspace, port: number, wanted: number | undefined): Promise<number> {
  if (wanted !== undefined) {
    const problem = await hostPortProblem(workspace, wanted);
    if (problem) throw new HttpError(409, `${problem} Choose another host_port, or leave it out for Lonca to choose one.`);
    return wanted;
  }
  if (!await hostPortProblem(workspace, port)) return port;
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt++) {
    const picked = await portTheSystemPicks();
    if (!await hostPortProblem(workspace, picked)) return picked;
  }
  throw new HttpError(503, 'Lonca couldn\'t find a free port on the user\'s computer to forward to.');
}

/** Recorded before sbx is asked, so that nothing Lonca publishes is ever left without a record to close it by. */
function recordForward(workspace: Workspace, forward: PortForward): void {
  const before = workspace.forwards;
  workspace.forwards = [...forwardsOf(workspace), forward];
  try {
    flushState({ required: true });
  } catch (error) {
    workspace.forwards = before;
    throw error;
  }
  publishWorkspace(workspace);
}

/** Forwards a port on the user's localhost to `port` in the workspace's VM, and says where and what's there. */
export function forwardPort(workspace: Workspace, port: number, wanted?: number): Promise<string> {
  return changes.run(workspace.id, async () => {
    const sandbox = await runningVm(workspace, 'nothing can be forwarded to it');
    if (isOwnPort(workspace, port)) {
      const listening = describeListening(await listenersIn(sandbox), port);
      return `Port ${port} is one of this workspace's ten published ports, so the user can already open it at ${url(port)}. ${listening}`;
    }
    const existing = forwardsOf(workspace).find((forward) => forward.port === port);
    if (existing && wanted !== undefined && wanted !== existing.hostPort) {
      throw new HttpError(409, `Port ${port} is already forwarded to ${url(existing.hostPort)}. Close it with close_port first to forward it to localhost:${wanted} instead.`);
    }
    if (existing) {
      const listening = describeListening(await listenersIn(sandbox), port);
      return `Port ${port} is already forwarded to ${url(existing.hostPort)} on the user's computer. ${listening}`;
    }
    // A new workspace or another forward may be choosing at the same time. The record keeps them off this one.
    const forward = await reserveHostPorts(async () => {
      const chosen = { hostPort: await chooseHostPort(workspace, port, wanted), port, since: Date.now() };
      recordForward(workspace, chosen);
      return chosen;
    });
    try {
      await publishPort(sandbox, forward.hostPort, port);
    } catch (error) {
      // It may have been published anyway, as when sbx took too long to answer. Unpublishing what isn't does
      // nothing. If that fails too, the record stays, for the next stop or start to close it.
      const gone = await unpublishPort(sandbox, forward.hostPort, port).then(() => true, () => false);
      if (gone) setForwards(workspace, forwardsOf(workspace).filter((entry) => entry !== forward));
      const kept = gone ? '' : ` Lonca couldn't tell whether it was forwarded anyway, so it's listed until it can be closed. Close it with close_port before trying again.`;
      throw new HttpError(502, `Docker Sandboxes couldn't forward localhost:${forward.hostPort} to port ${port}: ${errorMessage(error)}${kept}`);
    }
    const moved = wanted === undefined && forward.hostPort !== port ? ` localhost:${port} wasn't available on the user's computer, so Lonca chose another port.` : '';
    const listeners = await listenersIn(sandbox);
    const reach = reachOf(listeners, port);
    const stays = reach === 'localhost' || reach === 'elsewhere' ? ' The forward stays in place meanwhile.' : '';
    return `Forwarded port ${port} to ${url(forward.hostPort)} on the user's computer.${moved} ${describeListening(listeners, port)}${stays}`;
  });
}

/** Stops forwarding to `port`. The record stays if sbx can't do it, since sbx would still have the port. */
export function closePort(workspace: Workspace, port: number): Promise<string> {
  return changes.run(workspace.id, async () => {
    const sandbox = await runningVm(workspace, 'its forwards are closed already');
    if (isOwnPort(workspace, port)) {
      throw new HttpError(409, `Port ${port} is one of this workspace's ten published ports, which stay published while it runs. Only ports forwarded with forward_port can be closed.`);
    }
    const forward = forwardsOf(workspace).find((entry) => entry.port === port);
    if (!forward) {
      const others = forwardsOf(workspace).map((entry) => entry.port).join(', ');
      throw new HttpError(404, `Port ${port} isn't forwarded.${others ? ` Forwarded ports: ${others}.` : ''}`);
    }
    try {
      await unpublishPort(sandbox, forward.hostPort, forward.port);
    } catch (error) {
      throw new HttpError(502, `Docker Sandboxes couldn't stop forwarding localhost:${forward.hostPort} to port ${port}: ${errorMessage(error)}`);
    }
    setForwards(workspace, forwardsOf(workspace).filter((entry) => entry !== forward));
    return `Stopped forwarding localhost:${forward.hostPort} to port ${port}.`;
  });
}

/** The ten ports every workspace has and the forwards on top, with what's listening on each. Never starts the VM. */
export async function listPorts(workspace: Workspace): Promise<string> {
  const first = workspace.port;
  const last = first + PORTS_PER_WORKSPACE - 1;
  let sandbox: string;
  try {
    sandbox = await runningVm(workspace, 'there are no forwards');
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    return `${error.message} Ports ${first}-${last} are published while it runs.`;
  }
  const listeners = await listenersIn(sandbox);
  const fixed = Array.from({ length: PORTS_PER_WORKSPACE }, (_, offset) => first + offset)
    .map((port) => `- ${port} at ${url(port)}: ${describeListening(listeners, port)}`);
  const forwards = forwardsOf(workspace)
    .map((forward) => `- localhost:${forward.hostPort} → ${forward.port}, since ${new Date(forward.since).toISOString()}, at ${url(forward.hostPort)}: ${describeListening(listeners, forward.port)}`);
  return [
    `Ports ${first}-${last} are published at the same ports on the user's localhost while this workspace runs:\n${fixed.join('\n')}`,
    forwards.length > 0 ? `Forwarded with forward_port (localhost on the user's computer → port here):\n${forwards.join('\n')}` : 'Nothing else is forwarded.',
  ].join('\n\n');
}

/**
 * Before Lonca starts, stops or removes a sandbox, ahead of anything that could fail on the way.
 * sbx keeps what's published while a sandbox is stopped, publishes it again when it starts, and
 * won't start it if one of those ports has been taken meanwhile. Unpublishing doesn't start a
 * stopped one. A forward that can't be closed is kept, to be tried again next time, and holds
 * nothing up.
 */
function closeForwards(workspace: Workspace): Promise<void> {
  return changes.run(workspace.id, async () => {
    if (forwardsOf(workspace).length === 0) return;
    // Removing a sandbox, as by hand, lets go of every port it had.
    if (await sandboxState(workspace.sandboxName).catch(() => 'unknown') === 'missing') return setForwards(workspace, []);
    const kept: PortForward[] = [];
    for (const forward of forwardsOf(workspace)) {
      try {
        await unpublishPort(workspace.sandboxName, forward.hostPort, forward.port);
      } catch (error) {
        console.error(`could not stop forwarding localhost:${forward.hostPort} to ${workspace.name}:`, errorMessage(error));
        kept.push(forward);
      }
    }
    setForwards(workspace, kept);
  });
}

// Before a start too, since a sandbox that stopped some other way, as with sbx stop, had no chance to.
onSandboxChange(closeForwards);
