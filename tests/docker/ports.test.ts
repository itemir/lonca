import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, ChatItem, Project, Session, ToolItem, Workspace } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, sandboxExec, sandboxRunning, sbx, sleep, until } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

// A Lead forwarding ports with the real CLI, through the same MCP server and files as in real use,
// to servers running in its workspace, which this test then opens from this computer as the user
// would. It runs against the real sbx as well.

const lonca = new Lonca({ port: 48463, instance: 'ports-test', firstWorkspacePort: 59600 });
let mock: MockLlm;
let fixture: string;
let project: Project;
let workspace: Workspace;
let lead: Session;

const tool = (name: string, args: Record<string, unknown> = {}) => `TOOL: ${name} ${JSON.stringify(args)}`;
const tools = (items: ChatItem[]) => items.filter((item): item is ToolItem => item.type === 'tool');

async function current(): Promise<Workspace> {
  return lonca.workspace(workspace.id);
}

/** Has the Lead call one of its tools, and returns what came back. */
async function leadCalls(name: string, args: Record<string, unknown> = {}): Promise<ToolItem> {
  const before = tools(await lonca.items(lead.id)).length;
  await lonca.api('POST', `/sessions/${lead.id}/messages`, { text: tool(name, args), attachments: [] });
  const answered = await until(`${name} to answer`, async () => tools(await lonca.items(lead.id)).slice(before)
    .find((item) => item.name.endsWith(name) && item.status !== 'running'));
  await lonca.waitForIdle(lead.id);
  return answered;
}

function urlIn(reply: string | undefined): string {
  const found = /http:\/\/localhost:\d+/.exec(reply ?? '')?.[0];
  if (!found) throw new Error(`No URL in: ${reply}`);
  return found;
}

const portOf = (url: string) => Number(new URL(url).port);

/** Whether nothing on this computer listens on a port on any address, as Lonca asks before forwarding to it. */
async function hostPortFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '0.0.0.0', '::1', '::']) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}

/** A port on this computer that nothing is using. Its number serves for one in the VM too. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
    });
    if (await hostPortFree(port)) return port;
  }
}

async function page(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return response.text();
}

/**
 * Stops the VM the way something outside Lonca would. Lonca reads from it after a turn, and a read
 * can start it again, as sbx exec does, so this waits until it stays stopped.
 */
async function stopOutsideLonca(): Promise<void> {
  await until('the VM to stay stopped', async () => {
    sbx('stop', workspace.sandboxName);
    await sleep(1500);
    return sandboxRunning(workspace.sandboxName) === false;
  }, 30000, 0);
}

/** A small web server in the VM, on 0.0.0.0 or only on loopback, saying which one it is. */
function serve(port: number, bind: '0.0.0.0' | '127.0.0.1'): void {
  const started = sandboxExec(workspace.sandboxName, `
    mkdir -p /tmp/site-${port} && echo "served from port ${port} in the VM" > /tmp/site-${port}/index.html
    (nohup python3 -m http.server ${port} --bind ${bind} --directory /tmp/site-${port} </dev/null) >/dev/null 2>&1 &
    for _ in $(seq 1 100); do curl -s -o /dev/null http://127.0.0.1:${port}/ && exit 0; sleep 0.1; done
    exit 1`);
  expect(started.code, started.output).toBe(0);
}

beforeAll(async () => {
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock' } },
  });
  await until('sign-in status', async () => (await lonca.api<AppState>('GET', '/state')).system.agentsChecked, 120000);
  await lonca.api('PATCH', '/settings', { leadDefault: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } });
  const created = await lonca.api<{ workspace: Workspace; session: Session }>('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(created.workspace.id);
  lead = created.session;
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('a Lead forwarding ports', () => {
  let shared: number;

  it('forwards a port to a server listening on 0.0.0.0, which can then be opened from this computer', async () => {
    shared = await freePort();
    serve(shared, '0.0.0.0');
    const forwarded = await leadCalls('forward_port', { port: shared });
    expect(forwarded.status, forwarded.output).toBe('done');
    expect(forwarded.title).toBe(`Forwarded port ${shared}`);
    // Free here, so it's the same number.
    expect(urlIn(forwarded.output)).toBe(`http://localhost:${shared}`);
    expect(forwarded.output).toContain('A server is listening on it on all interfaces (0.0.0.0), so the user can reach it.');
    expect(await until('the page', async () => page(`http://localhost:${shared}`))).toContain(`served from port ${shared} in the VM`);

    // Another port of the user's choosing.
    const port = await freePort();
    const hostPort = await freePort();
    serve(port, '0.0.0.0');
    const chosen = await leadCalls('forward_port', { port, host_port: hostPort });
    expect(chosen.status, chosen.output).toBe('done');
    expect(urlIn(chosen.output)).toBe(`http://localhost:${hostPort}`);
    expect(await until('the page', async () => page(`http://localhost:${hostPort}`))).toContain(`served from port ${port} in the VM`);

    // Asking again gives the same forward back.
    const again = await leadCalls('forward_port', { port: shared });
    expect(again.output).toContain(`Port ${shared} is already forwarded to http://localhost:${shared}`);
    expect((await current()).forwards).toEqual([
      { hostPort: shared, port: shared, since: expect.any(Number) },
      { hostPort, port, since: expect.any(Number) },
    ]);
  });

  it('lists what’s published and forwarded, and closes a forward', async () => {
    const listed = await leadCalls('list_ports');
    expect(listed.status, listed.output).toBe('done');
    expect(listed.title).toBe('Checked the ports');
    expect(listed.output).toContain(`Ports ${workspace.port}-${workspace.port + 9} are published at the same ports on the user's localhost`);
    expect(listed.output).toContain(`- ${workspace.port} at http://localhost:${workspace.port}: Nothing is listening on it yet`);
    expect(listed.output).toMatch(new RegExp(`- localhost:${shared} → ${shared}, since \\S+, at http://localhost:${shared}: A server is listening on it on all interfaces`));

    const closed = await leadCalls('close_port', { port: shared });
    expect(closed.status, closed.output).toBe('done');
    expect(closed.output).toBe(`Stopped forwarding localhost:${shared} to port ${shared}.`);
    expect(await until('the port to be let go', () => hostPortFree(shared), 20000)).toBe(true);
    await expect(page(`http://localhost:${shared}`)).rejects.toThrow();
    expect((await current()).forwards?.map((forward) => forward.port)).not.toContain(shared);

    const after = await leadCalls('list_ports');
    expect(after.output).not.toContain(`localhost:${shared} →`);
    const refused = await leadCalls('close_port', { port: workspace.port });
    expect(refused.status).toBe('error');
    expect(refused.output).toContain('one of this workspace\'s ten published ports');
  });

  it('tells the Lead to restart a server that only listens on localhost, and the user can close its forward', async () => {
    const port = await freePort();
    serve(port, '127.0.0.1');
    const forwarded = await leadCalls('forward_port', { port });
    expect(forwarded.status, forwarded.output).toBe('done');
    expect(forwarded.output).toContain('but only on localhost (127.0.0.1), so the user can\'t reach it. Restart the server on 0.0.0.0.');
    expect(forwarded.output).toContain('The forward stays in place meanwhile.');
    const hostPort = portOf(urlIn(forwarded.output));
    expect((await current()).forwards?.some((forward) => forward.port === port && forward.hostPort === hostPort)).toBe(true);
    // Lonca doesn't bridge it, so the user really can't reach it.
    await expect(page(`http://localhost:${hostPort}`)).rejects.toThrow();
    // Restarted on 0.0.0.0, as the Lead is told, it can be reached through the same forward.
    sandboxExec(workspace.sandboxName, `pkill -f 'http.server ${port} '; true`);
    serve(port, '0.0.0.0');
    expect(await until('the page', async () => page(`http://localhost:${hostPort}`))).toContain(`served from port ${port} in the VM`);

    // The button beside it in the workspace.
    await lonca.api('DELETE', `/workspaces/${workspace.id}/ports/${port}`);
    expect((await current()).forwards?.some((forward) => forward.port === port)).toBeFalsy();
    expect(await until('the port to be let go', () => hostPortFree(hostPort), 20000)).toBe(true);
    await expect(lonca.api('DELETE', `/workspaces/${workspace.id}/ports/${port}`)).rejects.toThrow(/404.*isn't forwarded/);
  });

  it('closes forwards when the workspace stops, and any a stop outside Lonca left before it starts again', async () => {
    const forwards = (await current()).forwards ?? [];
    expect(forwards.length).toBeGreaterThan(0);
    await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
    expect((await current()).status).toBe('stopped');
    expect((await current()).forwards).toBeUndefined();
    await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    expect((await current()).status).toBe('ready');
    expect((await current()).forwards).toBeUndefined();
    for (const forward of forwards) expect(await hostPortFree(forward.hostPort)).toBe(true);

    // Stopped some other way, it has no chance to close them, and sbx publishes them again on start.
    const port = await freePort();
    const forwarded = await leadCalls('forward_port', { port });
    expect(forwarded.status, forwarded.output).toBe('done');
    const hostPort = portOf(urlIn(forwarded.output));
    await stopOutsideLonca();
    await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    await lonca.waitForWorkspace(workspace.id);
    expect((await current()).forwards).toBeUndefined();
    expect(await until('the port to be let go', () => hostPortFree(hostPort), 20000)).toBe(true);
    // Nothing of it is left to take the user anywhere.
    serve(port, '0.0.0.0');
    await expect(page(`http://localhost:${hostPort}`)).rejects.toThrow();
    const listed = await leadCalls('list_ports');
    expect(listed.output).toContain('Nothing else is forwarded.');
  });

  it('starts a workspace that stopped outside Lonca after something else took a port it forwarded', async () => {
    const forwarded = await leadCalls('forward_port', { port: await freePort() });
    expect(forwarded.status, forwarded.output).toBe('done');
    const hostPort = portOf(urlIn(forwarded.output));
    await stopOutsideLonca();
    // sbx won't start a sandbox when a port it would publish again is taken.
    const squatter = net.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject);
      squatter.listen(hostPort, '127.0.0.1', resolve);
    });
    try {
      await lonca.api('POST', `/workspaces/${workspace.id}/start`);
      expect((await current()).status).toBe('ready');
      expect((await current()).forwards).toBeUndefined();
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});
