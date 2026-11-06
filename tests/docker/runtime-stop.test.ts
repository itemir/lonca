import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AppState, Project, Session, TerminalInfo, Workspace } from '../../shared/types.ts';
import { FAKE_SANDBOX, FAKE_SBX_DIR, RUNTIME, Lonca, asRoot, sandboxExec, makeFixtureRepo, sandboxRunning, sbx, sleep, until, REAL_SANDBOX } from '../support/harness.ts';

const lonca = new Lonca({ port: 48339, instance: `runtime-stop-${RUNTIME}`, firstWorkspacePort: 54900});
let fixture: string;
let project: Project;
let workspace: Workspace;
let session: Session;

beforeAll(() => lonca.start());
beforeEach(async () => {
  fixture = makeFixtureRepo();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(created.workspace.id);
  session = created.session;
  // Provisioning publishes ready before looking up an optional setup script.
  // Wait for that short command before testing an unrelated external stop.
  await sleep(1000);
});
afterEach(async () => {
  if ((await lonca.api<AppState>('GET', '/state')).projects.some((entry) => entry.id === project.id)) {
    await lonca.api('DELETE', `/projects/${project.id}`);
  }
  fs.rmSync(fixture, { recursive: true, force: true });
});
afterAll(() => lonca.destroy());

function stopRuntime(): void {
  sbx('stop', workspace.sandboxName);
}

async function startAgent(): Promise<string> {
  const cli = sandboxExec(workspace.sandboxName, 'command -v claude').output;
  const quotedCli = `'${cli.replaceAll("'", "'\\''")}'`;
  asRoot(workspace.sandboxName, `cat > ${quotedCli} <<'CLI'
#!/bin/bash
cat >/dev/null
echo '{"type":"assistant","message":{"id":"saved","content":[{"type":"text","text":"saved answer"}]}}'
sleep 600
CLI
chmod +x ${quotedCli}`);
  await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Keep running' });
  await until('saved agent output', async () => (await lonca.items(session.id)).some((item) => item.type === 'text')
    && fs.readFileSync(path.join(lonca.home, 'sessions', `${session.id}.jsonl`), 'utf8').includes('saved answer'));
  return (await lonca.session(session.id)).activeRunId!;
}

async function occupyPort(): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(workspace.port, '127.0.0.1', resolve);
  });
  return server;
}

const releasePort = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

it.each(['workspace', 'project', 'retry'] as const)('can delete a stopped workspace with pending output and an occupied port through %s deletion', async (action) => {
  await startAgent();
  await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Do not start this queued turn' });
  await lonca.kill();
  stopRuntime();
  const blocker = await occupyPort();
  try {
    if (action === 'retry') {
      // The durable state at a crash after beginOperation, before teardown.
      const file = path.join(lonca.home, 'state.json');
      const saved: AppState = JSON.parse(fs.readFileSync(file, 'utf8'));
      const interrupted = saved.workspaces.find((entry) => entry.id === workspace.id)!;
      interrupted.status = 'deleting';
      interrupted.pendingOperation = 'delete';
      fs.writeFileSync(file, JSON.stringify(saved));
    }
    await lonca.start();
    await lonca.waitForWorkspace(workspace.id, action === 'retry' ? 'error' : 'stopped');
    if (action === 'project') await lonca.api('DELETE', `/projects/${project.id}`);
    else if (action === 'retry') {
      await until('the saved deletion to settle its stopped run', async () => !(await lonca.session(session.id)).activeRunId);
      expect(sandboxRunning(workspace.sandboxName)).toBe(false);
      await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
      await until('retried workspace deletion', async () => !await lonca.workspace(workspace.id));
    } else await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    expect(await lonca.workspace(workspace.id)).toBeUndefined();
    expect((await lonca.api<AppState>('GET', '/state')).sessions.some((entry) => entry.workspaceId === workspace.id)).toBe(false);
    expect(fs.existsSync(path.join(lonca.home, 'sessions', `${session.id}.jsonl`))).toBe(false);
    expect(sandboxRunning(workspace.sandboxName)).toBeNull();
    expect(fs.existsSync(workspace.path)).toBe(false);
  } finally {
    await releasePort(blocker);
  }
});

it.each(['archive', 'rebuild'] as const)('retains pending output when an occupied port prevents %s', async (operation) => {
  const runId = await startAgent();
  await lonca.kill();
  stopRuntime();
  const blocker = await occupyPort();
  try {
    await lonca.start();
    await lonca.waitForWorkspace(workspace.id, 'stopped');
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/${operation === 'rebuild' ? 'recreate' : operation}`)).rejects.toThrow();
    expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: operation });
    expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId });
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  } finally {
    await releasePort(blocker);
  }
  await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
  await lonca.waitForWorkspace(workspace.id, operation === 'archive' ? 'archived' : 'ready');
  await lonca.waitForIdle(session.id);
  expect((await lonca.items(session.id)).some((item) => item.type === 'text' && item.text === 'saved answer')).toBe(true);
});

it.skipIf(REAL_SANDBOX)('does not discard a workspace run while its runtime cannot be reached', async () => {
  const runId = await startAgent();
  const pid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/agent-runs/${runId}/pid`).output;
  await lonca.kill();
  lonca.setOffline(true);
  await lonca.start();
  try {
    await expect(lonca.api('DELETE', `/workspaces/${workspace.id}`)).rejects.toThrow(/reconnecting/);
    expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId });
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  } finally {
    await lonca.kill();
    lonca.setOffline(false);
    await lonca.start();
  }
  await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
  await until('deletion after reconnecting', async () => !await lonca.workspace(workspace.id));
  expect(sandboxRunning(workspace.sandboxName)).toBeNull();
});

it('can delete a workspace whose finished run output cannot be read', async () => {
  const runId = await startAgent();
  await lonca.kill();
  const dir = `/var/tmp/lonca/agent-runs/${runId}`;
  expect(sandboxExec(workspace.sandboxName, `kill -KILL -- -"$(cat ${dir}/pid)"\nchmod 000 ${dir}/out.jsonl`).code).toBe(0);
  await lonca.start();
  await until('output recovery to retry', async () => (await lonca.items(session.id)).some((item) => item.type === 'notice' && item.text.includes('keeping its recovery data')));
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId });
  await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  expect(await lonca.workspace(workspace.id)).toBeUndefined();
  expect(sandboxRunning(workspace.sandboxName)).toBeNull();
});

it.each(['shell', 'setup'] as const)('does not restart a stopped runtime when a connected %s stream closes', async (kind) => {
  let terminal: TerminalInfo;
  if (kind === 'shell') terminal = await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
  else {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: 'sleep 600' } });
    terminal = await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
  }
  const connected = await lonca.openTerminal(terminal.id);
  try {
    expect((await lonca.api<AppState>('GET', '/state')).terminals.find((entry) => entry.id === terminal.id)?.status).toBe('running');
    stopRuntime();
    await until('the terminal to exit', async () => (await lonca.api<AppState>('GET', '/state')).terminals.find((entry) => entry.id === terminal.id)?.status === 'exited', 15000);
    // Browser resizes and background reconciliation must keep it stopped too.
    connected.socket.send(JSON.stringify({ type: 'resize', cols: 110, rows: 40 }));
    for (let i = 0; i < 6; i++) {
      await sleep(1000);
      expect(sandboxRunning(workspace.sandboxName)).toBe(false);
    }
    if (FAKE_SANDBOX) expect(fs.readFileSync(path.join(FAKE_SBX_DIR, 'calls.log'), 'utf8')).not.toContain(`exec-start ${workspace.sandboxName} `);
    if (kind === 'setup') expect((await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup')?.status).toBe('error');
  } finally {
    connected.socket.close();
  }
});

it('settles recovered terminal controls without restarting a stopped runtime', async () => {
  const shell = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
  const connected = await lonca.openTerminal(shell.id);
  try {
    // Survive a lost PTY so this exercises controls recovered after a crash.
    connected.send("trap '' HUP TERM; while :; do echo tick >> .context/recovered-shell; sleep 0.2; done\n");
    await until('shell heartbeat', () => fs.existsSync(path.join(workspace.path, '.context/recovered-shell')));
    const pid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${shell.id}.pid`).output;
    await lonca.kill();
    await lonca.start();
    await until('recovered terminal controls', async () => (await lonca.api<AppState>('GET', '/state')).terminals.some((entry) => entry.id === shell.id && entry.disconnected));
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
    stopRuntime();
    await until('recovered terminal to exit', async () => (await lonca.api<AppState>('GET', '/state')).terminals.find((entry) => entry.id === shell.id)?.status === 'exited', 15000);
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  } finally {
    connected.socket.close();
  }
});

it('retains an abnormal script exit code after deferred process recovery', async () => {
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: 'kill -KILL $$' } });
  const terminal = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/scripts/setup`);
  await until('the killed script result', async () => (await lonca.api<AppState>('GET', '/state')).terminals
    .find((entry) => entry.id === terminal.id)?.status === 'exited', 20000);
  expect((await lonca.api<AppState>('GET', '/state')).terminals.find((entry) => entry.id === terminal.id)?.exitCode).toBe(137);
  expect((await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup')).toMatchObject({ status: 'error', detail: 'The setup script exited with code 137.' });
  expect(sandboxRunning(workspace.sandboxName)).toBe(true);
});
