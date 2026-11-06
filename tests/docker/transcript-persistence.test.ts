import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionSnapshot, Workspace } from '../../shared/types.ts';
import { RUNTIME, Lonca, asRoot, sandboxExec, makeFixtureRepo, until, sleep } from '../support/harness.ts';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe('conversation persistence boundaries', () => {
  const lonca = new Lonca({ port: 48327, instance: `transcript-persistence-${RUNTIME}`, firstWorkspacePort: 53200});
  const fixture = makeFixtureRepo();
  let workspace: Workspace;
  const marker = (name: string) => path.join(workspace.path, '.context', `persistence-${name}`);
  const transcriptFile = (id: string) => path.join(lonca.home, 'sessions', `${id}.jsonl`);
  const started = () => fs.readFileSync(marker('started'), 'utf8').trim().split('\n');

  beforeAll(async () => {
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    const cli = sandboxExec(workspace.sandboxName, 'command -v claude').output;
    const script = `#!/usr/bin/python3
import json, os, sys, time
prompt = sys.stdin.read().strip()
with open('.context/persistence-started', 'a') as stream:
    stream.write(prompt + '\\n')
if prompt == 'prime':
    print(json.dumps({'type': 'system', 'subtype': 'init', 'session_id': 'saved-conversation'}), flush=True)
if prompt == 'wait-missing' and '--resume' in sys.argv:
    open('.context/persistence-ready', 'w').close()
    while not os.path.exists('.context/persistence-release'):
        time.sleep(0.05)
    print('No conversation found with session ID', file=sys.stderr)
    sys.exit(1)
count = int(prompt.split()[-1]) if prompt.startswith('bulk') else 1
for i in range(count):
    print(json.dumps({'type': 'assistant', 'message': {'id': str(i), 'content': [{'type': 'text', 'text': prompt + ': ' + str(i)}]}}), flush=True)
open('.context/persistence-ready', 'w').close()
if prompt.startswith('wait') or prompt.startswith('bulk-wait'):
    while not os.path.exists('.context/persistence-release'):
        time.sleep(0.05)
print(json.dumps({'type': 'result', 'is_error': False}), flush=True)
`;
    asRoot(workspace.sandboxName, `printf %s ${quote(script)} > ${quote(cli)}\nchmod +x ${quote(cli)}`);
  });

  beforeEach(() => {
    for (const name of ['started', 'ready', 'release']) fs.rmSync(marker(name), { force: true });
  });

  afterEach(async () => {
    const sessions = (await lonca.api('GET', '/state')).sessions as Session[];
    for (const session of sessions) await lonca.api('DELETE', `/sessions/${session.id}`);
  });

  afterAll(async () => {
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  async function send(text: string): Promise<Session> {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text });
    return session;
  }

  function finished(id: string): Promise<SessionSnapshot> {
    return until('the completed conversation', async () => {
      const snapshot = await lonca.api<SessionSnapshot>('GET', `/sessions/${id}`);
      return snapshot.session.status === 'idle' && snapshot.session.queue.length === 0 && snapshot.items.some((item) => item.type === 'result') ? snapshot : null;
    }, 30000, 5);
  }

  // From the saved state, which stays available when a conversation's transcript can't be read.
  const savedSession = async (id: string) => ((await lonca.api('GET', '/state')).sessions as Session[]).find((entry) => entry.id === id);

  function failWrites(file: string): () => void {
    const saved = `${file}.saved`;
    const existed = fs.existsSync(file);
    if (existed) fs.renameSync(file, saved);
    fs.mkdirSync(file);
    let restored = false;
    return () => {
      if (restored) return;
      fs.rmdirSync(file);
      if (existed) fs.renameSync(saved, file);
      restored = true;
    };
  }

  it.each(['live', 'recovered'] as const)('keeps every item after a crash immediately following %s completion', async (mode) => {
    const session = await send(mode === 'live' ? 'bulk 1000' : 'bulk-wait 1000');
    if (mode === 'recovered') {
      await until('the original text to be saved', () => fs.readFileSync(transcriptFile(session.id), 'utf8').includes('bulk-wait 1000: 999'));
      const runId = (await lonca.session(session.id)).activeRunId;
      await lonca.stop();
      fs.writeFileSync(marker('release'), 'finish');
      await until('completion while offline', () => sandboxExec(workspace.sandboxName, `test -f /var/tmp/lonca/agent-runs/${runId}/exit`).code === 0);
      await lonca.start();
    }
    const before = await finished(session.id);
    await lonca.kill();
    await lonca.start();
    const after = await lonca.api<SessionSnapshot>('GET', `/sessions/${session.id}`);
    expect(after.session).toMatchObject({ status: 'idle', activeRunId: null });
    expect(after.items).toEqual(before.items);
    expect(after.items.filter((item) => item.type === 'text')).toHaveLength(1000);
    expect(after.items.find((item) => item.type === 'result')).toMatchObject({ failed: false });
  });

  for (const storage of ['transcript', 'state'] as const) {
    it.each(['retry', 'restart'] as const)(`retains recovery data and queued work through failed ${storage} writes and %s`, async (recovery) => {
      const session = await send('wait');
      await until('the first agent', () => fs.existsSync(marker('ready')));
      const queued = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'follow-up' });
      const runId = (await lonca.session(session.id)).activeRunId;
      const restore = failWrites(storage === 'state' ? path.join(lonca.home, 'state.json') : transcriptFile(session.id));
      const logStart = lonca.log.length;
      try {
        fs.writeFileSync(marker('release'), 'finish');
        await until('completion persistence to fail', () => lonca.log.slice(logStart).includes('could not finish saving a turn:'));
        expect(await lonca.session(session.id)).toMatchObject({ status: 'running', activeRunId: runId, queue: [queued.id] });
        expect(started()).toEqual(['wait']);
        expect(sandboxExec(workspace.sandboxName, `test -s /var/tmp/lonca/agent-runs/${runId}/out.jsonl`).code).toBe(0);
        if (recovery === 'restart') await lonca.kill();
        restore();
        if (recovery === 'restart') await lonca.start();
        const complete = await finished(session.id);
        expect(started()).toEqual(['wait', 'follow-up']);
        expect(complete.items.filter((item) => item.type === 'user').map((item) => item.text)).toEqual(['wait', 'follow-up']);
        expect(complete.items.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(['wait: 0', 'follow-up: 0']);
        expect(complete.items.filter((item) => item.type === 'result')).toHaveLength(2);
        await lonca.kill();
        await lonca.start();
        expect(await lonca.items(session.id)).toEqual(complete.items);
      } finally {
        restore();
      }
    });
  }

  it.each(['direct', 'queued'] as const)('rejects an unsaved %s message without executing it later', async (mode) => {
    const session = mode === 'queued' ? await send('wait')
      : await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    if (mode === 'queued') await until('the original agent', () => fs.existsSync(marker('ready')));
    const restore = failWrites(transcriptFile(session.id));
    try {
      await expect(lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'rejected-message' })).rejects.toThrow(/500.*could not be saved/);
      expect((await savedSession(session.id))?.queue).toEqual([]);
    } finally {
      restore();
    }
    expect((await lonca.items(session.id)).some((item) => item.type === 'user' && item.text === 'rejected-message')).toBe(false);
    await lonca.stop();
    await lonca.start();
    if (mode === 'queued') {
      await until('the original run to reconnect', async () => { await lonca.api('POST', `/sessions/${session.id}/interrupt`); return true; });
      await finished(session.id);
    }
    expect((await lonca.items(session.id)).some((item) => item.type === 'user' && item.text === 'rejected-message')).toBe(false);
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'accepted-after-recovery' });
    await finished(session.id);
    expect(started()).toEqual(mode === 'queued' ? ['wait', 'accepted-after-recovery'] : ['accepted-after-recovery']);
  });

  it.each(['by itself', 'after a restart'] as const)('keeps a recovering turn and its follow-up through an unreadable transcript, and delivers them %s', async (recovery) => {
    const session = await send('wait');
    await until('the original agent', () => fs.existsSync(marker('ready')));
    const queued = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'follow-up' });
    const runId = (await lonca.session(session.id)).activeRunId;
    await lonca.stop();
    fs.writeFileSync(marker('release'), 'finish');
    await until('completion while offline', () => sandboxExec(workspace.sandboxName, `test -f /var/tmp/lonca/agent-runs/${runId}/exit`).code === 0);
    const restore = failWrites(transcriptFile(session.id));
    try {
      await lonca.start();
      await expect(lonca.api('GET', `/sessions/${session.id}`)).rejects.toThrow(/500/);
      expect(await savedSession(session.id)).toMatchObject({ activeRunId: runId, queue: [queued.id] });
    } finally {
      restore();
    }
    if (recovery === 'after a restart') {
      await lonca.kill();
      await lonca.start();
    }
    const complete = await finished(session.id);
    expect(started()).toEqual(['wait', 'follow-up']);
    expect(complete.items.filter((item) => item.type === 'user').map((item) => item.text)).toEqual(['wait', 'follow-up']);
  });

  it('can stop an agent that kept running once its unreadable transcript can be read', async () => {
    const session = await send('wait');
    await until('the original agent', () => fs.existsSync(marker('ready')));
    const runId = (await lonca.session(session.id)).activeRunId;
    const pid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/agent-runs/${runId}/pid`).output;
    await lonca.stop();
    const restore = failWrites(transcriptFile(session.id));
    try {
      await lonca.start();
      await expect(lonca.api('POST', `/sessions/${session.id}/interrupt`)).rejects.toThrow(/409.*reconnecting/);
      expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).toBe(0);
    } finally {
      restore();
    }
    await until('the run to be picked up', async () => {
      await lonca.api('POST', `/sessions/${session.id}/interrupt`);
      return true;
    }, 15000);
    const complete = await finished(session.id);
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
    expect(complete.items.find((item) => item.type === 'result')).toMatchObject({ interrupted: true });
  });

  it('keeps a waiting message through an unreadable transcript, and sends it with Send now', async () => {
    const session = await send('wait');
    await until('the original agent', () => fs.existsSync(marker('ready')));
    const queued = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'follow-up' });
    await lonca.api('POST', `/sessions/${session.id}/interrupt`);
    await until('the turn to stop', async () => (await savedSession(session.id))?.status === 'idle');
    await lonca.stop();
    const restore = failWrites(transcriptFile(session.id));
    try {
      await lonca.start();
      await lonca.api('POST', `/sessions/${session.id}/queue/flush`);
      expect(await savedSession(session.id)).toMatchObject({ activeRunId: null, queue: [queued.id] });
    } finally {
      restore();
    }
    await lonca.api('POST', `/sessions/${session.id}/queue/flush`);
    await finished(session.id);
    expect(started()).toEqual(['wait', 'follow-up']);
  });

  it('preserves accepted queue entries and cancellations across immediate crashes', async () => {
    const session = await send('wait');
    await until('the original agent', () => fs.existsSync(marker('ready')));
    const cancelled = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'cancel-this' });
    const kept = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'keep-this' });
    await lonca.kill();
    await lonca.start();
    expect((await lonca.items(session.id)).filter((item) => item.type === 'user').map((item) => item.text)).toEqual(['wait', 'cancel-this', 'keep-this']);
    await until('the original run to reconnect', async () => { await lonca.api('POST', `/sessions/${session.id}/interrupt`); return true; });
    await until('the queue to be held', async () => (await lonca.session(session.id)).status === 'idle');
    await lonca.api('DELETE', `/sessions/${session.id}/queue/${cancelled.id}`);
    await lonca.kill();
    await lonca.start();
    expect(await lonca.session(session.id)).toMatchObject({ held: true, queue: [kept.id] });
    expect((await lonca.items(session.id)).some((item) => item.id === cancelled.id)).toBe(false);
    await lonca.api('POST', `/sessions/${session.id}/queue/flush`);
    const complete = await finished(session.id);
    expect(started()).toEqual(['wait', 'keep-this']);
    expect(complete.items.filter((item) => item.type === 'user').map((item) => item.text)).toEqual(['wait', 'keep-this']);
  });

  it.each(['retry', 'restart'] as const)('keeps an accepted message queued if promoting it fails, then permits %s', async (recovery) => {
    await lonca.stop();
    const hook = path.join(lonca.home, 'transcript-fault.mjs');
    const block = path.join(lonca.home, 'block-promotion');
    // Fail only the write after acceptance, at the boundary before a CLI may launch.
    fs.writeFileSync(hook, `import fs from 'node:fs';
const append = fs.appendFileSync;
fs.appendFileSync = (file, data, options) => {
  if (String(file).startsWith(process.env.LONCA_HOME + '/sessions/') && String(data).includes('"moved"') && fs.existsSync(${JSON.stringify(block)})) {
    throw Object.assign(new Error('Injected full disk during promotion'), { code: 'ENOSPC' });
  }
  return append(file, data, options);
};
`);
    fs.writeFileSync(block, 'fail');
    lonca.env.NODE_OPTIONS = `--import=${hook}`;
    await lonca.start();
    try {
      const session = await send('accepted-before-promotion-failed');
      const current = await lonca.session(session.id);
      expect(current).toMatchObject({ status: 'idle', activeRunId: null, held: true });
      expect(current.queue).toHaveLength(1);
      expect(fs.existsSync(marker('started'))).toBe(false);
      if (recovery === 'restart') await lonca.kill();
      fs.rmSync(block);
      if (recovery === 'restart') await lonca.start();
      expect((await lonca.session(session.id)).queue).toEqual(current.queue);
      // A failed start holds the queue; Send now retries it on either server.
      await lonca.api('POST', `/sessions/${session.id}/queue/flush`);
      const complete = await finished(session.id);
      expect(started()).toEqual(['accepted-before-promotion-failed']);
      expect(complete.items.filter((item) => item.type === 'user')).toHaveLength(1);
      expect(complete.items.find((item) => item.type === 'user')).toMatchObject({ text: 'accepted-before-promotion-failed', queued: false });
    } finally {
      fs.rmSync(block, { force: true });
      delete lonca.env.NODE_OPTIONS;
      await lonca.stop();
      await lonca.start();
    }
  });

  it('keeps the exact message recoverable if saving a lost-conversation retry fails', async () => {
    const session = await send('prime');
    await finished(session.id);
    expect((await lonca.session(session.id)).resumeId).toBe('saved-conversation');
    fs.rmSync(marker('ready'));
    const sent = await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'wait-missing' });
    await until('the failed continuation', () => fs.existsSync(marker('ready')));
    expect((await lonca.session(session.id)).activeMessageId).toBe(sent.id);
    const restore = failWrites(path.join(lonca.home, 'state.json'));
    const logStart = lonca.log.length;
    try {
      fs.writeFileSync(marker('release'), 'finish');
      await until('saving the retry to fail', () => lonca.log.slice(logStart).includes('could not finish saving a turn:'));
      await lonca.kill();
      restore();
      await lonca.start();
      const complete = await finished(session.id);
      expect(started()).toEqual(['prime', 'wait-missing', 'wait-missing']);
      expect(complete.items.filter((item) => item.type === 'user').map((item) => [item.text, Boolean(item.queued)])).toEqual([['prime', false], ['wait-missing', false]]);
      expect(complete.items.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(['prime: 0', 'wait-missing: 0']);
      expect(complete.session).toMatchObject({ resumeId: null, activeRunId: null });
      expect(complete.session.activeMessageId).toBeUndefined();
    } finally {
      restore();
    }
  });

  it.each(['transcript', 'state'] as const)('keeps shutdown retryable when pending %s writes fail', async (storage) => {
    const session = await send('bulk-wait 500');
    await until('the original text to be saved', () => fs.readFileSync(transcriptFile(session.id), 'utf8').includes('bulk-wait 500: 499'));
    const restore = failWrites(storage === 'transcript' ? transcriptFile(session.id) : path.join(lonca.home, 'state.json'));
    const logStart = lonca.log.length;
    try {
      fs.writeFileSync(marker('release'), 'finish');
      await until('pending completion', () => lonca.log.slice(logStart).includes('could not finish saving a turn:'));
      const stopping = lonca.stop();
      await until('shutdown persistence to fail', () => lonca.log.slice(logStart).includes('Lonca is still running'));
      expect((await lonca.session(session.id)).activeRunId).not.toBeNull();
      restore();
      await lonca.stop();
      await stopping;
      await lonca.start();
      const complete = await finished(session.id);
      expect(complete.items.filter((item) => item.type === 'text')).toHaveLength(500);
    } finally {
      restore();
    }
  });
});
