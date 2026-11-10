import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Session, Workspace } from '../../shared/types.ts';
import { RUNTIME, Lonca, asRoot, sandboxExec, makeFixtureRepo, removeSandbox, sandboxRunning, sbx, sleep, until } from '../support/harness.ts';
import { SANDBOX_BOOT } from '../../server/sandbox.ts';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const expected = Array.from({ length: 1010 }, (_, i) => `answer café 🐈 ${i}`);

describe('agent output completion', () => {
  const lonca = new Lonca({ port: 48328, instance: `agent-output-${RUNTIME}`, firstWorkspacePort: 54500});
  const fixture = makeFixtureRepo();
  const control = path.join(lonca.home, 'output-fault.json');
  const faults = path.join(lonca.home, 'output-faults.jsonl');
  let workspace: Workspace;
  const marker = (name: string) => path.join(workspace.path, '.context', `output-${name}`);
  const textItems = async (id: string) => (await lonca.items(id)).filter((item) => item.type === 'text');
  const started = () => fs.readFileSync(marker('started'), 'utf8').trim().split('\n');
  const fault = (kind: string, once = false) => fs.writeFileSync(control, JSON.stringify({ kind, once }));

  beforeAll(async () => {
    lonca.env.NODE_OPTIONS = `--import=${fileURLToPath(new URL('../support/agent-output-fault.mjs', import.meta.url))}`;
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
  });

  function installCli() {
    const cli = sandboxExec(workspace.sandboxName, 'command -v claude').output;
    const script = `#!/usr/bin/python3
import json, os, sys, time
prompt = json.loads(sys.stdin.readline())['message']['content'].strip()
with open('.context/output-started', 'a') as stream:
    stream.write(prompt + '\\n')
def answer(i, text=None):
    return json.dumps({'type': 'assistant', 'message': {'id': str(i), 'content': [{'type': 'text', 'text': text or ('answer café 🐈 ' + str(i))}]}}, ensure_ascii=False)
for i in range(10):
    print(answer(i), flush=True)
while not os.path.exists('.context/output-release'):
    time.sleep(0.05)
if prompt == 'large':
    print(answer('large', 'café 🐈 ' * 30000), flush=True)
for i in range(10, 1010):
    print(answer(i), flush=True)
if prompt == 'fail':
    print('saved CLI failure', file=sys.stderr)
    sys.exit(17)
sys.stdout.write(json.dumps({'type': 'result', 'is_error': False}) + ('' if prompt == 'unterminated' else '\\n'))
sys.stdout.flush()
`;
    asRoot(workspace.sandboxName, `printf %s ${quote(script)} > ${quote(cli)}\nchmod +x ${quote(cli)}`);
  }

  beforeEach(async () => {
    const current = await lonca.workspace(workspace.id);
    if (current.status === 'archived') await lonca.api('POST', `/workspaces/${workspace.id}/restore`);
    else if (current.status === 'stopped') await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    await lonca.waitForWorkspace(workspace.id);
    installCli();
    for (const file of [control, faults, marker('release'), marker('started')]) fs.rmSync(file, { force: true });
  });
  afterEach(async () => {
    fs.rmSync(control, { force: true });
    if (fs.existsSync(path.dirname(marker('release')))) fs.writeFileSync(marker('release'), 'finish');
    const sessions = (await lonca.api('GET', '/state')).sessions as Session[];
    if ((await lonca.workspace(workspace.id)).status === 'stopped' && sessions.some((session) => session.activeRunId)) {
      await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    }
    for (const session of sessions) {
      await lonca.waitForIdle(session.id);
      await lonca.api('DELETE', `/sessions/${session.id}`);
    }
  });
  afterAll(async () => {
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  async function begin(prompt = 'normal') {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: prompt });
    await until('ten saved answers', async () => (await textItems(session.id)).length === 10
      && fs.readFileSync(path.join(lonca.home, 'sessions', `${session.id}.jsonl`), 'utf8').includes('answer café 🐈 9'));
    return { session, runId: (await lonca.session(session.id)).activeRunId!, initial: await textItems(session.id) };
  }

  async function completeOffline(runId: string) {
    await lonca.kill();
    fs.writeFileSync(marker('release'), 'finish');
    await until('offline completion', () => sandboxExec(workspace.sandboxName, `test -f /var/tmp/lonca/agent-runs/${runId}/exit`).code === 0);
  }

  async function expectSaved(id: string, wanted = expected) {
    await lonca.waitForIdle(id);
    const items = await lonca.items(id);
    expect(items.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(wanted);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.find((item) => item.type === 'result')).toMatchObject({ failed: false });
    await lonca.kill();
    await lonca.start();
    expect(await lonca.items(id)).toEqual(items);
  }

  it.each(['attach', 'cut'] as const)('retries a failed %s when replaying a completed run', async (kind) => {
    const { session, runId, initial } = await begin();
    await completeOffline(runId);
    fault(kind);
    await lonca.start();
    await until('the failed read', () => fs.existsSync(faults));
    expect(await lonca.session(session.id)).toMatchObject({ status: 'running', activeRunId: runId });
    expect((await textItems(session.id)).map((item) => item.text)).toEqual(expect.arrayContaining(initial.map((item) => item.text)));
    expect(sandboxExec(workspace.sandboxName, `test -s /var/tmp/lonca/agent-runs/${runId}/out.jsonl`).code).toBe(0);
    // A second crash during the failed replay must keep the old answers too.
    await lonca.kill();
    fs.rmSync(control);
    await lonca.start();
    await expectSaved(session.id);
  });

  it.each(['normal', 'large'] as const)('resumes a disconnected live stream with %s records', async (prompt) => {
    const { session } = await begin(prompt);
    fault('cut', true);
    fs.writeFileSync(marker('release'), 'finish');
    await until('the disconnected stream', () => fs.existsSync(faults));
    const wanted = prompt === 'large' ? [...expected.slice(0, 10), 'café 🐈 '.repeat(30000), ...expected.slice(10)] : expected;
    await expectSaved(session.id, wanted);
  });

  it.each(['no-receipt', 'wrong-length', 'no-output'] as const)('keeps recovery data and follow-ups waiting with %s', async (kind) => {
    const { session, runId } = await begin();
    const queued = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'follow-up' });
    await completeOffline(runId);
    fault(kind);
    await lonca.start();
    await until('the failed receipt to be retried', () => fs.existsSync(faults) && fs.readFileSync(faults, 'utf8').trim().split('\n').length >= 2);
    expect(await lonca.session(session.id)).toMatchObject({ status: 'running', activeRunId: runId, queue: [queued.id] });
    expect(started()).toEqual(['normal']);
    expect(sandboxExec(workspace.sandboxName, `test -s /var/tmp/lonca/agent-runs/${runId}/out.jsonl`).code).toBe(0);
    fs.rmSync(control);
    await lonca.waitForIdle(session.id);
    expect(started()).toEqual(['normal', 'follow-up']);
    expect((await textItems(session.id)).map((item) => item.text)).toEqual([...expected, ...expected]);
  });

  it('accepts the last complete JSON record without a trailing newline', async () => {
    const { session } = await begin('unterminated');
    fs.writeFileSync(marker('release'), 'finish');
    await expectSaved(session.id);
  });

  it('retains a nonzero exit and its error text through a lost receipt', async () => {
    const { session, runId } = await begin('fail');
    await completeOffline(runId);
    fault('no-receipt', true);
    await lonca.start();
    await lonca.waitForIdle(session.id);
    const items = await lonca.items(session.id);
    expect(items.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(expected);
    expect(items.find((item) => item.type === 'notice' && item.level === 'error')).toMatchObject({ text: 'saved CLI failure' });
    expect(items.find((item) => item.type === 'result')).toMatchObject({ failed: true });
  });

  it.each(['missing', 'FIFO', 'directory'] as const)('keeps saved answers when completed raw output is %s', async (damage) => {
    const { session, runId } = await begin();
    await completeOffline(runId);
    const file = `/var/tmp/lonca/agent-runs/${runId}/out.jsonl`;
    const replace = damage === 'FIFO' ? `mkfifo ${file}` : damage === 'directory' ? `mkdir ${file}` : 'true';
    expect(sandboxExec(workspace.sandboxName, `rm ${file}\n${replace}`).code).toBe(0);
    await lonca.start();
    await lonca.waitForIdle(session.id);
    const items = await lonca.items(session.id);
    expect(items.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(expected.slice(0, 10));
    expect(items.find((item) => item.type === 'notice')).toMatchObject({ level: 'warning' });
    expect(items.find((item) => item.type === 'result')).toMatchObject({ interrupted: true });
    await lonca.kill();
    await lonca.start();
    expect(await lonca.items(session.id)).toEqual(items);
  });

  it.each(['normal', 'fail'] as const)('reads a completed %s run after losing its launch acknowledgment', async (prompt) => {
    fs.writeFileSync(marker('release'), 'finish');
    fault('launch', true);
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: prompt });
    const runId = (await lonca.session(session.id)).activeRunId!;
    await until('launch failure', () => fs.existsSync(faults));
    await lonca.waitForIdle(session.id);
    const items = await lonca.items(session.id);
    expect(items.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(expected);
    expect(items.find((item) => item.type === 'result')).toMatchObject({ failed: prompt === 'fail' });
    if (prompt === 'fail') expect(items.find((item) => item.type === 'notice' && item.text === 'saved CLI failure')).toBeDefined();
    await until('saved output cleanup', () => sandboxExec(workspace.sandboxName, `test ! -d /var/tmp/lonca/agent-runs/${runId}`).code === 0);
    await lonca.kill();
    await lonca.start();
    expect(await lonca.items(session.id)).toEqual(items);
  });

  it('finishes a rejected launch that never created output', async () => {
    fault('launch-before', true);
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'rejected' });
    await until('rejected launch', () => fs.existsSync(faults));
    await lonca.waitForIdle(session.id);
    expect(fs.existsSync(marker('started'))).toBe(false);
    expect(await textItems(session.id)).toEqual([]);
    expect((await lonca.items(session.id)).some((item) => item.type === 'notice' && item.level === 'error')).toBe(true);
  });

  function stopRuntime() {
    // A fake sandbox shares its host kernel's boot ID. Force the boot hook to
    // exercise the same path as a VM with a genuinely new boot ID.
    expect(sandboxExec(workspace.sandboxName, 'rm -f /var/tmp/lonca/boot').code).toBe(0);
    sbx('stop', workspace.sandboxName);
  }

  function restartRuntime() {
    sbx('run', '--detach', '--name', workspace.sandboxName);
    expect(sandboxExec(workspace.sandboxName, `bash -c ${quote(SANDBOX_BOOT)} lonca-boot ${quote(path.join(lonca.home, 'agent-state', workspace.id))}`).code).toBe(0);
  }

  it.each(['start', 'restart before recovery'] as const)('recovers offline output and then queued work after %s', async (action) => {
    const { session, runId } = await begin();
    const queued = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'follow-up' });
    await completeOffline(runId);
    stopRuntime();
    if (action === 'restart before recovery') restartRuntime();
    await lonca.start();
    if (action === 'start') {
      await lonca.waitForWorkspace(workspace.id, 'stopped');
      await until('waiting for retained output', async () => (await lonca.items(session.id)).some((item) => item.type === 'notice' && item.text.includes('Start it to recover')));
      expect(await lonca.session(session.id)).toMatchObject({ status: 'running', activeRunId: runId, queue: [queued.id] });
      // Another server restart while the runtime is stopped must retain it too.
      await lonca.kill();
      await lonca.start();
      await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    }
    await expectSaved(session.id, [...expected, ...expected]);
    expect(started()).toEqual(['normal', 'follow-up']);
  });

  it('keeps tracking unread output when the runtime stops during live following', async () => {
    const { session, runId } = await begin();
    // Lose the current attachment, then keep the subsequent attachment failing
    // until the completed run's runtime has stopped.
    fault('cut', true);
    fs.writeFileSync(marker('release'), 'finish');
    await until('cut attachment', () => fs.existsSync(faults));
    fault('attach');
    await until('completed CLI', () => sandboxExec(workspace.sandboxName, `test -f /var/tmp/lonca/agent-runs/${runId}/exit`).code === 0);
    stopRuntime();
    await lonca.waitForWorkspace(workspace.id, 'stopped');
    expect(await lonca.session(session.id)).toMatchObject({ status: 'running', activeRunId: runId });
    fs.rmSync(control, { force: true });
    await lonca.api('POST', `/workspaces/${workspace.id}/start`);
    await expectSaved(session.id);
  });

  it.each(['rebuild', 'archive'] as const)('saves unread stopped-runtime output before %s', async (action) => {
    const { session, runId } = await begin();
    await completeOffline(runId);
    stopRuntime();
    await lonca.start();
    await lonca.waitForWorkspace(workspace.id, 'stopped');
    await lonca.api('POST', `/workspaces/${workspace.id}/${action === 'rebuild' ? 'recreate' : action}`);
    await lonca.waitForWorkspace(workspace.id, action === 'archive' ? 'archived' : 'ready');
    await expectSaved(session.id);
  });

  it('allows explicit conversation deletion while its output waits in a stopped runtime', async () => {
    const { session, runId } = await begin();
    await completeOffline(runId);
    stopRuntime();
    await lonca.start();
    await lonca.waitForWorkspace(workspace.id, 'stopped');
    await until('registered recovery', async () => (await lonca.items(session.id)).some((item) => item.type === 'notice' && item.text.includes('Start it to recover')));
    await lonca.api('DELETE', `/sessions/${session.id}`);
    expect((await lonca.api('GET', '/state')).sessions.some((entry: Session) => entry.id === session.id)).toBe(false);
    await sleep(1000); // Include asynchronous raw-output cleanup.
    expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  });

  it('preserves saved history and ends recovery when the runtime has been removed', async () => {
    const { session, runId } = await begin();
    await completeOffline(runId);
    removeSandbox(workspace.sandboxName);
    await lonca.start();
    await lonca.waitForIdle(session.id);
    const items = await lonca.items(session.id);
    expect(items.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(expected.slice(0, 10));
    expect(items.find((item) => item.type === 'result')).toMatchObject({ interrupted: true });
    expect(items.some((item) => item.type === 'notice' && item.text.includes('runtime was removed'))).toBe(true);
  });
});
