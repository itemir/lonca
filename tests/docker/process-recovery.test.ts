import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppState, Project, Session, TerminalInfo, UserItem, Workspace } from '../../shared/types.ts';
import { Lonca, sandboxExec, makeFixtureRepo, sleep, until, asRoot, sbx, REAL_SANDBOX } from '../support/harness.ts';

const lonca = new Lonca({ port: 48321, instance: `process-recovery-sandbox`, firstWorkspacePort: 52800});
let fixture: string;
let project: Project;
let workspace: Workspace;
beforeAll(async () => {
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
  asRoot(workspace.sandboxName, `mv /usr/local/bin/claude /usr/local/bin/claude-original
cat > /usr/local/bin/claude <<'AGENT'
#!/bin/bash
trap '' TERM HUP
head -n 1 >/dev/null
while true; do echo tick >> .context/agent-heartbeat; sleep 0.2; done
AGENT
chmod +x /usr/local/bin/claude`);
});

afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

async function script(): Promise<{ terminal: TerminalInfo; pid: string }> {
  const command = "trap '' TERM HUP; while true; do echo tick >> .context/setup-heartbeat; sleep 0.2; done";
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: command } });
  const terminal = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/scripts/setup`);
  await until('the script PID', () => sandboxExec(workspace.sandboxName, `test -s /var/tmp/lonca/tty/${terminal.id}.pid`).code === 0);
  return { terminal, pid: sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${terminal.id}.pid`).output };
}

it('recovers setup controls after restart and stops the surviving process group', async () => {
  const { terminal, pid } = await script();
  await lonca.kill();
  await lonca.start();
  await until('recovered script controls', async () => (await lonca.api<AppState>('GET', '/state')).terminals.some((entry) => entry.id === terminal.id && entry.status === 'running'));
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
  expect(sandboxExec(workspace.sandboxName, `kill -0 -- -${pid}`).code).not.toBe(0);
  const file = path.join(workspace.path, '.context/setup-heartbeat');
  const size = fs.statSync(file).size;
  await sleep(400);
  expect(fs.statSync(file).size).toBe(size);
  expect((await lonca.api<AppState>('GET', '/state')).terminals.find((entry) => entry.id === terminal.id)?.status).toBe('exited');
});

it('serializes Stop with an in-flight script replacement', async () => {
  const { pid } = await script();
  // Replacement waits for a TERM-ignoring predecessor, leaving a deterministic Stop window.
  const restarting = lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/scripts/setup`);
  await sleep(100);
  const stopping = lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
  const [replacement] = await Promise.all([restarting, stopping]);
  expect(sandboxExec(workspace.sandboxName, `kill -0 -- -${pid}`).code).not.toBe(0);
  expect((await lonca.api<AppState>('GET', '/state')).terminals.find((entry) => entry.id === replacement.id)?.status).toBe('exited');
  expect(sandboxExec(workspace.sandboxName, `test -e /var/tmp/lonca/tty/${replacement.id}.pid`).code).not.toBe(0);
});

it('recovers a surviving shell, replaces its process on restart, and closes its group', async () => {
  const shell = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
  const terminal = await lonca.openTerminal(shell.id);
  try {
    terminal.send("trap '' HUP TERM; while true; do echo tick >> .context/shell-heartbeat; sleep 0.2; done\n");
    await until('the shell heartbeat', () => fs.existsSync(path.join(workspace.path, '.context/shell-heartbeat')));
    const pid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${shell.id}.pid`).output;
    await lonca.kill();
    await lonca.start();
    await until('recovered shell controls', async () => (await lonca.api<AppState>('GET', '/state')).terminals.some((entry) => entry.id === shell.id && entry.disconnected));
    await lonca.api('POST', `/workspaces/${workspace.id}/terminals/${shell.id}/restart`);
    const replacementPid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${shell.id}.pid`).output;
    expect(replacementPid).not.toBe(pid);
    expect(sandboxExec(workspace.sandboxName, `kill -0 -- -${pid}`).code).not.toBe(0);
    await lonca.api('DELETE', `/terminals/${shell.id}`);
    expect(sandboxExec(workspace.sandboxName, `kill -0 -- -${replacementPid}`).code).not.toBe(0);
  } finally {
    terminal.socket.close();
  }
});

function heartbeatJob(name: string, stubborn: boolean): string {
  return `node -e '${stubborn ? 'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {});' : ''}
const fs = require("node:fs");
fs.writeFileSync(".context/${name}.pid", String(process.pid));
setInterval(() => fs.appendFileSync(".context/${name}", "tick\\n"), 100);'`;
}

it.each([
  { name: 'closing a connected terminal', recover: false, orphan: false, restart: false },
  { name: 'closing a recovered terminal', recover: true, orphan: false, restart: false },
  { name: 'restarting a recovered terminal', recover: true, orphan: false, restart: true },
  { name: 'recovering jobs whose shell died', recover: true, orphan: true, restart: false },
])('stops foreground and background job groups when $name', async ({ recover, orphan, restart }) => {
  const shell = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
  const terminal = await lonca.openTerminal(shell.id);
  let other: TerminalInfo | undefined;
  try {
    const names = [`${shell.id}-background`, `${shell.id}-foreground`];
    // Keep these jobs alive through a lost PTY too, and exercise escalation after TERM.
    terminal.send(`${recover ? "trap '' HUP TERM; " : ''}${heartbeatJob(names[0], recover)} &\n${heartbeatJob(names[1], recover)}\n`);
    await until('both job heartbeats', () => names.every((name) => fs.existsSync(path.join(workspace.path, `.context/${name}`))));
    const pids = names.map((name) => fs.readFileSync(path.join(workspace.path, `.context/${name}.pid`), 'utf8'));
    const shellPid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${shell.id}.pid`).output;
    for (const pid of pids) {
      expect(sandboxExec(workspace.sandboxName, `ps -o pgid= -p ${pid}`).output.trim()).not.toBe(shellPid);
      expect(sandboxExec(workspace.sandboxName, `ps -o sid= -p ${pid}`).output.trim()).toBe(shellPid);
    }
    if (orphan) expect(sandboxExec(workspace.sandboxName, `kill -KILL ${shellPid}`).code).toBe(0);
    if (recover) {
      await lonca.kill();
      await lonca.start();
      await until('recovered job controls', async () => (await lonca.api<AppState>('GET', '/state')).terminals.some((entry) => entry.id === shell.id && entry.disconnected));
    }
    // Stopping one session must leave another terminal in the same workspace alone.
    other = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
    const otherPid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${other.id}.pid`).output;
    if (restart) await lonca.api('POST', `/workspaces/${workspace.id}/terminals/${shell.id}/restart`);
    else await lonca.api('DELETE', `/terminals/${shell.id}`);
    for (const pid of [shellPid, ...pids]) {
      await until('the old process to be reaped', () => sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code !== 0, 5000);
    }
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${otherPid}`).code).toBe(0);
    const sizes = names.map((name) => fs.statSync(path.join(workspace.path, `.context/${name}`)).size);
    await sleep(300);
    expect(names.map((name) => fs.statSync(path.join(workspace.path, `.context/${name}`)).size)).toEqual(sizes);
    const current = (await lonca.api<AppState>('GET', '/state')).terminals.find((entry) => entry.id === shell.id);
    if (restart) expect(current).toMatchObject({ status: 'running' });
    else expect(current).toBeUndefined();
  } finally {
    terminal.socket.close();
    await lonca.api('DELETE', `/terminals/${shell.id}`);
    if (other) await lonca.api('DELETE', `/terminals/${other.id}`);
  }
});

it('stops setup jobs in separate groups after their script leader exits', async () => {
  const name = 'setup-job';
  const command = `set -m; ${heartbeatJob(name, true)} & wait`;
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: command } });
  const terminal = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/scripts/setup`);
  const file = path.join(workspace.path, `.context/${name}`);
  await until('the job heartbeat', () => fs.existsSync(file));
  const pid = fs.readFileSync(`${file}.pid`, 'utf8');
  const leader = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${terminal.id}.pid`).output;
  expect(sandboxExec(workspace.sandboxName, `kill -KILL ${leader}`).code).toBe(0);
  await lonca.kill();
  await lonca.start();
  await until('recovered script job controls', async () => (await lonca.api<AppState>('GET', '/state')).terminals.some((entry) => entry.id === terminal.id && entry.status === 'running'));
  await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
  await until('the script job to be reaped', () => sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code !== 0, 5000);
  const size = fs.statSync(file).size;
  await sleep(300);
  expect(fs.statSync(file).size).toBe(size);
});

it('recovers a terminal even when another one’s record is damaged', async () => {
  const healthy = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
  const damaged = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
  const damagedPid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${damaged.id}.pid`).output;
  // Losing the server can end a shell's terminal, which an idle shell takes as its cue to exit,
  // so this one stays busy, ignoring the hangup.
  const connected = await lonca.openTerminal(healthy.id);
  connected.send("trap '' HUP TERM; while true; do echo tick >> .context/healthy-shell; sleep 0.2; done\n");
  await until('the healthy shell', () => fs.existsSync(path.join(workspace.path, '.context/healthy-shell')));
  connected.socket.close();
  await lonca.kill();
  expect(sandboxExec(workspace.sandboxName, `f=/var/tmp/lonca/tty/${damaged.id}.pid; rm -f "$f" && mkfifo "$f"`).code).toBe(0);
  await lonca.start();
  try {
    await until('the healthy terminal’s controls', async () => (await lonca.api<AppState>('GET', '/state'))
      .terminals.some((entry) => entry.id === healthy.id && entry.disconnected), 20000);
  } finally {
    await lonca.api('DELETE', `/terminals/${healthy.id}`).catch(() => {});
    sandboxExec(workspace.sandboxName, `kill -KILL -- -${damagedPid}; rm -f /var/tmp/lonca/tty/${damaged.id}.pid`);
  }
});

it.skipIf(REAL_SANDBOX)('does not report a successful script Stop while Docker Sandboxes is unreachable', async () => {
  const { pid } = await script();
  await lonca.kill();
  lonca.setOffline(true);
  await lonca.start();
  try {
    await expect(lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`)).rejects.toThrow();
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  } finally {
    lonca.setOffline(false);
    await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
  }
  expect(sandboxExec(workspace.sandboxName, `kill -0 -- -${pid}`).code).not.toBe(0);
});

it.skipIf(REAL_SANDBOX)('retains connected script controls when its disconnect probe cannot reach Docker Sandboxes', async () => {
  const { terminal, pid } = await script();
  lonca.setOffline(true);
  try {
    await until('disconnected script controls', async () => (await lonca.api<AppState>('GET', '/state')).terminals
      .some((entry) => entry.id === terminal.id && entry.status === 'running' && entry.disconnected));
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  } finally {
    lonca.setOffline(false);
  }
  await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
  expect(sandboxExec(workspace.sandboxName, `kill -0 -- -${pid}`).code).not.toBe(0);
});

async function agent(): Promise<{ session: Session; queued: UserItem; pid: string; runId: string }> {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Run until explicitly stopped', attachments: [] });
  const runId = (await lonca.session(session.id)).activeRunId!;
  const pid = await until('a running agent', () => {
    const result = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/agent-runs/${runId}/pid`);
    return result.code === 0 ? result.output : null;
  }, 15000);
  const queued = await lonca.api<UserItem>('POST', `/sessions/${session.id}/messages`, { text: 'Hold this follow-up', attachments: [] });
  return { session, queued, pid, runId };
}

it.skipIf(REAL_SANDBOX).each(['direct', 'queued'] as const)('does not launch a %s turn without saving its run ID and permits retry after recovery', async (mode) => {
  let session: Session;
  if (mode === 'queued') {
    ({ session } = await agent());
    await lonca.api('POST', `/sessions/${session.id}/interrupt`);
    await until('the queue to be held', async () => (await lonca.session(session.id)).status === 'idle');
    expect(await lonca.session(session.id)).toMatchObject({ held: true });
  } else session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  const file = path.join(lonca.home, 'state.json');
  const backup = `${file}.saved`;
  await until('the idle session snapshot', () => (JSON.parse(fs.readFileSync(file, 'utf8')) as AppState)
    .sessions.some((entry) => entry.id === session.id && entry.status === 'idle'));
  // Fail the real atomic rename without filling the host disk or blocking transcript writes.
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  try {
    const heartbeat = path.join(workspace.path, '.context/agent-heartbeat');
    const size = fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0;
    if (mode === 'queued') await expect(lonca.api('POST', `/sessions/${session.id}/queue/flush`)).rejects.toThrow(/500/);
    else await expect(lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Fail safely before launching', attachments: [] })).rejects.toThrow(/500.*could not be saved/);
    expect(await lonca.session(session.id)).toMatchObject({ status: 'idle', activeRunId: null });
    await sleep(500);
    expect(fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0).toBe(size);
  } finally {
    await lonca.kill();
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
    await lonca.start();
  }
  expect(await lonca.session(session.id)).toMatchObject({ status: 'idle', activeRunId: null });
  if (mode === 'queued') await lonca.api('POST', `/sessions/${session.id}/queue/flush`);
  else await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Retry once saving works', attachments: [] });
  const runId = (await lonca.session(session.id)).activeRunId!;
  await until('the retried agent', () => sandboxExec(workspace.sandboxName, `test -s /var/tmp/lonca/agent-runs/${runId}/pid`).code === 0);
  expect((JSON.parse(fs.readFileSync(file, 'utf8')) as AppState).sessions.find((entry) => entry.id === session.id)).toMatchObject({ activeRunId: runId });
  await lonca.api('POST', `/sessions/${session.id}/interrupt`);
  await until('the retried agent to stop', async () => (await lonca.session(session.id)).status === 'idle');
  await lonca.api('DELETE', `/sessions/${session.id}`);
});

it.skipIf(REAL_SANDBOX)('waits for the agent to stop before deleting its conversation and rejects new work while closing', async () => {
  const { session, queued, pid, runId } = await agent();
  const deleting = lonca.api('DELETE', `/sessions/${session.id}`);
  await until('the delete request to stop the agent', async () => {
    const current = (await lonca.api<AppState>('GET', '/state')).sessions.find((entry) => entry.id === session.id);
    return !current || current.stopRequested;
  });
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId, queue: [queued.id] });
  await expect(lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Too late', attachments: [] })).rejects.toThrow(/409.*closing/);
  await expect(lonca.api('POST', `/sessions/${session.id}/queue/flush`)).rejects.toThrow(/409.*closing/);
  await deleting;
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
  expect((await lonca.api<AppState>('GET', '/state')).sessions.some((entry) => entry.id === session.id)).toBe(false);
});

it.skipIf(REAL_SANDBOX)('keeps the agent and pending Stop durable when the server crashes during conversation deletion', async () => {
  const { session, queued, pid, runId } = await agent();
  const deleting = lonca.api('DELETE', `/sessions/${session.id}`).catch(() => {});
  await until('the delete request to stop the agent', async () => {
    const current = (await lonca.api<AppState>('GET', '/state')).sessions.find((entry) => entry.id === session.id);
    return !current || current.stopRequested;
  });
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId });
  const saved: AppState = JSON.parse(fs.readFileSync(path.join(lonca.home, 'state.json'), 'utf8'));
  expect(saved.sessions.find((entry) => entry.id === session.id)).toMatchObject({ activeRunId: runId, stopRequested: { holdQueue: true } });
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  await lonca.kill();
  await deleting;
  await lonca.start();
  await until('the saved Stop to finish after deletion was interrupted', async () => (await lonca.session(session.id)).status === 'idle', 20000);
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
  await lonca.api('DELETE', `/sessions/${session.id}`);
  expect((await lonca.api<AppState>('GET', '/state')).sessions.some((entry) => entry.id === session.id)).toBe(false);
});

it.skipIf(REAL_SANDBOX)('retains a conversation when its agent cannot be reached to finish deletion', async () => {
  const { session, queued, pid, runId } = await agent();
  lonca.setOffline(true);
  try {
    await expect(lonca.api('DELETE', `/sessions/${session.id}`)).rejects.toThrow(/409.*still stopping/);
    expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId, queue: [queued.id], stopRequested: { holdQueue: true } });
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  } finally {
    lonca.setOffline(false);
  }
  await until('the pending deletion Stop to finish', async () => (await lonca.session(session.id)).status === 'idle', 20000);
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
  await lonca.api('DELETE', `/sessions/${session.id}`);
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
});

it.skipIf(REAL_SANDBOX)('retains agent tracking through a prolonged outage and delivers Stop after reconnecting', async () => {
  const { session, queued, pid, runId } = await agent();
  lonca.setOffline(true);
  try {
    await lonca.api('POST', `/sessions/${session.id}/interrupt`);
    // Longer than the previous 30 failed checks, which incorrectly retired a live process.
    await sleep(70000);
    expect(await lonca.session(session.id)).toMatchObject({ status: 'running', activeRunId: runId, queue: [queued.id] });
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  } finally {
    lonca.setOffline(false);
  }
  await until('the pending Stop to finish', async () => (await lonca.session(session.id)).status === 'idle', 20000);
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
  await lonca.api('DELETE', `/sessions/${session.id}`);
});

it.skipIf(REAL_SANDBOX)('keeps an accepted agent Stop and its held queue across a server crash', async () => {
  const { session, queued, pid } = await agent();
  await lonca.api('POST', `/sessions/${session.id}/interrupt`);
  await lonca.kill();
  await lonca.start();
  await until('the saved Stop to finish', async () => (await lonca.session(session.id)).status === 'idle', 20000);
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
  expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
  await lonca.api('DELETE', `/sessions/${session.id}`);
});

it.skipIf(REAL_SANDBOX)('retries an interrupted workspace Stop without running scripts again', async () => {
  const { pid } = await script();
  const stopping = lonca.api('POST', `/workspaces/${workspace.id}/stop`).catch(() => {});
  await until('Stop intent to be saved', async () => (await lonca.workspace(workspace.id)).status === 'stopping');
  await lonca.kill();
  await stopping;
  await lonca.start();
  expect(await lonca.workspace(workspace.id)).toMatchObject({ status: 'error', pendingOperation: 'stop' });
  await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
  await lonca.waitForWorkspace(workspace.id, 'stopped');
  await lonca.api('POST', `/workspaces/${workspace.id}/start`);
  expect(sandboxExec(workspace.sandboxName, `kill -0 -- -${pid}`).code).not.toBe(0);
});

it.skipIf(REAL_SANDBOX)('holds queued work when Stop reached Docker but the server did not save completion', async () => {
  const { session, queued } = await agent();
  // beginOperation flushes the existing queue before stopping Docker. Establish that
  // same durable boundary before simulating the crash with a saved stopping status.
  const file = path.join(lonca.home, 'state.json');
  await until('the queue snapshot', () => (JSON.parse(fs.readFileSync(file, 'utf8')) as AppState)
    .sessions.find((entry) => entry.id === session.id)?.queue.includes(queued.id));
  await lonca.kill();
  sbx('stop', workspace.sandboxName);
  // Reproduce the persisted boundary before teardown, with the runtime already stopped.
  const saved: AppState = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = saved.workspaces.find((candidate) => candidate.id === workspace.id)!;
  entry.status = 'stopping';
  entry.pendingOperation = 'stop';
  fs.writeFileSync(file, JSON.stringify(saved));
  await lonca.start();
  await until('saved Stop to be recovered', async () => (await lonca.session(session.id)).stopRequested?.holdQueue);
  // Stopped is not proof that the output was read. Retry makes it readable,
  // saves the interrupted turn, and stops the runtime again before completing.
  expect(await lonca.session(session.id)).toMatchObject({ status: 'running', queue: [queued.id] });
  await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
  await lonca.waitForWorkspace(workspace.id, 'stopped');
  expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
  await lonca.api('POST', `/workspaces/${workspace.id}/start`);
  expect(await lonca.session(session.id)).toMatchObject({ status: 'idle', held: true, queue: [queued.id] });
  await lonca.api('DELETE', `/sessions/${session.id}`);
});

it.skipIf(REAL_SANDBOX)('holds queued work when an interrupted agent launch fails', async () => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  asRoot(workspace.sandboxName, `mv /usr/local/bin/lonca-run /usr/local/bin/lonca-run-original
cat > /usr/local/bin/lonca-run <<'LAUNCH'
#!/bin/bash
touch "$1/waiting"
for i in $(seq 1 100); do
  [ -e "$1/release" ] && break
  sleep 0.1
done
exit 1
LAUNCH
chmod +x /usr/local/bin/lonca-run`);
  try {
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Stop during startup', attachments: [] });
    const runId = (await lonca.session(session.id)).activeRunId!;
    await until('pending agent launch', () => sandboxExec(workspace.sandboxName, `test -e /var/tmp/lonca/agent-runs/${runId}/waiting`).code === 0);
    const queued = await lonca.api<UserItem>('POST', `/sessions/${session.id}/messages`, { text: 'Keep this queued', attachments: [] });
    await lonca.api('POST', `/sessions/${session.id}/interrupt`);
    expect(sandboxExec(workspace.sandboxName, `touch /var/tmp/lonca/agent-runs/${runId}/release`).code).toBe(0);
    await until('failed launch', async () => (await lonca.session(session.id)).status === 'idle');
    expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
    await lonca.api('DELETE', `/sessions/${session.id}`);
  } finally {
    asRoot(workspace.sandboxName, 'mv /usr/local/bin/lonca-run-original /usr/local/bin/lonca-run');
  }
});
