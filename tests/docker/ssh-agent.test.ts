import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Lonca, REAL_SANDBOX, makeFixtureRepo, sandboxSshKeys, until } from '../support/harness.ts';

describe.runIf(REAL_SANDBOX)('sandbox SSH protection with a multibyte home directory', () => {
  it('keeps out forwarded keys even when the preferred socket path exceeds the byte limit', async () => {
    const lonca = new Lonca({ port: 48353, instance: 'ssh-agent-test', firstWorkspacePort: 57200 });
    const root = fs.mkdtempSync('/tmp/lonca-u-');
    const home = path.join(root, '界'.repeat(25));
    fs.mkdirSync(home);
    fs.rmSync(lonca.home, { recursive: true, force: true });
    lonca.home = fs.realpathSync(home);
    lonca.env.TMPDIR = root;
    const fixture = makeFixtureRepo();
    let agent: ChildProcess | undefined;
    try {
      const preferred = path.join(lonca.home, 'no-keys-agent.sock');
      expect(preferred.length).toBeLessThan(100);
      expect(Buffer.byteLength(preferred)).toBeGreaterThan(100);
      await lonca.start();
      const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
      await lonca.api('PATCH', `/projects/${project.id}`, { settings: { memoryGb: 1, cpus: 1 } });
      const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
      // Background checks also restore the protective agent. Stop them so the external
      // command is the last to reach the VM before restart recovery.
      await lonca.stop();

      // Forward only a throwaway key; the user's SSH agent is never used.
      const socket = path.join(root, 'test-agent.sock');
      agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' });
      await until('the stand-in SSH agent', () => fs.existsSync(socket), 5000);
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, 'key')]);
      execFileSync('ssh-add', [path.join(root, 'key')], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
      execFileSync('sbx', ['exec', '--user', 'agent', workspace.sandboxName, '--', 'true'], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
      await lonca.start();
      await lonca.waitForWorkspace(workspace.id);
      expect(await lonca.api('GET', `/workspaces/${workspace.id}/files?path=.`)).toBeInstanceOf(Array);
      expect(sandboxSshKeys(workspace.sandboxName)).toBe('0 0');
    } finally {
      try {
        await lonca.destroy();
      } finally {
        agent?.kill();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    }
  });
});
