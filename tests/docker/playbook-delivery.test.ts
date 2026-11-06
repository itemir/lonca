import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Session } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, until } from '../support/harness.ts';
import { startMockLlm, type MockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 48450, instance: 'playbook-delivery-test', firstWorkspacePort: 58300 });
let mock: MockLlm;
let fixture: string;
let lead: Session;
const send = (text: string) => lonca.api('POST', `/sessions/${lead.id}/messages`, { text });

beforeAll(async () => {
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  lonca.env.NODE_OPTIONS = `--import=${fileURLToPath(new URL('../support/agent-output-fault.mjs', import.meta.url))}`;
  await lonca.start();
  const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', env: {
    ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock',
  } } });
  await lonca.api('PUT', '/playbook', { content: 'OLD-PLAYBOOK-DELIVERY' });
  const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
  await lonca.waitForWorkspace(created.workspace.id);
  lead = created.session;
});

afterAll(async () => {
  await lonca.destroy();
  await mock?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

it('delivers a playbook edit on retry after its first attempted delivery fails to launch', async () => {
  await send('FIRST-TURN-WITH-OLD-PLAYBOOK');
  await lonca.waitForIdle(lead.id);
  const first = await lonca.session(lead.id);
  expect(first.resumeId).toBeTruthy();
  expect(mock.requests.some((request) => request.body.includes('OLD-PLAYBOOK-DELIVERY'))).toBe(true);

  await lonca.api('PUT', '/playbook', { content: 'NEW-PLAYBOOK-DELIVERY' });
  fs.writeFileSync(path.join(lonca.home, 'output-fault.json'), JSON.stringify({ kind: 'launch-before', once: true }));
  const failedBefore = mock.requests.length;
  await send('TURN-THAT-NEVER-LAUNCHED');
  await lonca.waitForIdle(lead.id);
  const failed = await lonca.session(lead.id);
  expect(failed.lastOutcome).toBe('failed');
  expect(failed.playbookVersion).toBe(first.playbookVersion);
  expect(mock.requests.slice(failedBefore).some((request) => request.body.includes('TURN-THAT-NEVER-LAUNCHED'))).toBe(false);
  await lonca.kill();
  await lonca.start();

  const before = mock.requests.length;
  await send('RESUME-AFTER-PLAYBOOK-DELIVERY-FAILURE');
  await lonca.waitForIdle(lead.id);
  const resumed = await lonca.session(lead.id);
  expect(resumed).toMatchObject({ lastOutcome: 'completed', resumeId: first.resumeId });
  const request = mock.requests.slice(before).find((request) => request.path.endsWith('/messages') && request.body.includes('You are the Lead'));
  expect(request).toBeDefined();
  expect(request!.body).toContain('NEW-PLAYBOOK-DELIVERY');
  expect(resumed.playbookVersion).not.toBe(first.playbookVersion);
});

it('repairs an old prepared hash that was saved without delivering the edit', async () => {
  const content = 'PREPARED-BUT-NEVER-DELIVERED';
  await lonca.api('PUT', '/playbook', { content });
  await lonca.kill();
  const statePath = path.join(lonca.home, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { sessions: Session[] };
  state.sessions.find((session) => session.id === lead.id)!.playbookVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  fs.writeFileSync(statePath, JSON.stringify(state));
  await lonca.start();
  const before = mock.requests.length;
  await send('AFTER-UPGRADING-PLAYBOOK-DELIVERY');
  await lonca.waitForIdle(lead.id);
  const request = mock.requests.slice(before).find((entry) => entry.body.includes('You are the Lead'));
  expect(request?.body).toContain(content);
});

it('acknowledges the version actually delivered when another edit arrives during a turn', async () => {
  await lonca.api('PUT', '/playbook', { content: 'PLAYBOOK-DURING-TURN' });
  const before = mock.requests.length;
  await send('SLOW SNAPSHOT-TURN');
  await until('the snapshot to reach the model', () => mock.requests.slice(before).some((entry) => entry.body.includes('PLAYBOOK-DURING-TURN')));
  await lonca.api('PUT', '/playbook', { content: 'PLAYBOOK-FOR-NEXT-TURN' });
  await lonca.waitForIdle(lead.id);
  const next = mock.requests.length;
  await send('AFTER-SNAPSHOT-TURN');
  await lonca.waitForIdle(lead.id);
  expect(mock.requests.slice(next).some((entry) => entry.body.includes('PLAYBOOK-FOR-NEXT-TURN'))).toBe(true);
  const unchanged = mock.requests.length;
  await send('PLAYBOOK-UNCHANGED');
  await lonca.waitForIdle(lead.id);
  const request = mock.requests.slice(unchanged).find((entry) => entry.body.includes('You are the Lead'))!;
  const messages = JSON.parse(request.body).messages as { role: string; content: unknown }[];
  const lastUser = JSON.stringify(messages.filter((entry) => entry.role === 'user').at(-1));
  expect(lastUser).toContain('PLAYBOOK-UNCHANGED');
  expect(lastUser).not.toContain('this is your current playbook');
});
