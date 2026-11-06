import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppState, Project, TerminalInfo, Workspace } from '../../shared/types.ts';
import { FAKE_SBX, REAL_SANDBOX, Lonca, makeFixtureRepo, sandboxExec, sandboxRunning, until } from '../support/harness.ts';

const lonca = new Lonca({ port: 48451, instance: 'codex-credentials-test', firstWorkspacePort: 58400 });
const chatgpt = 'https://chatgpt.com/backend-api/codex';
const globalKey = 'sk-global-codex-test-not-real';
let fixture: string;
let project: Project;
let workspace: Workspace;
const config = () => sandboxExec(workspace.sandboxName, 'cat ~/.codex/config.toml').output;
const state = () => lonca.api<AppState>('GET', '/state');
const flag = (name: string) => path.join(lonca.home, name);
const key = (target = workspace) => JSON.parse(sandboxExec(target.sandboxName, 'cat ~/.codex/auth.json').output).OPENAI_API_KEY;
const PLACEHOLDER = 'oai-oat01-lonca-placeholder';

beforeAll(async () => {
  fixture = makeFixtureRepo();
  const wrapper = flag('sbx-credentials');
  fs.writeFileSync(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const root = process.env.LONCA_HOME;
const args = process.argv.slice(2);
(async () => {
  if (args.includes('lonca-codex-setup') && fs.existsSync(root + '/fail-setup')) {
    process.stderr.write('Temporary credential connection failure');
    process.exit(125);
  }
  if (args.includes('lonca-worktree') && fs.existsSync(root + '/hold-checkout')) {
    fs.writeFileSync(root + '/checkout-entered', '');
    while (fs.existsSync(root + '/hold-checkout')) await new Promise(r => setTimeout(r, 25));
  }
  cp.spawn(${JSON.stringify(REAL_SANDBOX ? 'sbx' : FAKE_SBX)}, args, { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1));
})();
`, { mode: 0o700 });
  lonca.env.LONCA_SBX = wrapper;
  await lonca.start();
  project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
  await until('credential status', async () => (await state()).system.agentsChecked);
  const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  workspace = await lonca.waitForWorkspace(created.workspace.id);
});

afterAll(async () => {
  fs.rmSync(flag('hold-checkout'), { force: true });
  fs.rmSync(flag('fail-setup'), { force: true });
  await lonca.destroy();
  fs.rmSync(fixture, { recursive: true, force: true });
});

it.each(['new shell', 'restarted shell', 'setup script'])('retries a missed credential update before launching a %s', async (kind) => {
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: {
    env: { OPENAI_API_KEY: 'sk-removed-project-key' },
    setupScript: 'cat ~/.codex/auth.json > .context/setup-auth.json',
  } });
  await until('the project key', () => key() === 'sk-removed-project-key');
  let shell: TerminalInfo | undefined;
  try {
    if (kind === 'restarted shell') {
      shell = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
      const terminal = await lonca.openTerminal(shell.id);
      terminal.send('exit\n');
      await until('the shell to exit', async () => (await state()).terminals.find((entry) => entry.id === shell!.id)?.status === 'exited');
      terminal.socket.close();
    }
    fs.writeFileSync(flag('fail-setup'), '');
    const before = lonca.log.length;
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { env: {} } });
    await until('the failed background update', () => lonca.log.slice(before).includes('could not update Codex'));
    expect(key()).toBe('sk-removed-project-key');
    fs.rmSync(flag('fail-setup'));

    if (kind === 'restarted shell') await lonca.api('POST', `/workspaces/${workspace.id}/terminals/${shell!.id}/restart`);
    else if (kind === 'new shell') shell = await lonca.api<TerminalInfo>('POST', `/workspaces/${workspace.id}/terminals`);
    else {
      await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
      const observed = path.join(workspace.path, '.context/setup-auth.json');
      await until('the script to read its credentials', () => fs.existsSync(observed));
      expect(JSON.parse(fs.readFileSync(observed, 'utf8')).OPENAI_API_KEY).toBe(PLACEHOLDER);
    }
    expect(key()).toBe(PLACEHOLDER);
  } finally {
    fs.rmSync(flag('fail-setup'), { force: true });
    if (shell) await lonca.api('DELETE', `/terminals/${shell.id}`);
  }
});

it('applies a change made during checkout preparation before the automatic setup script', async () => {
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: {
    env: { OPENAI_API_KEY: 'sk-before-provision' },
    setupScript: 'cat ~/.codex/auth.json > .context/setup-auth.json',
  } });
  fs.writeFileSync(flag('hold-checkout'), '');
  const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
  try {
    await until('checkout preparation after credential setup', () => fs.existsSync(flag('checkout-entered')));
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { env: {} } });
    fs.rmSync(flag('hold-checkout'));
    const target = await lonca.waitForWorkspace(created.workspace.id);
    const observed = path.join(target.path, '.context/setup-auth.json');
    await until('the automatic script to read its credentials', () => fs.existsSync(observed));
    expect(JSON.parse(fs.readFileSync(observed, 'utf8')).OPENAI_API_KEY).toBe(PLACEHOLDER);
  } finally {
    fs.rmSync(flag('hold-checkout'), { force: true });
    await lonca.api('DELETE', `/workspaces/${created.workspace.id}`);
  }
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
