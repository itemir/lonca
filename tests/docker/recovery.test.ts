import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AppState, Project, ServerEvent, Session, UserItem, Workspace } from '../../shared/types.ts';
import { Lonca, docker, sandboxExec, makeFixtureRepo, removeSandbox, sleep, until, asRoot, FAKE_SBX_DIR, REAL_SANDBOX, git } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 48301, instance: 'recovery-test', firstWorkspacePort: 51000 });
let fixture: string;
let mock: MockLlm;
let project: Project;
let workspace: Workspace;
let first: Session;

beforeAll(async () => {
  fixture = makeFixtureRepo();
  mock = await startMockLlm();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, {
    settings: { network: 'host', filesToCopy: ['.env'], env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-ant-api03-recovery-not-a-real-key' } },
  });
  await lonca.api('PUT', '/profiles/claude/key', { key: 'sk-ant-api03-recovery-not-a-real-key' });
  const made = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(made.workspace.id);
  first = made.session;
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

it('queues messages during a rebuild and runs them in the replacement runtime', async () => {
  await lonca.api('POST', `/sessions/${first.id}/messages`, { text: 'SLOW first run before rebuild', attachments: [] });
  await until('the first model request', () => mock.requests.some((request) => request.path.endsWith('/messages')));
  const runId = (await lonca.session(first.id)).activeRunId;
  // Make teardown wait for its kill timeout so the next send definitely overlaps it.
  expect(sandboxExec(workspace.sandboxName, `kill -STOP -- -"$(head -c 16 /var/tmp/lonca/agent-runs/${runId}/pid)"`).code).toBe(0);
  const second = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  const rebuilding = lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
  try {
    await until('the rebuilding status', async () => (await lonca.workspace(workspace.id)).status === 'rebuilding', 10000);
    const message = await lonca.api<UserItem>('POST', `/sessions/${second.id}/messages`, {
      text: 'A message sent during rebuild', attachments: [],
    });
    expect(message.queued).toBe(true);
    expect((await lonca.session(second.id)).queue).toContain(message.id);
    expect((await lonca.session(second.id)).activeRunId).toBeNull();
    const followup = await lonca.api<UserItem>('POST', `/sessions/${first.id}/messages`, {
      text: 'Continue this conversation after rebuild', attachments: [],
    });
    expect(followup.queued).toBe(true);
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/terminals`)).rejects.toThrow(/409.*rebuilding/);
    await rebuilding;
    const items = await lonca.waitForIdle(second.id);
    expect(items.findLast((item) => item.type === 'result')).toMatchObject({ failed: false });
    expect(items.some((item) => item.type === 'text' && item.text.includes('A message sent during rebuild'))).toBe(true);
    const continued = await lonca.waitForIdle(first.id);
    const result = continued.findLast((item) => item.type === 'result');
    expect(result, JSON.stringify(continued)).toMatchObject({ failed: false });
    expect(result?.interrupted).not.toBe(true);
    const request = mock.requests.findLast((entry) => entry.path.endsWith('/messages') && entry.body.includes('You are the Lead'))!;
    const messages = JSON.parse(request.body).messages as { role: string; content: unknown }[];
    expect(JSON.stringify(messages.filter((entry) => entry.role === 'user').at(-1))).toContain('Continue this conversation after rebuild');
    expect((await lonca.workspace(workspace.id)).status).toBe('ready');
  } finally {
    await rebuilding;
  }
});

it.skipIf(REAL_SANDBOX)('retries a failed replacement without losing the checkout', async () => {
  fs.writeFileSync(path.join(workspace.path, 'keep.txt'), 'keep this work');
  const editedEnv = 'SECRET=workspace-specific-value\n';
  fs.writeFileSync(path.join(workspace.path, '.env'), editedEnv);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: 'lonca-missing-rebuild-test:never-built' } });
  try {
    await expect(lonca.api('POST', `/workspaces/${workspace.id}/recreate`)).rejects.toThrow();
    const failed = await lonca.workspace(workspace.id);
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('Could not rebuild the workspace');
    expect(fs.readFileSync(path.join(workspace.path, 'keep.txt'), 'utf8')).toBe('keep this work');
    // The retry must remember the failed operation across another server restart.
    const stateFile = path.join(lonca.home, 'state.json');
    await until('the rebuild failure to be saved', () => {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as AppState;
      return saved.workspaces.find((entry) => entry.id === workspace.id)?.status === 'error';
    });
    await lonca.kill();
    await lonca.start();
  } finally {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: '' } });
    await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
    await lonca.waitForWorkspace(workspace.id);
  }
  expect(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8')).toBe(editedEnv);
  expect(fs.readFileSync(path.join(workspace.path, 'keep.txt'), 'utf8')).toBe('keep this work');
});

it.skipIf(REAL_SANDBOX)('accepts concurrent sends that wake the same stopped workspace', async () => {
  const second = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  // Keep startup open long enough for all three requests to observe a stopped workspace.
  const slowStart = path.join(FAKE_SBX_DIR, 'slow-start');
  fs.writeFileSync(slowStart, '');
  try {
    await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
    const messages = await Promise.all([
      lonca.api<UserItem>('POST', `/sessions/${first.id}/messages`, { text: 'First wake request', attachments: [] }),
      lonca.api<UserItem>('POST', `/sessions/${first.id}/messages`, { text: 'Queued wake request', attachments: [] }),
      lonca.api<UserItem>('POST', `/sessions/${second.id}/messages`, { text: 'Another conversation waking', attachments: [] }),
    ]);
    expect(messages.every((message) => message.queued)).toBe(true);
    const items = (await Promise.all([lonca.waitForIdle(first.id), lonca.waitForIdle(second.id)])).flat();
    for (const message of messages) {
      expect(items.filter((item) => item.type === 'user' && item.id === message.id)).toHaveLength(1);
      expect(items.some((item) => item.type === 'text' && item.text.includes(message.text))).toBe(true);
    }
  } finally {
    fs.rmSync(slowStart);
  }
});

it('wakes a stopped workspace when sending its held queue', async () => {
  const before = mock.requests.length;
  await lonca.api('POST', `/sessions/${first.id}/messages`, { text: 'SLOW before stopping the workspace', attachments: [] });
  await until('the slow model request', () => mock.requests.slice(before).some((request) => request.path.endsWith('/messages')));
  const queued = await lonca.api<UserItem>('POST', `/sessions/${first.id}/messages`, {
    text: 'Send this held message after waking', attachments: [],
  });
  await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
  expect(await lonca.session(first.id)).toMatchObject({ status: 'idle', held: true, queue: [queued.id] });
  await lonca.api('POST', `/sessions/${first.id}/queue/flush`);
  expect((await lonca.workspace(workspace.id)).status).toBe('ready');
  const items = await lonca.waitForIdle(first.id);
  expect(items.some((item) => item.type === 'text' && item.text.includes(queued.text))).toBe(true);
  expect(items.findLast((item) => item.type === 'result')).toMatchObject({ failed: false });
});

it('accepts a queued message even when waking the workspace fails, then sends it once on retry', async () => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
  removeSandbox(workspace.sandboxName);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: 'lonca-missing-wake-test:never-built' } });
  let message!: UserItem;
  try {
    message = await lonca.api<UserItem>('POST', `/sessions/${session.id}/messages`, {
      text: 'Keep this message through a failed wake', attachments: [],
    });
    expect(message.queued).toBe(true);
    expect(await lonca.session(session.id)).toMatchObject({ status: 'idle', activeRunId: null, queue: [message.id] });
    expect((await lonca.workspace(workspace.id)).status).toBe('stopped');
    expect((await lonca.items(session.id)).some((item) => item.type === 'notice'
      && item.level === 'error' && item.text.includes('Your message is queued, but the workspace could not start'))).toBe(true);
  } finally {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: '' } });
    await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    workspace = await lonca.waitForWorkspace(workspace.id);
  }
  const items = await lonca.waitForIdle(session.id);
  expect(items.filter((item) => item.type === 'user' && item.id === message.id)).toHaveLength(1);
  expect(items.filter((item) => item.type === 'text' && item.text.includes(message.text))).toHaveLength(1);
  expect(items.filter((item) => item.type === 'result')).toHaveLength(1);
});

it.skipIf(REAL_SANDBOX).each(['streaming', 'starting'] as const)('does not recreate a deleted conversation while its agent is %s', async (phase) => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  const events: ServerEvent[] = [];
  const socket = new WebSocket(`ws://localhost:${lonca.port}/ws?token=${lonca.token}`, { headers: { origin: lonca.url } });
  socket.on('message', (data) => events.push(JSON.parse(data.toString())));
  const command = phase === 'streaming' ? 'claude' : 'lonca-run';
  const script = phase === 'streaming' ? `#!/bin/bash
trap '' TERM
cat >/dev/null
cat <<'JSONL'
{"type":"stream_event","event":{"type":"message_start","message":{"id":"delete-test"}}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Private answer that should be deleted"}}}
JSONL
while true; do sleep 0.2; done
` : `#!/bin/bash
touch "$1/launching"
while [ ! -f "$1/release" ]; do sleep 0.1; done
echo 'Simulated launch failure' >&2
exit 1
`;
  asRoot(workspace.sandboxName, `mv /usr/local/bin/${command} /usr/local/bin/${command}-delete-original
cat > /usr/local/bin/${command} <<'AGENT'
${script}AGENT
chmod +x /usr/local/bin/${command}`);
  try {
    await once(socket, 'open');
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Delete this conversation', attachments: [] });
    const runId = (await lonca.session(session.id)).activeRunId;
    const runDir = `/var/tmp/lonca/agent-runs/${runId}`;
    if (phase === 'streaming') {
      await until('streaming text', async () => (await lonca.items(session.id)).some((item) => item.type === 'text' && item.streaming && item.text.includes('Private answer')));
    } else {
      await until('the pending launch', () => sandboxExec(workspace.sandboxName, `test -f ${runDir}/launching`).code === 0);
    }
    const deleting = lonca.api('DELETE', `/sessions/${session.id}`);
    if (phase === 'starting') {
      await until('the pending launch to be interrupted', async () => (await lonca.session(session.id)).stopRequested);
      expect(sandboxExec(workspace.sandboxName, `touch ${runDir}/release`).code).toBe(0);
    }
    await deleting;
    const transcriptFile = path.join(lonca.home, 'sessions', `${session.id}.jsonl`);
    expect(fs.existsSync(transcriptFile)).toBe(false);
    await until('run files to be removed after stopping', () => sandboxExec(workspace.sandboxName, `test ! -d ${runDir}`).code === 0, 15000);
    await until('the conversation removal event', () => events.some((event) => event.type === 'session.removed' && event.id === session.id));
    await sleep(200);
    expect(fs.existsSync(transcriptFile)).toBe(false);
    expect((await lonca.api<AppState>('GET', '/state')).sessions.some((entry) => entry.id === session.id)).toBe(false);
    const removedAt = events.findIndex((event) => event.type === 'session.removed' && event.id === session.id);
    expect(events.slice(removedAt + 1).some((event) => (event.type === 'session' && event.session.id === session.id)
      || ('sessionId' in event && event.sessionId === session.id))).toBe(false);
  } finally {
    socket.close();
    asRoot(workspace.sandboxName, `mv /usr/local/bin/${command}-delete-original /usr/local/bin/${command}`);
  }
});

it.skipIf(REAL_SANDBOX)('keeps a surviving agent tracked when Stop arrives before reconnection', async () => {
  const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
  const heartbeat = path.join(workspace.path, '.context/reconnect-heartbeat');
  let pid: string | undefined;
  asRoot(workspace.sandboxName, `mv /usr/local/bin/claude /usr/local/bin/claude-reconnect-original
cat > /usr/local/bin/claude <<'AGENT'
#!/bin/bash
trap '' TERM
cat >/dev/null
while true; do echo heartbeat >> .context/reconnect-heartbeat; sleep 0.2; done
AGENT
chmod +x /usr/local/bin/claude`);
  try {
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Keep working across reconnection', attachments: [] });
    await until('the agent to write', () => fs.existsSync(heartbeat));
    const runId = (await lonca.session(session.id)).activeRunId;
    pid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/agent-runs/${runId}/pid`).output;
    await lonca.kill();
    // Keep the daemon and agent alive while preventing this server from reaching them.
    lonca.setOffline(true);
    await lonca.start();
    await expect(lonca.api('POST', `/sessions/${session.id}/interrupt`)).rejects.toThrow(/409.*reconnecting/);
    await expect(lonca.api('DELETE', `/sessions/${session.id}`)).rejects.toThrow(/409.*reconnecting/);
    expect(await lonca.session(session.id)).toMatchObject({ status: 'running', activeRunId: runId });
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);

    await lonca.kill();
    lonca.setOffline(false);
    await lonca.start();
    await until('the recovered agent to accept Stop', async () => {
      await lonca.api('POST', `/sessions/${session.id}/interrupt`);
      return true;
    }, 15000);
    const items = await lonca.waitForIdle(session.id, 15000);
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
    const size = fs.statSync(heartbeat).size;
    await sleep(500);
    expect(fs.statSync(heartbeat).size).toBe(size);
    expect(items.findLast((item) => item.type === 'result')).toMatchObject({ interrupted: true });
  } finally {
    if (pid) sandboxExec(workspace.sandboxName, `kill -KILL -- -${pid}`);
    asRoot(workspace.sandboxName, 'mv /usr/local/bin/claude-reconnect-original /usr/local/bin/claude');
    await lonca.kill();
    lonca.setOffline(false);
    await lonca.start();
    await lonca.waitForIdle(session.id, 15000);
    await lonca.api('DELETE', `/sessions/${session.id}`);
  }
});

it.skipIf(REAL_SANDBOX)('recovers the other workspaces when one can’t be reached after a restart', async () => {
  const other = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
  const fake = (name: string) => `mv /usr/local/bin/claude /usr/local/bin/claude-paused-original
cat > /usr/local/bin/claude <<'AGENT'
#!/bin/bash
cat >/dev/null
while true; do echo heartbeat >> .context/${name}; sleep 0.2; done
AGENT
chmod +x /usr/local/bin/claude`;
  const sessions: Session[] = [];
  let paused = false;
  try {
    for (const [target, name] of [[workspace, 'reachable'], [other, 'paused']] as const) {
      asRoot(target.sandboxName, fake(name));
      const session = await lonca.api<Session>('POST', `/workspaces/${target.id}/sessions`, {});
      sessions.push(session);
      await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Keep working', attachments: [] });
      await until('the agent to write', () => fs.existsSync(path.join(target.path, '.context', name)));
    }
    await lonca.kill();
    docker('pause', other.sandboxName);
    paused = true;
    await lonca.start();
    await until('sign-in to be checked', async () => (await lonca.api<AppState>('GET', '/state')).system.agentsChecked, 30000);
    await until('Stop to reach the reachable agent', async () => {
      await lonca.api('POST', `/sessions/${sessions[0].id}/interrupt`);
      return true;
    }, 15000);
    await lonca.waitForIdle(sessions[0].id, 15000);
    docker('unpause', other.sandboxName);
    paused = false;
    await until('Stop to reach the other agent once it can', async () => {
      await lonca.api('POST', `/sessions/${sessions[1].id}/interrupt`);
      return true;
    }, 30000);
    await lonca.waitForIdle(sessions[1].id, 15000);
  } finally {
    if (paused) docker('unpause', other.sandboxName);
    for (const target of [workspace, other]) asRoot(target.sandboxName, 'mv /usr/local/bin/claude-paused-original /usr/local/bin/claude 2>/dev/null; true');
    for (const session of sessions) await lonca.api('DELETE', `/sessions/${session.id}`).catch(() => {});
    await lonca.api('DELETE', `/workspaces/${other.id}`);
  }
});

it.skipIf(REAL_SANDBOX)('stops a surviving agent and replaces the runtime after a crash during rebuild teardown', async () => {
  const originalId = JSON.parse(docker('inspect', workspace.sandboxName))[0].Id;
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { memoryGb: 2, cpus: 1 } });
  // This agent ignores TERM, so recovery must retain tracking through the forced kill.
  asRoot(workspace.sandboxName, `mv /usr/local/bin/claude /usr/local/bin/claude-recovery-original
cat > /usr/local/bin/claude <<'AGENT'
#!/bin/bash
trap '' TERM
cat >/dev/null
while true; do echo heartbeat >> .context/rebuild-heartbeat; sleep 0.2; done
AGENT
chmod +x /usr/local/bin/claude`);
  try {
    await lonca.api('POST', `/sessions/${first.id}/messages`, { text: 'Work until interrupted', attachments: [] });
    const heartbeat = path.join(workspace.path, '.context/rebuild-heartbeat');
    await until('the agent to write', () => fs.existsSync(heartbeat));
    const runId = (await lonca.session(first.id)).activeRunId;
    const pid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/agent-runs/${runId}/pid`).output;
    const queued = await lonca.api<UserItem>('POST', `/sessions/${first.id}/messages`, {
      text: 'Continue after crash recovery', attachments: [],
    });
    const rebuilding = lonca.api('POST', `/workspaces/${workspace.id}/recreate`).catch(() => {});
    await until('rebuild teardown', async () => (await lonca.workspace(workspace.id)).status === 'rebuilding');
    await lonca.kill();
    await rebuilding;
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
    await lonca.start();
    await until('recovery to stop the agent', async () => (await lonca.session(first.id)).status === 'idle', 15000);
    expect((await lonca.workspace(workspace.id)).status).toBe('error');
    expect((await lonca.session(first.id)).activeRunId).toBeNull();
    expect((await lonca.session(first.id)).queue).toEqual([queued.id]);
    expect((await lonca.session(first.id)).held).not.toBe(true);
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
    const size = fs.statSync(heartbeat).size;
    await sleep(500);
    expect(fs.statSync(heartbeat).size).toBe(size);
    expect((await lonca.items(first.id)).findLast((item) => item.type === 'result')).toMatchObject({ interrupted: true });
  } finally {
    asRoot(workspace.sandboxName, 'mv /usr/local/bin/claude-recovery-original /usr/local/bin/claude');
    if ((await lonca.workspace(workspace.id)).status === 'error') {
      await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
      await lonca.waitForWorkspace(workspace.id);
    }
  }
  const items = await lonca.waitForIdle(first.id);
  const replaced = JSON.parse(docker('inspect', workspace.sandboxName))[0];
  expect(replaced.Id).not.toBe(originalId);
  expect(replaced.HostConfig.Memory).toBe(2 * 1024 ** 3);
  expect(replaced.HostConfig.NanoCpus).toBe(1_000_000_000);
  expect(items.some((item) => item.type === 'text' && item.text.includes('Continue after crash recovery'))).toBe(true);
  expect(items.findLast((item) => item.type === 'result')).toMatchObject({ failed: false });
});

it('cancels an in-flight import before deleting its files and never republishes the removed project', async () => {
  const events: ServerEvent[] = [];
  const socket = new WebSocket(`ws://localhost:${lonca.port}/ws?token=${lonca.token}`, { headers: { origin: lonca.url } });
  socket.on('message', (data) => events.push(JSON.parse(data.toString())));
  let response: http.ServerResponse | undefined;
  let closed = false;
  const remote = http.createServer((_req, res) => {
    response = res;
    res.on('close', () => { closed = true; });
  });
  try {
    await once(socket, 'open');
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const port = (remote.address() as { port: number }).port;
    const cloning = await lonca.api<Project>('POST', '/projects', { url: `http://127.0.0.1:${port}/pending.git` });
    await until('Git to request the remote', () => response, 10000);
    await lonca.api('DELETE', `/projects/${cloning.id}`);
    await until('Git to close its remote request', () => closed, 5000);
    await until('the removal event', () => events.some((event) => event.type === 'project.removed' && event.id === cloning.id));
    response!.writeHead(404);
    response!.end('not found');
    await sleep(200);

    const removedAt = events.findIndex((event) => event.type === 'project.removed' && event.id === cloning.id);
    expect(events.slice(removedAt + 1).some((event) => event.type === 'project' && event.project.id === cloning.id)).toBe(false);
    expect((await lonca.api<AppState>('GET', '/state')).projects.some((entry) => entry.id === cloning.id)).toBe(false);
    expect(fs.existsSync(path.join(lonca.home, 'projects', cloning.slug))).toBe(false);
  } finally {
    response?.destroy();
    socket.close();
    remote.closeAllConnections();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  }
});
