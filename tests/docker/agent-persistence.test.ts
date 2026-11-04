import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppState, Session, UserItem, Workspace } from '../../shared/types.ts';
import { IN_SANDBOX, Lonca, docker, dockerExec, makeFixtureRepo, until } from '../support/harness.ts';

describe.skipIf(IN_SANDBOX)('agent supervision through failed Stop persistence', () => {
  let lonca: Lonca;
  let fixture: string;
  let workspace: Workspace;
  let offline = false;
  const sockets = new Set<net.Socket>();
  const endpoint = process.env.DOCKER_HOST || docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
  const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
    if (offline) { client.destroy(); return; }
    const target = endpoint.startsWith('unix://') ? net.connect({ path: endpoint.slice(7), allowHalfOpen: true })
      : net.connect({ port: Number(new URL(endpoint).port), host: new URL(endpoint).hostname, allowHalfOpen: true });
    for (const socket of [client, target]) {
      sockets.add(socket);
      socket.on('error', () => { client.destroy(); target.destroy(); });
      socket.on('close', () => sockets.delete(socket));
    }
    client.pipe(target).pipe(client);
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  beforeEach(async () => {
    fixture = makeFixtureRepo();
    lonca = new Lonca({ port: 48313, instance: 'agent-persistence', firstWorkspacePort: 52000 });
    lonca.env.DOCKER_HOST = `tcp://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    docker('exec', workspace.containerName, 'bash', '-c', `mv /usr/local/bin/claude /usr/local/bin/claude-original
cat > /usr/local/bin/claude <<'AGENT'
#!/bin/bash
trap 'touch .context/agent-term' TERM
trap '' HUP
cat >/dev/null
touch .context/agent-ready
while true; do echo tick >> .context/agent-heartbeat; sleep 0.1; done
AGENT
chmod +x /usr/local/bin/claude`);
  });
  afterEach(async () => {
    offline = false;
    await lonca.destroy();
    for (const socket of sockets) socket.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function failStateWrites(): () => void {
    const file = path.join(lonca.home, 'state.json');
    const backup = `${file}.saved`;
    // Fail the real atomic rename while keeping the saved snapshot and transcripts intact.
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    let restored = false;
    return () => {
      if (restored) return;
      fs.rmdirSync(file);
      fs.renameSync(backup, file);
      restored = true;
    };
  }

  it('stops the agent when Stop is pressed while state can’t be saved', async () => {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Run until stopped', attachments: [] });
    await until('the agent to be ready', () => fs.existsSync(path.join(workspace.path, '.context/agent-ready')), 15000);
    const runId = (await lonca.session(session.id)).activeRunId;
    const pid = dockerExec(workspace.containerName, `cat /var/tmp/lonca/agent-runs/${runId}/pid`).output;
    const restoreWrites = failStateWrites();
    try {
      // An agent filling the disk is exactly when this happens.
      await expect(lonca.api('POST', `/sessions/${session.id}/interrupt`)).rejects.toThrow(/500.*stopping/);
      await until('TERM delivery', () => fs.existsSync(path.join(workspace.path, '.context/agent-term')), 3000);
      // This agent ignores TERM, so the grace period ends with KILL.
      await until('the agent process to stop', () => dockerExec(workspace.containerName, `kill -0 ${pid}`).code !== 0, 15000);
      // Completion retains recovery tracking until the state store can record it.
      expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId, status: 'running' });
    } finally {
      restoreWrites();
    }
    await until('completion to be saved', async () => (await lonca.session(session.id)).status === 'idle', 15000);
    await lonca.api('DELETE', `/sessions/${session.id}`);
  });

  it.each(['recovery', 'uncertain startup'] as const)('finishes %s and holds queued work after the state store recovers', async (mode) => {
    if (mode === 'uncertain startup') {
      // Start a real detached process, but make confirming its launch fail on demand.
      docker('exec', workspace.containerName, 'bash', '-c', `mv /usr/local/bin/lonca-run /usr/local/bin/lonca-run-original
cat > /usr/local/bin/lonca-run <<'LAUNCH'
#!/bin/bash
/usr/local/bin/lonca-run-original "$@" || exit $?
touch "$1/waiting"
for i in $(seq 1 150); do
  [ -e "$1/release" ] && break
  sleep 0.1
done
echo 'Injected launch confirmation failure' >&2
exit 42
LAUNCH
chmod +x /usr/local/bin/lonca-run`);
    }
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Run until stopped', attachments: [] });
    const runId = (await lonca.session(session.id)).activeRunId!;
    const dir = `/var/tmp/lonca/agent-runs/${runId}`;
    await until('the agent to be ready', () => fs.existsSync(path.join(workspace.path, '.context/agent-ready')), 15000);
    const pid = dockerExec(workspace.containerName, `cat ${dir}/pid`).output;
    const queued = await lonca.api<UserItem>('POST', `/sessions/${session.id}/messages`, { text: 'Keep this queued', attachments: [] });
    if (mode === 'recovery') {
      const stopping = lonca.api('POST', `/workspaces/${workspace.id}/stop`).catch(() => {});
      await until('the durable Stop request', async () => (await lonca.session(session.id)).stopRequested);
      await lonca.kill();
      await stopping;
      // Allow the saved state to load, then fail writes before Docker recovery can run.
      offline = true;
      for (const socket of sockets) socket.destroy();
      await lonca.start();
      fs.rmSync(path.join(workspace.path, '.context/agent-term'), { force: true });
    } else {
      await until('launch confirmation to wait', () => dockerExec(workspace.containerName, `test -e ${dir}/waiting`).code === 0);
    }

    const restoreWrites = failStateWrites();
    const logStart = lonca.log.length;
    try {
      if (mode === 'recovery') offline = false;
      else expect(dockerExec(workspace.containerName, `touch ${dir}/release`).code).toBe(0);
      const failure = mode === 'recovery' ? 'could not check on running workspaces:' : 'could not start a turn:';
      await until('Stop persistence to fail', () => lonca.log.slice(logStart).includes(failure), 15000);
      expect(lonca.log.slice(logStart)).toContain('EISDIR');
      // Saving failure must not skip either the Stop grace period or the output follower.
      await until('TERM delivery', () => fs.existsSync(path.join(workspace.path, '.context/agent-term')), 2000);
      expect(dockerExec(workspace.containerName, `kill -0 ${pid}`).code).toBe(0);
      expect(await lonca.session(session.id)).toMatchObject({ activeRunId: runId, status: 'running' });
      restoreWrites();
      await until('the interrupted agent to finish', async () => (await lonca.session(session.id)).status === 'idle', 15000);
      expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
      expect(dockerExec(workspace.containerName, `kill -0 ${pid}`).code).not.toBe(0);
      const saved: AppState = JSON.parse(fs.readFileSync(path.join(lonca.home, 'state.json'), 'utf8'));
      expect(saved.sessions.find((entry) => entry.id === session.id)).toMatchObject({ activeRunId: null, held: true, queue: [queued.id] });
      if (mode === 'recovery') {
        await lonca.api('POST', `/workspaces/${workspace.id}/retry`);
        await lonca.waitForWorkspace(workspace.id, 'stopped');
      }
      // The same server can finish lifecycle operations once the actual process is gone.
      await lonca.api('DELETE', `/sessions/${session.id}`);
      expect((await lonca.api<AppState>('GET', '/state')).sessions.some((entry) => entry.id === session.id)).toBe(false);
    } finally {
      offline = false;
      restoreWrites();
    }
  });
});
