import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppState, Project, Workspace } from '../../shared/types.ts';
import { Lonca, makeFixtureRepo, sandboxExec, sandboxRunning, until } from '../support/harness.ts';

const lonca = new Lonca({ port: 48451, instance: 'codex-credentials-test', firstWorkspacePort: 58400 });
const chatgpt = 'https://chatgpt.com/backend-api/codex';
const globalKey = 'sk-global-codex-test-not-real';
let fixture: string;
let project: Project;
let workspace: Workspace;
const config = () => sandboxExec(workspace.sandboxName, 'cat ~/.codex/config.toml').output;
const state = () => lonca.api<AppState>('GET', '/state');

beforeAll(async () => {
  fixture = makeFixtureRepo();
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await until('credential status', async () => (await state()).system.agentsChecked);
  const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(created.workspace.id);
});

afterAll(async () => {
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

it('updates an existing terminal workspace when a global API key is saved', async () => {
  expect(config()).toContain(chatgpt);
  await lonca.api('PUT', '/agents/codex/api-key', { key: globalKey });
  expect(fs.readFileSync(path.join(lonca.home, 'boundary', 'codex'), 'utf8')).toBe(globalKey);
  await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
  expect(config()).not.toContain(chatgpt);
  expect((await state()).system.agents.codex.signedIn).toBe(true);
});

it('switches a running workspace back to ChatGPT and preserves project key overrides', async () => {
  const loginPath = path.join(lonca.home, 'helper-credentials', 'codex', 'auth.json');
  fs.mkdirSync(path.dirname(loginPath), { recursive: true });
  fs.writeFileSync(loginPath, JSON.stringify({ tokens: { access_token: 'chatgpt-test-token', refresh_token: 'test-refresh' } }));
  await lonca.api('POST', '/agents/refresh');
  expect(config()).toContain(chatgpt);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { env: { OPENAI_API_KEY: 'sk-project-override' } } });
  // Project settings deliberately update running VMs in the background.
  await until('the project endpoint', () => !config().includes(chatgpt));
  await lonca.api('POST', '/agents/refresh');
  expect(config()).not.toContain(chatgpt);
  expect(sandboxExec(workspace.sandboxName, 'cat ~/.codex/auth.json').output).toContain('sk-project-override');
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { env: {} } });
  await until('the global endpoint', () => config().includes(chatgpt));
});

it('keeps stopped workspaces stopped and applies the current endpoint on their next boot', async () => {
  await lonca.api('POST', `/workspaces/${workspace.id}/stop`);
  await lonca.api('PUT', '/agents/codex/api-key', { key: globalKey });
  expect((await lonca.workspace(workspace.id)).status).toBe('stopped');
  expect(sandboxRunning(workspace.sandboxName)).toBe(false);
  await lonca.api('POST', `/workspaces/${workspace.id}/start`);
  expect(config()).not.toContain(chatgpt);
});
