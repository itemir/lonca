import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentProcessCommand } from '../../server/agents/process.ts';
import type { Session, Workspace } from '../../shared/types.ts';
import { FAKE_SANDBOX, REAL_SANDBOX, RUNTIME, Lonca, asRoot, docker, sandboxExec, makeFixtureRepo, sbx, sleep, until } from '../support/harness.ts';

const currentLauncher = fs.readFileSync(new URL('../../template/lonca-run', import.meta.url), 'utf8');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (...args: Parameters<typeof agentProcessCommand>) => agentProcessCommand(...args).map(quote).join(' ');

describe('agent process identity', () => {
  const lonca = new Lonca({ port: REAL_SANDBOX ? 48335 : 48325, instance: `agent-identity-${RUNTIME}`, firstWorkspacePort: REAL_SANDBOX ? 54100 : 53100});
  const fixture = makeFixtureRepo();
  let workspace: Workspace;
  let claudePath: string;
  const directRuns: { dir: string; pid: string }[] = [];
  let serial = 0;

  function writeScript(file: string, body: string): void {
    asRoot(workspace.sandboxName, `printf %s ${quote(body)} > ${quote(file)}\nchmod +x ${quote(file)}`);
  }

  beforeAll(async () => {
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    claudePath = sandboxExec(workspace.sandboxName, 'command -v claude').output;
    expect(claudePath).toMatch(/^\//);
  });

  beforeEach(() => {
    writeScript('/usr/local/bin/lonca-run', currentLauncher);
    writeScript(claudePath, `#!/bin/bash
cat >/dev/null
touch .context/identity-agent-started
trap '' TERM HUP
while true; do echo tick >> .context/identity-heartbeat; sleep 0.1; done
`);
    for (const file of ['identity-agent-started', 'identity-heartbeat']) {
      fs.rmSync(path.join(workspace.path, '.context', file), { force: true });
    }
  });

  afterEach(async () => {
    for (const { dir, pid } of directRuns.splice(0)) {
      // These are only processes created by this test, including intentionally
      // stale records that the production signal path must refuse to trust.
      sandboxExec(workspace.sandboxName, `kill -KILL -- -${pid} 2>/dev/null; rm -rf ${quote(dir)}`);
    }
    const sessions = (await lonca.api('GET', '/state')).sessions as Session[];
    for (const session of sessions.filter((entry) => entry.activeRunId)) {
      await until('the run to be supervised', async () => {
        await lonca.api('POST', `/sessions/${session.id}/interrupt`);
        return true;
      }, 15000);
      await lonca.waitForIdle(session.id);
    }
  });

  afterAll(async () => {
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  async function startAgent(): Promise<{ session: Session; dir: string; pid: string }> {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Run until stopped', attachments: [] });
    await until('the agent to execute', () => fs.existsSync(path.join(workspace.path, '.context/identity-agent-started')), 15000);
    const dir = `/var/tmp/lonca/agent-runs/${(await lonca.session(session.id)).activeRunId}`;
    const pid = sandboxExec(workspace.sandboxName, `cat ${dir}/pid`).output;
    expect(sandboxExec(workspace.sandboxName, command('status', dir))).toMatchObject({ code: 0, output: 'alive' });
    return { session, dir, pid };
  }

  it.each(['checkout', 'PYTHONPATH'] as const)('isolates process helpers from modules in the %s throughout a run', async (source) => {
    const pythonPath = path.join(workspace.path, '.context', 'python-path');
    const modules = source === 'checkout' ? workspace.path : pythonPath;
    fs.mkdirSync(pythonPath, { recursive: true });
    const files = ['json.py', 'signal.py'].map((name) => path.join(modules, name));
    for (const file of files) fs.writeFileSync(file, 'PROJECT_DATA = {}\n');
    const event = (text: string) => JSON.stringify({
      type: 'assistant', message: { id: text, content: [{ type: 'text', text }] },
    });
    writeScript(claudePath, `#!/bin/bash
cat >/dev/null
printf %s "$PYTHONPATH" > .context/agent-pythonpath
pwd > .context/agent-workdir
printf '%s\\n' ${quote(event('imports-isolated'))}
touch .context/identity-agent-started
trap '' TERM HUP
while true; do sleep 0.1; done
`);
    try {
      await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { env: { PYTHONPATH: pythonPath } } });
      for (const recover of [false, true]) {
        fs.rmSync(path.join(workspace.path, '.context/identity-agent-started'), { force: true });
        const { session, dir, pid } = await startAgent();
        // Isolating the helper must leave the agent's own Python configuration and cwd intact.
        expect(fs.readFileSync(path.join(workspace.path, '.context/agent-pythonpath'), 'utf8')).toBe(pythonPath);
        expect(fs.readFileSync(path.join(workspace.path, '.context/agent-workdir'), 'utf8').trim()).toBe(workspace.path);
        const text = recover ? 'output-written-while-offline' : 'imports-isolated';
        if (recover) {
          await lonca.stop();
          expect(sandboxExec(workspace.sandboxName, `printf '%s\\n' ${quote(event(text))} >> ${quote(`${dir}/out.jsonl`)}`).code).toBe(0);
          await lonca.start();
        }
        await until('the agent output to be followed', async () => (await lonca.items(session.id))
          .some((item) => item.type === 'text' && item.text === text), 15000);
        await lonca.api('POST', `/sessions/${session.id}/interrupt`);
        await lonca.waitForIdle(session.id, 15000);
        expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
        expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null, status: 'idle' });
        expect((await lonca.items(session.id)).find((item) => item.type === 'result')).toMatchObject({ interrupted: true });
      }
    } finally {
      for (const file of files) fs.rmSync(file, { force: true });
      await lonca.api('PATCH', `/projects/${workspace.projectId}`, { settings: { env: {} } });
    }
  });

  it('does not execute the CLI after a failed PID write', async () => {
    writeScript('/usr/local/bin/test-lonca-run', currentLauncher);
    writeScript('/usr/local/bin/lonca-run', '#!/bin/bash\nln -s /dev/full "$1/pid"\nexec /usr/local/bin/test-lonca-run "$@"\n');
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Must not execute', attachments: [] });
    await until('the failed launch to finish', async () => (await lonca.session(session.id)).status === 'idle', 25000);
    expect(await lonca.session(session.id)).toMatchObject({ activeRunId: null });
    expect((await lonca.items(session.id)).some((item) => item.type === 'notice' && item.level === 'error')).toBe(true);
    await lonca.api('POST', `/sessions/${session.id}/interrupt`);
    await lonca.stop();
    await lonca.start();
    expect(fs.existsSync(path.join(workspace.path, '.context/identity-agent-started'))).toBe(false);
  });

  it('does not adopt or signal a foreign process named by a PID record', () => {
    const dir = `/var/tmp/lonca/agent-runs/identity-test-${++serial}`;
    const result = sandboxExec(workspace.sandboxName, `mkdir -p ${dir}\necho replay-this-output > ${dir}/out.jsonl\nsetsid sleep 600 </dev/null >/dev/null 2>&1 &\necho $! > ${dir}/pid\ncat ${dir}/pid`);
    expect(result.code).toBe(0);
    const pid = result.output;
    directRuns.push({ dir, pid });
    expect(sandboxExec(workspace.sandboxName, command('status', dir))).toMatchObject({ code: 0, output: 'dead' });
    expect(sandboxExec(workspace.sandboxName, `timeout 5 ${command('follow', dir, '0')}`)).toMatchObject({ code: 0, output: 'replay-this-output' });
    for (const signal of ['TERM', 'KILL']) expect(sandboxExec(workspace.sandboxName, command('signal', dir, signal)).code).toBe(0);
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
  });

  it('replays a nonzero exit completed while the server was down', async () => {
    const { session, dir } = await startAgent();
    await lonca.stop();
    expect(sandboxExec(workspace.sandboxName, command('signal', dir, 'KILL')).code).toBe(0);
    // Preserve completed output and a nonzero result, as lonca-run normally does.
    expect(sandboxExec(workspace.sandboxName, `echo 17 > ${dir}/exit\necho saved-error > ${dir}/err.log`).code).toBe(0);
    await lonca.start();
    await lonca.waitForIdle(session.id);
    expect((await lonca.items(session.id)).find((item) => item.type === 'notice' && item.level === 'error')).toMatchObject({ text: 'saved-error' });
    expect((await lonca.items(session.id)).find((item) => item.type === 'result')).toMatchObject({ failed: true });
  });

  it('records a normal nonzero CLI exit', async () => {
    writeScript(claudePath, '#!/bin/bash\ncat >/dev/null\necho cli-failed >&2\nexit 17\n');
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'Fail normally', attachments: [] });
    await lonca.waitForIdle(session.id);
    expect((await lonca.items(session.id)).find((item) => item.type === 'notice' && item.level === 'error')).toMatchObject({ text: 'cli-failed' });
    expect((await lonca.items(session.id)).find((item) => item.type === 'result')).toMatchObject({ failed: true });
  });

  it.skipIf(!FAKE_SANDBOX)('handles a reboot and naturally reused PID', async () => {
    const { session, dir, pid } = await startAgent();
    // Also exercise the saved Stop that recovery must deliver after reconnecting.
    await lonca.api('POST', `/sessions/${session.id}/interrupt`);
    await lonca.kill();
    // The run directory outlives the boot, so recovery has to tell its PID from a new process reusing it.
    docker('restart', '-t', '1', workspace.sandboxName);
    const replacement = docker('exec', '--user', 'agent', workspace.sandboxName, 'python3', '-c', `
import os, signal, sys, time
target = int(sys.argv[1])
while True:
    pid = os.fork()
    if pid == 0:
        os.setsid()
        time.sleep(600)
        os._exit(0)
    if pid == target:
        print(pid, flush=True)
        break
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    if pid > target:
        raise RuntimeError('passed the target PID')
`, pid);
    expect(replacement).toBe(pid);
    directRuns.push({ dir, pid });
    await lonca.start();
    await lonca.waitForIdle(session.id);
    await lonca.api('POST', `/sessions/${session.id}/interrupt`);
    await sleep(4500); // Include a possible delayed KILL from Stop.
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
    expect(await lonca.session(session.id)).toMatchObject({ status: 'idle', activeRunId: null });
  });

  it.skipIf(!REAL_SANDBOX)('rejects run records retained across a real VM reboot', async () => {
    const { session, dir } = await startAgent();
    const boot = sandboxExec(workspace.sandboxName, 'cat /proc/sys/kernel/random/boot_id').output;
    await lonca.kill();
    sbx('stop', workspace.sandboxName);
    sbx('exec', '--user', 'agent', workspace.sandboxName, '--', 'true');
    expect(sandboxExec(workspace.sandboxName, `cat ${dir}/pid`).code).toBe(0);
    expect(sandboxExec(workspace.sandboxName, 'cat /proc/sys/kernel/random/boot_id').output).not.toBe(boot);
    await lonca.start();
    await lonca.waitForIdle(session.id);
    expect(await lonca.session(session.id)).toMatchObject({ status: 'idle', activeRunId: null });
  });
});
