import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeSet, ChatItem, FileContent, FileEntry, LoginState, Project, Session, TextItem, ToolItem, Workspace } from '../../shared/types.ts';
import { BLOCKED_DESTINATIONS, SANDBOX_BOOT, templateTag } from '../../server/sandbox.ts';
import { FAKE_SANDBOX, FAKE_SBX, FAKE_SBX_DIR, Lonca, REAL_SANDBOX, docker, sandboxExec, sandboxExecAsync, git, installFakeSignIn, makeFixtureRepo, removeFakeSignIn, removeSandbox, sandboxRunning, sandboxSshKeys, sbx, setFakeSignIn, sleep, until, asRoot } from '../support/harness.ts';
import { type MockLlm, startMockLlm } from '../support/mock-llm.ts';

const lonca = new Lonca({ port: 47181, instance: 'dockertest', firstWorkspacePort: 46100 });
let mock: MockLlm;
let fixture: string;
let project: Project;
let a: { workspace: Workspace; session: Session };
let b: { workspace: Workspace; session: Session };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const texts = (items: ChatItem[]) => items.filter((item): item is TextItem => item.type === 'text').map((item) => item.text);
const tools = (items: ChatItem[]) => items.filter((item): item is ToolItem => item.type === 'tool');

beforeAll(async () => {
  mock = await startMockLlm();
  fixture = makeFixtureRepo();
  // Start cold, as a new user does: the template has to build while workspaces are requested.
  if (FAKE_SANDBOX) sbx('template', 'rm', '--force', templateTag());
  await lonca.start();
});

afterAll(async () => {
  await lonca.destroy();
  await mock.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe('access control', () => {
  it('rejects API calls without the token', async () => {
    expect((await fetch(`${lonca.url}/api/state`)).status).toBe(401);
    const wrong = await fetch(`${lonca.url}/api/state`, { headers: { authorization: 'Bearer wrong' } });
    expect(wrong.status).toBe(401);
  });

  it('rejects other hosts and cross-site origins even with the token', async () => {
    // `fetch` won't send a custom Host header, as a rebinding attack's browser would.
    const hostSpoof = await new Promise<number>((resolve, reject) => {
      http.get({ port: lonca.port, path: '/api/state', headers: { ...lonca.headers, host: 'evil.example:47181' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }).on('error', reject);
    });
    expect(hostSpoof).toBe(403);
    const crossSite = await fetch(`${lonca.url}/api/projects`, {
      method: 'POST',
      headers: { ...lonca.headers, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(crossSite.status).toBe(403);
  });

  it('refuses to be framed by a page on a published port', async () => {
    const page = await fetch(`${lonca.url}/`);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('survives a malformed WebSocket URL from any page', async () => {
    const { connect } = await import('node:net');
    for (const path of ['//', '/ws//', '//ws?x=%']) {
      await new Promise<void>((resolve) => {
        const socket = connect(lonca.port, '127.0.0.1', () => {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${lonca.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        socket.on('close', () => resolve());
        socket.on('error', () => resolve());
        setTimeout(() => socket.destroy(), 500);
      });
    }
    await sleep(200);
    expect((await fetch(`${lonca.url}/api/state`, { headers: lonca.headers })).status).toBe(200);
  });

  it('never hands out a cookie, which would reach servers on other ports', async () => {
    const page = await fetch(`${lonca.url}/?token=${lonca.token}`);
    expect(page.headers.get('set-cookie')).toBeNull();
    const state = await fetch(`${lonca.url}/api/state`, { headers: lonca.headers });
    expect(state.headers.get('set-cookie')).toBeNull();
  });
});

describe('projects and workspaces', () => {
  it('imports a local repository without touching it', async () => {
    const before = git(fixture, 'worktree', 'list');
    const created = await lonca.api<Project>('POST', '/projects', { path: fixture });
    project = await lonca.waitForProject(created.id);
    expect(project.settings.defaultBranch).toBe('main');
    expect(project.settings.filesToCopy).toEqual([]);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { filesToCopy: ['.env*'] } });
    expect(project.remoteUrl).toBeNull();
    expect(git(fixture, 'worktree', 'list')).toBe(before);
    expect(await lonca.api('GET', `/projects/${project.id}/branches`)).toEqual(['main']);
  });

  it('rejects things that are not git repositories', async () => {
    await expect(lonca.api('POST', '/projects', { path: '/tmp' })).rejects.toThrow(/not a git repository/);
    await expect(lonca.api('POST', '/projects', { url: 'not a url' })).rejects.toThrow(/Enter a GitHub URL/);
  });

  it('creates several workspaces, each a real worktree in its own container', async () => {
    [a, b] = await Promise.all([
      lonca.api('POST', `/projects/${project.id}/workspaces`, {}),
      lonca.api('POST', `/projects/${project.id}/workspaces`, {}),
    ]);
    expect(a.workspace.name).not.toBe(b.workspace.name);
    a.workspace = await lonca.waitForWorkspace(a.workspace.id);
    b.workspace = await lonca.waitForWorkspace(b.workspace.id);
    expect(a.workspace.sandboxName).not.toBe(b.workspace.sandboxName);
    expect(a.workspace.port).not.toBe(b.workspace.port);

    expect(sandboxRunning(a.workspace.sandboxName)).toBe(true);

    const list = sandboxExec(a.workspace.sandboxName, `git -C ${a.workspace.path} worktree list`).output;
    expect(list).toContain(a.workspace.path);
    expect(list).toContain(b.workspace.path);
    expect(list).toContain(`[${a.workspace.branch}]`);
    expect(sandboxExec(a.workspace.sandboxName, 'git status --short --branch').output).toContain(a.workspace.branch);
    expect(fs.readFileSync(path.join(a.workspace.path, '.git'), 'utf8')).toMatch(/^gitdir: .*repo\.git\/worktrees\//);
    expect(fs.readFileSync(path.join(a.workspace.path, 'README.md'), 'utf8')).toContain('Fixture');
  });

  it('copies ignored files from the local checkout and ignores .context', async () => {
    expect(a.workspace.filesCopied).toBe(1);
    expect(fs.readFileSync(path.join(a.workspace.path, '.env'), 'utf8')).toContain('from-local-checkout');
    fs.writeFileSync(path.join(a.workspace.path, '.context', 'note.txt'), 'scratch');
    expect(sandboxExec(a.workspace.sandboxName, 'git status --porcelain').output).toBe('');
  });

  it('gives a copied file the permissions it has in the local checkout', async () => {
    const source = path.join(fixture, '.env');
    fs.chmodSync(source, 0o640);
    try {
      const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
      const workspace = await lonca.waitForWorkspace(created.workspace.id);
      expect(fs.statSync(path.join(workspace.path, '.env')).mode & 0o777).toBe(0o640);
      await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    } finally {
      fs.chmodSync(source, 0o644);
    }
  });

  it('picks up new local commits in later workspaces when there is no remote', async () => {
    fs.writeFileSync(path.join(fixture, 'added-later.txt'), 'later\n');
    git(fixture, 'add', '.');
    git(fixture, 'commit', '--quiet', '-m', 'Add a file');
    const c = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(c.workspace.id);
    expect(fs.existsSync(path.join(workspace.path, 'added-later.txt'))).toBe(true);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });
});

describe('isolation', () => {
  it('cannot see other workspaces or the host filesystem', () => {
    const name = a.workspace.sandboxName;
    expect(sandboxExec(name, `test -e ${b.workspace.path}/README.md`).code).not.toBe(0);
    expect(sandboxExec(name, `test -e ${fixture}/README.md`).code).not.toBe(0);
    expect(sandboxExec(name, `test -e ${lonca.home}/secrets.json`).code).not.toBe(0);
    expect(sandboxExec(name, `test -e ${lonca.home}/token`).code).not.toBe(0);
    expect(sandboxExec(name, `test -d ${a.workspace.path}`).code).toBe(0);
  });

  it('keeps each workspace’s home directory private', () => {
    sandboxExec(a.workspace.sandboxName, 'echo private > ~/only-in-a');
    expect(sandboxExec(b.workspace.sandboxName, 'test -e ~/only-in-a').code).not.toBe(0);
  });

  it('runs as its own user, with sudo that stops at the VM', () => {
    const name = a.workspace.sandboxName;
    expect(sandboxExec(name, 'id -un').output).toBe('agent');
    expect(sandboxExec(name, 'sudo -n id -u').output).toBe('0');
  });

  it.runIf(REAL_SANDBOX)('has a kernel of its own', () => {
    const bootId = (name: string) => sandboxExec(name, 'cat /proc/sys/kernel/random/boot_id').output;
    expect(bootId(a.workspace.sandboxName)).not.toBe(bootId(b.workspace.sandboxName));
  });

  // Docker Sandboxes 0.50 gives a sandbox the SSH agent of the last command run in it, until another
  // command brings a different one. Lonca's commands bring one with no keys. 0.51 doesn't lend it.
  it.runIf(REAL_SANDBOX)('keeps out the SSH keys of an sbx command run from a terminal', async () => {
    const name = a.workspace.sandboxName;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-ssh-'));
    const socket = path.join(dir, 'agent.sock');
    let agent: ChildProcess | undefined;
    try {
      // A throwaway agent and key stand in for the user's.
      agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' });
      await until('the stand-in agent', () => fs.existsSync(socket), 5000);
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'key')]);
      execFileSync('ssh-add', [path.join(dir, 'key')], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
      execFileSync('sbx', ['exec', '--user', 'agent', name, '--', 'true'], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
      // Any command Lonca runs there, such as listing files.
      await lonca.api('GET', `/workspaces/${a.workspace.id}/files?path=.`);
      expect(sandboxSshKeys(name)).toBe('0 0');
    } finally {
      agent?.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The fake sandbox has no network policy to test.
  it.skipIf(FAKE_SANDBOX)('cannot reach the host or the Lonca server', async () => {
    const name = a.workspace.sandboxName;
    const curl = async (url: string) => (await sandboxExecAsync(name, `curl -s -o /dev/null -m 4 -w '%{http_code}' ${url}`)).output;
    expect(await curl(`http://host.docker.internal:${lonca.port}/api/state`)).toMatch(/^(000|403)/);
    expect(await curl(`http://host.docker.internal:${mock.port}/`)).toMatch(/^(000|403)/);
  });

  it('can reach the internet and publishes its ports to the host', async () => {
    const name = a.workspace.sandboxName;
    expect(sandboxExec(name, `curl -s -o /dev/null -m 10 -w '%{http_code}' https://github.com/`).output).toBe('200');
    // sbx exec waits for whatever still holds its output, so the whole background job needs redirecting.
    sandboxExec(name, `(cd /tmp && nohup python3 -m http.server ${a.workspace.port} --bind 0.0.0.0) >/dev/null 2>&1 &`);
    const response = await until('the published port', () => fetch(`http://127.0.0.1:${a.workspace.port}/`), 10000);
    expect(response.status).toBe(200);
  });

  it('reads files through the container, so symlinks cannot reach host files', async () => {
    fs.symlinkSync('/etc/passwd', path.join(a.workspace.path, 'host-passwd'));
    const file = await lonca.api<FileContent>('GET', `/workspaces/${a.workspace.id}/file?path=host-passwd`);
    expect(file.content).toContain('agent:x:1000');
    expect(file.content).not.toContain('_appleevents');
    fs.unlinkSync(path.join(a.workspace.path, 'host-passwd'));
    await expect(lonca.api('GET', `/workspaces/${a.workspace.id}/file?path=../../../etc/passwd`)).rejects.toThrow(/outside the workspace/);
  });

  it('never bakes secrets into the container definition', async () => {
    await lonca.api('PUT', '/secrets/github', { token: 'ghp_not_a_real_token' });
    const state = await lonca.api('GET', '/state');
    expect(JSON.stringify(state)).not.toContain('ghp_not_a_real_token');
    expect(state.secrets.githubToken).toBe('••••oken');
    expect(fs.statSync(path.join(lonca.home, 'secrets.json')).mode & 0o777).toBe(0o600);
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    expect(REAL_SANDBOX ? sbx('ls', '--json') : docker('inspect', workspace.sandboxName)).not.toContain('ghp_not_a_real_token');
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    await lonca.api('PUT', '/secrets/github', { token: '' });
  });
});

describe('hostile files in a workspace', () => {
  const repoPath = () => path.join(lonca.home, 'projects', project.slug, 'repo.git');

  it('doesn’t treat a directory’s name as an instruction', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    fs.mkdirSync(path.join(workspace.path, '-delete'));
    fs.writeFileSync(path.join(workspace.path, '-delete', 'inside.txt'), 'x');
    const entries = await lonca.api<FileEntry[]>('GET', `/workspaces/${workspace.id}/files?path=-delete`);
    expect(entries.map((entry) => entry.name)).toEqual(['inside.txt']);
    expect(fs.existsSync(path.join(workspace.path, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspace.path, '.git'))).toBe(true);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('won’t read FIFOs or endless devices through the file API', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    sandboxExec(workspace.sandboxName, `cd ${workspace.path} && mkfifo a-fifo && ln -s /dev/zero endless`);
    await expect(lonca.api('GET', `/workspaces/${workspace.id}/file?path=a-fifo`)).rejects.toThrow(/isn’t a file/);
    await expect(lonca.api('GET', `/workspaces/${workspace.id}/file?path=endless`)).rejects.toThrow(/isn’t a file/);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('ignores a repository’s lonca.json if it’s an endless file', async () => {
    const repo = makeFixtureRepo();
    fs.symlinkSync('/dev/zero', path.join(repo, 'lonca.json'));
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'Add a trap');
    const created = await lonca.api<Project>('POST', '/projects', { path: repo });
    await lonca.waitForProject(created.id);
    const made = await lonca.api('POST', `/projects/${created.id}/workspaces`, {});
    await lonca.waitForWorkspace(made.workspace.id);
    expect((await fetch(`${lonca.url}/api/state`, { headers: lonca.headers })).status).toBe(200);
    await lonca.api('DELETE', `/projects/${created.id}`);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('lists branches even if an agent swaps packed-refs for a FIFO', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    const fifo = path.join(repoPath(), 'packed-refs');
    const hadPacked = fs.existsSync(fifo);
    const saved = hadPacked ? fs.readFileSync(fifo) : null;
    sandboxExec(workspace.sandboxName, `rm -f ${fifo} && mkfifo ${fifo}`);
    const branches = await Promise.race([
      lonca.api<string[]>('GET', `/projects/${project.id}/branches`),
      sleep(5000).then(() => 'hung'),
    ]);
    expect(branches).not.toBe('hung');
    fs.rmSync(fifo, { force: true });
    if (saved) fs.writeFileSync(fifo, saved);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('removes a project an agent made read-only, and never runs its hooks on the host', async () => {
    const repo = makeFixtureRepo();
    const marker = path.join(lonca.home, 'hook-ran-on-host');
    const created = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: repo })).id);
    const made = await lonca.api('POST', `/projects/${created.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(made.workspace.id);
    const hooks = path.join(lonca.home, 'projects', created.slug, 'repo.git', 'hooks');
    sandboxExec(workspace.sandboxName, `mkdir -p ${hooks} && printf '#!/bin/sh\\ntouch ${marker}\\n' > ${hooks}/reference-transaction && chmod +x ${hooks}/reference-transaction && chmod 555 ${hooks} && mkdir ${workspace.path}/locked && touch ${workspace.path}/locked/file && chmod 555 ${workspace.path}/locked`);
    await lonca.api('DELETE', `/projects/${created.id}`);
    expect(fs.existsSync(path.join(lonca.home, 'projects', created.slug))).toBe(false);
    const again = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: repo })).id);
    expect(fs.existsSync(marker)).toBe(false);
    await lonca.api('DELETE', `/projects/${again.id}`);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('never reuses a directory left behind by a removal that failed', async () => {
    const repo = makeFixtureRepo();
    const name = path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const leftover = path.join(lonca.home, 'projects', name);
    fs.mkdirSync(path.join(leftover, 'repo.git', 'hooks'), { recursive: true });
    const created = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: repo })).id);
    expect(created.slug).toBe(`${name}-2`);
    await lonca.api('DELETE', `/projects/${created.id}`);
    fs.rmSync(leftover, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('archives and deletes workspaces with read-only directories', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    sandboxExec(workspace.sandboxName, `cd ${workspace.path} && mkdir -p cache/mod && touch cache/mod/file && chmod -R 555 cache`);
    await lonca.api('POST', `/workspaces/${workspace.id}/archive`);
    expect((await lonca.workspace(workspace.id)).status).toBe('archived');
    expect(fs.existsSync(workspace.path)).toBe(false);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('survives a terminal paste larger than a WebSocket frame', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    const info = await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
    const terminal = await lonca.openTerminal(info.id);
    terminal.socket.on('error', () => {});
    terminal.send('x'.repeat(5 * 1024 * 1024));
    await sleep(500);
    expect((await fetch(`${lonca.url}/api/state`, { headers: lonca.headers })).status).toBe(200);
    terminal.socket.close();
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('can delete a workspace whose container can’t start', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: 'lonca-image-that-does-not-exist:nope' } });
    removeSandbox(workspace.sandboxName);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    expect(fs.existsSync(workspace.path)).toBe(false);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: '' } });
  });

  it('reports an import cut off by a restart instead of showing it in progress forever', async () => {
    const created = await lonca.api<Project>('POST', '/projects', { url: 'https://10.255.255.1/nobody/nothing.git' });
    await lonca.kill();
    await lonca.start();
    const state = await lonca.api('GET', '/state');
    const project2 = state.projects.find((entry: Project) => entry.id === created.id);
    expect(project2.status).toBe('error');
    expect(project2.error).toContain('Lonca stopped');
    await lonca.api('DELETE', `/projects/${created.id}`);
  });
});

describe('files and changes', () => {
  it('lists directories and flags ignored files', async () => {
    const entries = await lonca.api<FileEntry[]>('GET', `/workspaces/${a.workspace.id}/files?path=.`);
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(['.context', 'README.md', 'src', '.env']));
    expect(names).not.toContain('.git');
    expect(entries.find((entry) => entry.name === '.env')?.ignored).toBe(true);
    expect(entries.find((entry) => entry.name === 'src')?.type).toBe('dir');
    const nested = await lonca.api<FileEntry[]>('GET', `/workspaces/${a.workspace.id}/files?path=src`);
    expect(nested.map((entry) => entry.path)).toEqual(['src/index.js']);
  });

  it('searches by file name and by content', async () => {
    const byName = await lonca.api('GET', `/workspaces/${a.workspace.id}/search?q=index`);
    expect(byName[0].path).toBe('src/index.js');
    const byContent = await lonca.api('GET', `/workspaces/${a.workspace.id}/search?q=hello&mode=content`);
    expect(byContent[0]).toMatchObject({ path: 'src/index.js', line: 1 });
  });

  it('reports committed, modified and untracked changes against the base branch', async () => {
    const name = a.workspace.sandboxName;
    sandboxExec(name, `cd ${a.workspace.path} && echo '// committed' >> src/index.js && git -c user.name=t -c user.email=t@t commit -qam 'Change' && echo modified >> README.md && printf 'one\\ntwo\\n' > brand-new.txt`);
    const changes = await lonca.api<ChangeSet>('GET', `/workspaces/${a.workspace.id}/changes`);
    const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]));
    expect(byPath['src/index.js']).toMatchObject({ status: 'M', added: 1, removed: 0 });
    expect(byPath['README.md']).toMatchObject({ status: 'M', added: 1 });
    expect(byPath['brand-new.txt']).toMatchObject({ status: '?', added: 2 });
    expect(changes.ahead).toBe(1);
    expect(changes.uncommitted).toBe(2);
    expect((await lonca.workspace(a.workspace.id)).diff).toMatchObject({ files: 3, added: 4 });

    const diff = await lonca.api<string>('GET', `/workspaces/${a.workspace.id}/diff?path=README.md`);
    expect(diff).toContain('+modified');
    const untracked = await lonca.api<string>('GET', `/workspaces/${a.workspace.id}/diff?path=brand-new.txt&untracked=1`);
    expect(untracked).toContain('+two');

    sandboxExec(name, `cd ${a.workspace.path} && git checkout -q README.md && rm brand-new.txt`);
  });

  it('stores attachments under .context', async () => {
    const response = await fetch(`${lonca.url}/api/workspaces/${a.workspace.id}/attachments?name=${encodeURIComponent('../../evil name.png')}`, {
      method: 'POST',
      headers: { ...lonca.headers, 'content-type': 'image/png' },
      body: Buffer.from([1, 2, 3]),
    });
    const attachment = (await response.json()) as { path: string };
    expect(attachment.path).toMatch(/^\.context\/attachments\/\w+\/evil name\.png$/);
    expect(fs.readFileSync(path.join(a.workspace.path, attachment.path))).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('terminals', () => {
  it('opens a shell in the sandbox and survives a reconnect', async () => {
    const info = await lonca.api('POST', `/workspaces/${a.workspace.id}/terminals`);
    const first = await lonca.openTerminal(info.id);
    await until('a prompt', () => first.output().includes('$ '), 10000);
    first.send('echo "whoami=$(whoami) host=$(hostname) cwd=$PWD port=$LONCA_PORT"\n');
    await until('command output', () => first.output().includes('whoami=agent host='), 10000);
    expect(first.output()).toContain(`cwd=${a.workspace.path} port=${a.workspace.port}`);
    first.socket.send(JSON.stringify({ type: 'resize', cols: 123, rows: 45 }));
    // A VM takes a moment to apply it.
    await until('the new size', () => {
      first.send('stty size\n');
      return first.output().includes('45 123');
    }, 10000, 500);
    first.socket.close();

    const second = await lonca.openTerminal(info.id);
    await until('scrollback', () => second.output().includes('whoami='), 5000);
    second.send('exit\n');
    await until('the shell to exit', async () => {
      const state = await lonca.api('GET', '/state');
      return state.terminals.find((entry: { id: string }) => entry.id === info.id)?.status === 'exited';
    }, 10000);
    second.socket.close();
    await lonca.api('DELETE', `/terminals/${info.id}`);
  });

  it('names its prompt after the project and the branch checked out', async () => {
    // Booting again writes the prompt again, without ~/.bashrc sourcing it twice.
    const state = path.join(lonca.home, 'agent-state', a.workspace.id);
    expect(sandboxExec(a.workspace.sandboxName, `bash -c ${quote(SANDBOX_BOOT)} lonca-boot ${quote(state)}`).code).toBe(0);
    expect(sandboxExec(a.workspace.sandboxName, 'grep -c terminal-prompt.sh ~/.bashrc').output.trim()).toBe('1');

    const prompt = (branch: string) => `lonca@${project.slug}-${branch}:${path.basename(a.workspace.path)}$ `;
    const after = (output: string, marker: string) => output.slice(output.lastIndexOf(marker));
    const info = await lonca.api('POST', `/workspaces/${a.workspace.id}/terminals`);
    const terminal = await lonca.openTerminal(info.id);
    await until('the prompt', () => terminal.output().includes(prompt(a.workspace.branch.split('/').at(-1)!)), 10000);
    terminal.send('git switch -q -c someone/elsewhere && echo switched-away\n');
    await until('the prompt on the other branch', () => after(terminal.output(), 'switched-away').includes(prompt('elsewhere')), 10000);
    terminal.send(`git switch -q ${a.workspace.branch} && git branch -q -D someone/elsewhere && echo switched-back\n`);
    await until('the prompt back on its own branch', () => after(terminal.output(), 'switched-back').includes(prompt(a.workspace.branch.split('/').at(-1)!)), 10000);
    terminal.socket.close();
    await lonca.api('DELETE', `/terminals/${info.id}`);
  });

  it('refuses a terminal connection from another site or without the token', async () => {
    const { WebSocket } = await import('ws');
    const attempt = (query: string, origin: string) => new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://localhost:${lonca.port}/ws${query}`, { headers: { origin } });
      socket.on('open', () => {
        socket.close();
        resolve('open');
      });
      socket.on('error', () => resolve('refused'));
    });
    expect(await attempt(`?token=${lonca.token}`, lonca.url)).toBe('open');
    expect(await attempt('', lonca.url)).toBe('refused');
    expect(await attempt('?token=wrong', lonca.url)).toBe('refused');
    expect(await attempt(`?token=${lonca.token}`, 'https://evil.example')).toBe('refused');
    expect(await attempt(`?token=${lonca.token}`, 'http://localhost:20000')).toBe('refused');
  });

  it('runs setup scripts from project settings', async () => {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: 'echo setup-ran > setup.txt; echo finished-setup' } });
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    await until('the setup script', async () => {
      const current = await lonca.workspace(workspace.id);
      return current.steps.find((step) => step.id === 'setup')?.status === 'done';
    }, 30000);
    expect(fs.readFileSync(path.join(workspace.path, 'setup.txt'), 'utf8')).toContain('setup-ran');

    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: 'echo rerun-started; sleep 1000' } });
    const rerun = await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    const terminal = await lonca.openTerminal(rerun.id);
    await until('rerun output', () => terminal.output().includes('rerun-started'), 10000);
    await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
    await until('the rerun to stop', async () => {
      const state = await lonca.api('GET', '/state');
      return state.terminals.find((entry: { id: string }) => entry.id === rerun.id)?.status === 'exited';
    }, 15000);
    expect(sandboxExec(workspace.sandboxName, 'pgrep -f "sleep 1000"').code).not.toBe(0);
    terminal.socket.close();
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: '' } });
  });
});

describe('terminals and scripts, without a restart', () => {
  let workspace: Workspace;
  const setup = async () => (await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup');
  const terminalInfo = async (id: string) => (await lonca.api('GET', '/state')).terminals.find((entry: { id: string }) => entry.id === id);

  beforeAll(async () => {
    // Something a setup script leaves running doesn't change the script's own result. The pause
    // lets the job ignore the hangup the script's terminal sends when the script ends.
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: 'nohup sleep 8 >/dev/null 2>&1 &\nsleep 1\necho started' } });
    workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
  });

  afterAll(async () => {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: '' } });
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('reports a setup script’s result when it ends, even if it left something running', async () => {
    await until('the setup result', async () => (await setup())?.status === 'done', 15000);
    expect(await terminalInfo(`${workspace.id}-setup`)).toMatchObject({ status: 'running', exitCode: 0, jobsOnly: true });
    await until('what it left to end', async () => (await terminalInfo(`${workspace.id}-setup`))?.status === 'exited', 30000);
    expect(await setup()).toMatchObject({ status: 'done' });
    expect(await terminalInfo(`${workspace.id}-setup`)).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('closes an idle shell straight away, as closing a terminal window does', async () => {
    const shell = await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
    const pid = sandboxExec(workspace.sandboxName, `cat /var/tmp/lonca/tty/${shell.id}.pid`).output;
    const started = Date.now();
    await lonca.api('DELETE', `/terminals/${shell.id}`);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(sandboxExec(workspace.sandboxName, `kill -0 ${pid}`).code).not.toBe(0);
  });

  // An idle workspace mustn't cost a command every few seconds. Docker reports each one.
  it.skipIf(REAL_SANDBOX)('runs nothing in an idle workspace to keep an eye on its terminals', async () => {
    const shell = await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
    const connected = await lonca.openTerminal(shell.id);
    try {
      // After the one look for terminals an earlier server left behind.
      await sleep(6000);
      const since = Math.floor(Date.now() / 1000) + 1;
      await sleep(16000);
      const events = docker('events', '--since', String(since), '--until', String(Math.floor(Date.now() / 1000)),
        '--filter', `container=${workspace.sandboxName}`, '--filter', 'event=exec_create', '--format', '{{.Action}}');
      expect(events).toBe('');
    } finally {
      connected.socket.close();
      await lonca.api('DELETE', `/terminals/${shell.id}`);
    }
  });
});

describe('scripts across restarts', () => {
  it('won’t run two copies, whether from a double click or a restart', async () => {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: 'echo started; exec sleep 4321' } });
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    // Anchored, so it doesn't count the shell this very command runs in.
    const copies = () => sandboxExec(workspace.sandboxName, `pgrep -fc '^sleep 4321'`).output;

    await Promise.all([
      lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`),
      lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`),
    ]);
    await until('one copy', () => copies() === '1', 15000);

    await lonca.kill();
    await lonca.start();
    expect(copies()).toBe('1');
    await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
    await sleep(1500);
    await until('one copy after the restart', () => copies() === '1', 15000);

    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: '' } });
  });

  it('recovers the status and Stop control of setup after a restart', async () => {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: "trap '' HUP; sleep 3000" } });
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    await until('setup to start', async () => (await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup')?.status === 'running', 15000);
    await lonca.kill();
    await lonca.start();
    await until('setup recovery', async () => (await lonca.api('GET', '/state')).terminals.some((terminal: { id: string; disconnected?: boolean }) => terminal.id === `${workspace.id}-setup` && terminal.disconnected), 15000);
    expect((await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup')?.status).toBe('running');
    await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
    expect((await lonca.workspace(workspace.id)).steps.find((step) => step.id === 'setup')?.status).toBe('error');
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: '' } });
  });

  it('kills a surviving script that ignores TERM before replacing its PID file', async () => {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: "trap '' TERM; exec sleep 43219" } });
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    const pids = () => sandboxExec(workspace.sandboxName, "pgrep -f '^sleep 43219$'").output.split('\n').filter(Boolean);
    try {
      await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
      await until('the original script', () => pids().length === 1, 15000);
      const originalPid = pids()[0];
      await lonca.kill();
      await lonca.start();
      expect(pids()).toEqual([originalPid]);
      await lonca.api('POST', `/workspaces/${workspace.id}/scripts/setup`);
      await until('the replacement script', () => pids().length === 1 && pids()[0] !== originalPid, 15000);
      await lonca.api('DELETE', `/workspaces/${workspace.id}/scripts/setup`);
      await until('the replacement to stop', () => pids().length === 0, 15000);
    } finally {
      await lonca.api('DELETE', `/workspaces/${workspace.id}`);
      await lonca.api('PATCH', `/projects/${project.id}`, { settings: { setupScript: '' } });
    }
  });
});

describe('agents', () => {
  let agentProject: Project;
  let workspace: Workspace;
  let claudeSession: Session;

  beforeAll(async () => {
    // The mock runs on the host, so this project opts in to host access.
    agentProject = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: makeFixtureRepo() })).id);
    await lonca.api('PATCH', `/projects/${agentProject.id}`, {
      settings: {
        network: 'host',
        env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock', MOCK_KEY: 'sk-mock' },
      },
    });
    const created = await lonca.api('POST', `/projects/${agentProject.id}/workspaces`, {});
    claudeSession = created.session;
    workspace = await lonca.waitForWorkspace(created.workspace.id);
    sandboxExec(workspace.sandboxName, `cat > ~/.codex/config.toml <<EOF
cli_auth_credentials_store = "file"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://host.docker.internal:${mock.port}/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
supports_websockets = false
EOF`);
  });

  it('reports sign-in status for both CLIs', async () => {
    const state = await until('status checks', async () => {
      const current = await lonca.api('GET', '/state');
      return current.catalog.codex.models.length > 1 ? current : null;
    }, 60000);
    expect(state.system.agents.claude.signedIn).toBe(false);
    expect(state.system.agents.codex.signedIn).toBe(false);
    expect(state.catalog.claude.models.map((model: { id: string }) => model.id)).toContain('claude-opus-5-5');
    for (const model of state.catalog.codex.models) expect(model.efforts.length).toBeGreaterThan(0);
  });

  it('runs a Claude turn in the container, streaming tools and text', async () => {
    const seen: string[] = [];
    const events = new (await import('ws')).WebSocket(`ws://localhost:${lonca.port}/ws?token=${lonca.token}`, { headers: { origin: lonca.url } });
    events.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'chat.delta' && event.sessionId === claudeSession.id) seen.push(event.text);
    });
    await new Promise((resolve) => events.on('open', resolve));

    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'THINK first. RUN: echo from-claude > claude.txt && ls', attachments: [] });
    const items = await lonca.waitForIdle(claudeSession.id);
    events.close();

    expect(items[0]).toMatchObject({ type: 'user' });
    expect(items.some((item) => item.type === 'thinking')).toBe(true);
    const [tool] = tools(items);
    expect(tool).toMatchObject({ kind: 'command', status: 'done', detail: 'echo from-claude > claude.txt && ls' });
    expect(tool.output).toContain('claude.txt');
    expect(texts(items).at(-1)).toBe('The command finished.');
    expect(items.at(-1)).toMatchObject({ type: 'result', failed: false });
    expect(seen.join('')).toContain('The command finished.');
    expect(fs.readFileSync(path.join(workspace.path, 'claude.txt'), 'utf8').trim()).toBe('from-claude');

    const session = await lonca.session(claudeSession.id);
    expect(session.resumeId).toBeTruthy();
    expect((await lonca.workspace(workspace.id)).title).toContain('THINK first');
    expect(mock.requests.some((request) => request.model === 'claude-opus-5-5')).toBe(true);
  });

  it('resumes the same Claude conversation on the next turn', async () => {
    const before = await lonca.session(claudeSession.id);
    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'second turn', attachments: [] });
    const items = await lonca.waitForIdle(claudeSession.id);
    expect(texts(items).at(-1)).toContain('You said: second turn');
    expect((await lonca.session(claudeSession.id)).resumeId).toBe(before.resumeId);
  });

  it('passes the chosen model and effort to the CLI', async () => {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude' });
    await lonca.api('PATCH', `/sessions/${session.id}`, { model: 'claude-sonnet-5-5', effort: 'low' });
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'model check', attachments: [] });
    await lonca.waitForIdle(session.id);
    expect(mock.requests.at(-1)?.model).toBe('claude-sonnet-5-5');
    expect((await lonca.session(session.id)).title).toBe('model check');
  });

  it('runs a Codex turn in the container and resumes it', async () => {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'codex' });
    expect(session.agent).toBe('codex');
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'RUN: echo from-codex > codex.txt && ls', attachments: [] });
    const items = await lonca.waitForIdle(session.id);
    const [tool] = tools(items);
    expect(tool).toMatchObject({ kind: 'command', status: 'done', detail: 'echo from-codex > codex.txt && ls' });
    expect(texts(items).at(-1)).toBe('The command finished.');
    expect(items.at(-1)).toMatchObject({ type: 'result' });
    expect(fs.readFileSync(path.join(workspace.path, 'codex.txt'), 'utf8').trim()).toBe('from-codex');

    const resumeId = (await lonca.session(session.id)).resumeId;
    expect(resumeId).toBeTruthy();
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'second codex turn', attachments: [] });
    const next = await lonca.waitForIdle(session.id);
    expect(texts(next).at(-1)).toContain('You said: second codex turn');
    expect((await lonca.session(session.id)).resumeId).toBe(resumeId);
  });

  it('keeps conversations through a rebuild, which replaces a sandbox’s disk', async () => {
    const codex = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'codex' });
    await lonca.api('POST', `/sessions/${codex.id}/messages`, { text: 'before the rebuild', attachments: [] });
    await lonca.waitForIdle(codex.id);
    const codexThread = (await lonca.session(codex.id)).resumeId;
    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'before the rebuild', attachments: [] });
    await lonca.waitForIdle(claudeSession.id);
    const claudeThread = (await lonca.session(claudeSession.id)).resumeId;

    await lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
    // The mock's address is in this file, which isn't a conversation and goes with the disk.
    sandboxExec(workspace.sandboxName, `grep -q mock ~/.codex/config.toml || cat > ~/.codex/config.toml <<EOF
cli_auth_credentials_store = "file"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://host.docker.internal:${mock.port}/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
supports_websockets = false
EOF`);

    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'after the rebuild', attachments: [] });
    const claude = await lonca.waitForIdle(claudeSession.id);
    expect(texts(claude).at(-1)).toContain('You said: after the rebuild');
    expect(claude.filter((item) => item.type === 'notice')).toEqual([]);
    expect((await lonca.session(claudeSession.id)).resumeId).toBe(claudeThread);

    await lonca.api('POST', `/sessions/${codex.id}/messages`, { text: 'after the rebuild', attachments: [] });
    const items = await lonca.waitForIdle(codex.id);
    expect(texts(items).at(-1)).toContain('You said: after the rebuild');
    expect((await lonca.session(codex.id)).resumeId).toBe(codexThread);
  });

  it('won’t switch a started conversation to another agent', async () => {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude' });
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'started', attachments: [] });
    await lonca.waitForIdle(session.id);
    await expect(lonca.api('PATCH', `/sessions/${session.id}`, { agent: 'codex' })).rejects.toThrow(/Open a new tab/);
  });

  it('interrupts a running turn and can continue afterwards', async () => {
    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'SLOW answer please', attachments: [] });
    await until('the turn to start', async () => (await lonca.session(claudeSession.id)).status === 'running', 10000);
    await sleep(1500);
    await lonca.api('POST', `/sessions/${claudeSession.id}/interrupt`);
    const items = await lonca.waitForIdle(claudeSession.id, 15000);
    expect(items.at(-1)).toMatchObject({ type: 'result', interrupted: true });
    expect(sandboxExec(workspace.sandboxName, 'pgrep -f "claude -p"').code).not.toBe(0);

    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'after the interrupt', attachments: [] });
    const after = await lonca.waitForIdle(claudeSession.id);
    expect(texts(after).at(-1)).toContain('You said: after the interrupt');
  });

  it('queues messages sent during a turn and runs them in order', async () => {
    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'SLOW first', attachments: [] });
    await until('the turn to start', async () => (await lonca.session(claudeSession.id)).status === 'running', 10000);
    const queued = await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'queued second', attachments: [] });
    expect(queued.queued).toBe(true);
    const cancelled = await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'queued and cancelled', attachments: [] });
    await lonca.api('DELETE', `/sessions/${claudeSession.id}/queue/${cancelled.id}`);
    const items = await lonca.waitForIdle(claudeSession.id, 60000);
    expect(texts(items).at(-1)).toContain('You said: queued second');
    expect(JSON.stringify(items)).not.toContain('queued and cancelled');
  });

  it('honours a stop pressed before the agent has even launched', async () => {
    const send = lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'SLOW stop me right away', attachments: [] });
    await send;
    await lonca.api('POST', `/sessions/${claudeSession.id}/interrupt`);
    const items = await lonca.waitForIdle(claudeSession.id, 15000);
    expect(items.at(-1)).toMatchObject({ type: 'result', interrupted: true });
    expect(sandboxExec(workspace.sandboxName, 'pgrep -f "claude -p"').code).not.toBe(0);
  });

  it('keeps an agent running across a server crash and picks its output back up', async () => {
    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'SLOW survive the restart', attachments: [] });
    await until('the turn to start', async () => (await lonca.session(claudeSession.id)).status === 'running', 10000);
    await sleep(1000);
    await lonca.kill();
    await sleep(1000);
    expect(sandboxExec(workspace.sandboxName, 'pgrep -f "claude -p"').code).toBe(0);
    await lonca.start();
    const items = await lonca.waitForIdle(claudeSession.id, 60000);
    expect(texts(items).at(-1)).toContain('You said: SLOW survive the restart');
    expect(items.at(-1)).toMatchObject({ type: 'result' });
    expect((items.at(-1) as { interrupted?: boolean }).interrupted).toBeFalsy();
  });

  it('keeps chat history across a restart', async () => {
    await lonca.kill();
    await lonca.start();
    const items = await lonca.items(claudeSession.id);
    expect(texts(items).some((text) => text.includes('after the interrupt'))).toBe(true);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('holds messages through a restart after Stop', async () => {
    const conversation = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude' });
    await lonca.api('POST', `/sessions/${conversation.id}/messages`, { text: 'SLOW going to be stopped', attachments: [] });
    await until('the turn to start', async () => (await lonca.session(conversation.id)).status === 'running', 10000);
    const held = await lonca.api('POST', `/sessions/${conversation.id}/messages`, { text: 'held through a restart', attachments: [] });
    await lonca.api('POST', `/sessions/${conversation.id}/interrupt`);
    await until('the turn to stop', async () => (await lonca.session(conversation.id)).status === 'idle', 15000);
    expect((await lonca.session(conversation.id)).held).toBe(true);
    await lonca.kill();
    await lonca.start();
    await sleep(2500);
    const session = await lonca.session(conversation.id);
    expect(session.status).toBe('idle');
    expect(session.queue).toEqual([held.id]);
    await lonca.api('DELETE', `/sessions/${conversation.id}/queue/${held.id}`);
    expect((await lonca.session(conversation.id)).held).toBeFalsy();
  });

  it('survives hostile files in a run’s own directory', async () => {
    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'SLOW plant things', attachments: [] });
    const running = await until('the turn to start', async () => {
      const session = await lonca.session(claudeSession.id);
      return session.status === 'running' && sandboxExec(workspace.sandboxName, `test -f /var/tmp/lonca/agent-runs/${session.activeRunId}/pid`).code === 0 ? session : null;
    }, 15000);
    const dir = `/var/tmp/lonca/agent-runs/${running.activeRunId}`;
    // An enormous line, and an exit file that's really /dev/zero.
    sandboxExec(workspace.sandboxName, `ln -sf /dev/zero ${dir}/exit.tmp; head -c 40000000 /dev/zero | tr '\\0' x >> ${dir}/out.jsonl; echo >> ${dir}/out.jsonl`);
    await sleep(1000);
    expect((await fetch(`${lonca.url}/api/state`, { headers: lonca.headers })).status).toBe(200);
    await lonca.api('POST', `/sessions/${claudeSession.id}/interrupt`);
    await until('the turn to end', async () => (await lonca.session(claudeSession.id)).status === 'idle', 30000);
    expect((await fetch(`${lonca.url}/api/state`, { headers: lonca.headers })).status).toBe(200);
  });

  it('gets a session back when its pid file is a FIFO that would hang any read', async () => {
    await lonca.api('POST', `/sessions/${claudeSession.id}/messages`, { text: 'SLOW sabotage my tracking', attachments: [] });
    const running = await until('the turn to start', async () => {
      const session = await lonca.session(claudeSession.id);
      return session.status === 'running' && sandboxExec(workspace.sandboxName, `test -f /var/tmp/lonca/agent-runs/${session.activeRunId}/pid`).code === 0 ? session : null;
    }, 15000);
    const dir = `/var/tmp/lonca/agent-runs/${running.activeRunId}`;
    // Checked before the agent goes, since Lonca can then remove its run directory at any moment.
    // Anchored, so it doesn't kill the shell this very command runs in.
    expect(sandboxExec(workspace.sandboxName, `rm -f ${dir}/pid && mkfifo ${dir}/pid && test -p ${dir}/pid && pkill -f '^claude -p'`).code).toBe(0);
    await lonca.api('POST', `/sessions/${claudeSession.id}/interrupt`);
    await until('the session to recover', async () => (await lonca.session(claudeSession.id)).status === 'idle', 60000);
  });

  // A turn cut off before the CLI saved its conversation leaves an ID the CLI can't continue.
  it.each([
    { agent: 'claude', history: '~/.claude/projects/*' },
    { agent: 'codex', history: '~/.codex/sessions/*' },
  ] as const)('starts afresh, and says so, when $agent can no longer find a conversation', async ({ agent, history }) => {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent });
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'the first message', attachments: [] });
    await lonca.waitForIdle(session.id);
    const lost = (await lonca.session(session.id)).resumeId;
    expect(lost).toBeTruthy();
    sandboxExec(workspace.sandboxName, `rm -rf ${history}`);
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'after it was lost', attachments: [] });
    const items = await lonca.waitForIdle(session.id);
    const latest = items.slice(items.findLastIndex((item) => item.type === 'user'));
    expect(texts(latest).at(-1)).toContain('You said: after it was lost');
    expect(latest.at(-1)).toMatchObject({ type: 'result' });
    expect((latest.at(-1) as { failed?: boolean }).failed).toBeFalsy();
    expect(items.some((item) => item.type === 'notice' && item.level === 'info' && /couldn’t be loaded/.test(item.text))).toBe(true);
    expect(latest.some((item) => item.type === 'notice' && item.level === 'error')).toBe(false);
    const resumed = (await lonca.session(session.id)).resumeId;
    expect(resumed).toBeTruthy();
    expect(resumed).not.toBe(lost);
  });

  it('deletes a closed conversation from disk', async () => {
    const session = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, {});
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'soon forgotten', attachments: [] });
    await lonca.waitForIdle(session.id);
    const file = path.join(lonca.home, 'sessions', `${session.id}.jsonl`);
    expect(fs.existsSync(file)).toBe(true);
    await lonca.api('DELETE', `/sessions/${session.id}`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('explains what to do when an agent is not signed in', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const ws = await lonca.waitForWorkspace(created.workspace.id);
    await lonca.api('POST', `/sessions/${created.session.id}/messages`, { text: 'hello', attachments: [] });
    const items = await lonca.waitForIdle(created.session.id, 60000);
    expect(items.find((item) => item.type === 'notice')).toMatchObject({ level: 'error', code: 'auth', text: expect.stringMatching(/not logged in/i) });
    expect(items.at(-1)).toMatchObject({ type: 'result', failed: true });
    await lonca.api('DELETE', `/workspaces/${ws.id}`);
  });
});

describe('signing in', () => {
  let signInProject: Project;
  let workspace: Workspace;
  let session: Session;
  const agents = async () => (await lonca.api('GET', '/state')).system.agents;

  beforeAll(async () => {
    // Only the URL points at the mock; the credentials are the ones Lonca was given.
    signInProject = await lonca.waitForProject((await lonca.api<Project>('POST', '/projects', { path: makeFixtureRepo() })).id);
    await lonca.api('PATCH', `/projects/${signInProject.id}`, {
      settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}` } },
    });
    const created = await lonca.api('POST', `/projects/${signInProject.id}/workspaces`, {});
    session = created.session;
    workspace = await lonca.waitForWorkspace(created.workspace.id);
  });

  afterAll(async () => {
    await lonca.api('DELETE', `/projects/${signInProject.id}`);
  });

  it('saves a Claude token for the proxy, wherever line wrapping broke it, and keeps it out of the workspace', async () => {
    await lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-oat01-not\n-a-real-token ' });
    expect((await agents()).claude.signedIn).toBe(true);
    expect((await lonca.api('GET', '/state')).secrets.claudeToken).toBe('••••oken');
    expect(fs.readFileSync(path.join(lonca.home, 'boundary', 'claude'), 'utf8')).toBe('sk-ant-oat01-not-a-real-token');
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'signed in now', attachments: [] });
    const items = await lonca.waitForIdle(session.id);
    // The mock isn't a host the proxy adds it for, so what leaves the VM is still the placeholder.
    expect(texts(items).at(-1)).toContain('You said: signed in now');
    expect(mock.requests.filter((request) => request.path.endsWith('/messages')).at(-1)?.auth).toBe('Bearer sk-ant-oat01-lonca-placeholder');
    expect(REAL_SANDBOX ? sbx('ls', '--json') : docker('inspect', workspace.sandboxName)).not.toContain('not-a-real-token');
  });

  it('treats anything else as an Anthropic API key', async () => {
    await lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-api03-not-a-real-key' });
    await lonca.api('POST', `/sessions/${session.id}/messages`, { text: 'with a key', attachments: [] });
    await lonca.waitForIdle(session.id);
    expect(mock.requests.filter((request) => request.path.endsWith('/messages')).at(-1)?.auth).toBe('sk-ant-oat01-lonca-placeholder');
  });

  // Costs nothing: the real service turns the made-up token down. Which way it does shows what arrived.
  it.runIf(REAL_SANDBOX)('gets a sign-in token to the real service through the sandbox’s proxy', async () => {
    await lonca.api('PATCH', `/projects/${signInProject.id}`, { settings: { env: {} } });
    try {
      await lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-oat01-not-a-real-token' });
      const real = await lonca.api<Session>('POST', `/workspaces/${workspace.id}/sessions`, { agent: 'claude' });
      await lonca.api('POST', `/sessions/${real.id}/messages`, { text: 'hello', attachments: [] });
      const items = await lonca.waitForIdle(real.id, 60000);
      const refusal = items.find((item) => item.type === 'notice');
      expect(refusal, JSON.stringify(items)).toMatchObject({ code: 'auth' });
      expect(JSON.stringify(refusal)).not.toMatch(/invalid api key/i);
    } finally {
      await lonca.api('PATCH', `/projects/${signInProject.id}`, { settings: { env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}` } } });
    }
  });

  it('signs out of Claude', async () => {
    await lonca.api('POST', '/agents/claude/logout');
    expect((await agents()).claude.signedIn).toBe(false);
    expect((await lonca.api('GET', '/state')).secrets.claudeToken).toBeNull();
  });

  it('refuses something that isn’t a key, without saving it', async () => {
    await expect(lonca.api('PUT', '/secrets/claude', { token: 'BMp0bJmrftqKRaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#bbbbbbbbbbbbbbbbbbbbbb' }))
      .rejects.toThrow(/isn’t a key/);
    await expect(lonca.api('PUT', '/agents/codex/api-key', { key: 'FAKE-7CODE' })).rejects.toThrow(/isn’t an API key/);
    expect((await agents()).claude.signedIn).toBe(false);
    expect((await lonca.api('GET', '/state')).secrets.claudeToken).toBeNull();
  });

  it('tries a key with the real service before calling it signed in', async () => {
    lonca.env = { LONCA_SKIP_CREDENTIAL_CHECK: '0' };
    await lonca.kill();
    await lonca.start();
    try {
      await expect(lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-api03-not-a-real-key' })).rejects.toThrow(/didn’t accept this key/);
      await expect(lonca.api('PUT', '/agents/codex/api-key', { key: 'sk-not-a-real-key-for-testing' })).rejects.toThrow(/didn’t accept this key/);
      const state = await lonca.api('GET', '/state');
      expect(state.secrets.claudeToken).toBeNull();
      expect(state.system.agents.claude.signedIn).toBe(false);
      expect(state.system.agents.codex.signedIn).toBe(false);
    } finally {
      lonca.env = {};
      await lonca.kill();
      await lonca.start();
    }
  });

  it('marks an agent as refused when the real service turns down its key', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const ws = await lonca.waitForWorkspace(created.workspace.id);
    // A made-up key against the real API: it costs nothing and gives the real error.
    await lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-api03-not-a-real-key' });
    expect((await agents()).claude).toMatchObject({ signedIn: true });
    await lonca.api('POST', `/sessions/${created.session.id}/messages`, { text: 'hello', attachments: [] });
    const items = await lonca.waitForIdle(created.session.id, 60000);
    expect(items.find((item) => item.type === 'notice')).toMatchObject({ level: 'error', code: 'auth', text: expect.stringMatching(/invalid api key/i) });
    expect((await agents()).claude).toMatchObject({ signedIn: true, rejected: true });
    await lonca.api('POST', '/agents/claude/logout');
    expect((await agents()).claude.rejected).toBeFalsy();
    await lonca.api('DELETE', `/workspaces/${ws.id}`);
  });

  it('carries on in the same tab after a turn failed on its sign-in', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const ws = await lonca.waitForWorkspace(created.workspace.id);
    try {
      // Claude: the real API refuses a made-up key, then the next turn has working credentials.
      await lonca.api('PATCH', `/projects/${project.id}`, { settings: { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key' } } });
      await lonca.api('POST', `/sessions/${created.session.id}/messages`, { text: 'first try', attachments: [] });
      const failed = await lonca.waitForIdle(created.session.id, 60000);
      expect(failed.find((item) => item.type === 'notice')).toMatchObject({ code: 'auth' });
      expect((await lonca.session(created.session.id)).resumeId).toBeTruthy();

      await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${mock.port}`, ANTHROPIC_API_KEY: 'sk-mock', CODEX_API_KEY: 'sk-mock' } } });
      await lonca.api('POST', `/workspaces/${ws.id}/recreate`);
      const before = mock.requests.length;
      await lonca.api('POST', `/sessions/${created.session.id}/messages`, { text: 'second try', attachments: [] });
      const claude = await lonca.waitForIdle(created.session.id, 60000);
      expect(texts(claude).at(-1)).toContain('Mock Claude here.');
      const request = mock.requests.slice(before).findLast((entry) => entry.path.endsWith('/messages') && entry.body.includes('You are the Lead'))!;
      const messages = JSON.parse(request.body).messages as { role: string; content: unknown }[];
      expect(JSON.stringify(messages.filter((entry) => entry.role === 'user').at(-1))).toContain('second try');
      expect(claude.at(-1)).toMatchObject({ type: 'result', failed: false });

      // Codex won't resume a conversation under another provider, so this keeps the built-in
      // one and only moves its address. The mock refuses the first turn as the real API does.
      sandboxExec(ws.sandboxName, `printf 'cli_auth_credentials_store = "file"\nopenai_base_url = "http://host.docker.internal:${mock.port}/v1"\n' > ~/.codex/config.toml`);
      mock.refuseCodex = true;
      const codexSession = await lonca.api<Session>('POST', `/workspaces/${ws.id}/sessions`, { agent: 'codex' });
      await lonca.api('POST', `/sessions/${codexSession.id}/messages`, { text: 'first try', attachments: [] });
      const refused = await lonca.waitForIdle(codexSession.id, 120000);
      expect(refused.find((item) => item.type === 'notice' && item.code === 'auth')).toBeTruthy();
      const thread = (await lonca.session(codexSession.id)).resumeId;
      expect(thread).toBeTruthy();

      mock.refuseCodex = false;
      await lonca.api('POST', `/sessions/${codexSession.id}/messages`, { text: 'second try', attachments: [] });
      const codex = await lonca.waitForIdle(codexSession.id, 120000);
      expect(texts(codex).at(-1)).toContain('You said: second try');
      expect(codex.at(-1)).toMatchObject({ type: 'result' });
      expect((await lonca.session(codexSession.id)).resumeId).toBe(thread);
    } finally {
      mock.refuseCodex = false;
      await lonca.api('DELETE', `/workspaces/${ws.id}`);
      await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'internet', env: {} } });
      await lonca.api('POST', '/agents/claude/logout');
    }
  });

  it('doesn’t take a login left in the helper for the sign-in, and clears away what a cut-off sign-in left', async () => {
    const tools = await lonca.startHelper();
    const left = `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-not-a-real-key-for-testing"}`;
    const cutOff = '/var/tmp/lonca/tty/login-codex-cutoff';
    sandboxExec(tools, `printf '%s' '${left}' > ~/.codex/auth.json && mkdir ${cutOff} && printf '%s' '${left}' > ${cutOff}/auth.json`);
    await lonca.kill();
    await lonca.start();
    await until('the sign-in that was cut off to go', () => sandboxExec(tools, `test -e ${cutOff}`).code !== 0, 60000);
    await lonca.api('POST', '/agents/refresh');
    expect((await agents()).codex.signedIn).toBe(false);
    expect(fs.existsSync(path.join(lonca.home, 'boundary', 'codex'))).toBe(false);
    sandboxExec(tools, 'rm -f ~/.codex/auth.json');
  });

  it('doesn’t take a login someone ran by hand in a workspace as the sign-in', async () => {
    sandboxExec(workspace.sandboxName, `rm -f ~/.codex/auth.json && printf '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-not-a-real-key-for-testing"}' > ~/.codex/auth.json`);
    await lonca.api('POST', '/agents/refresh');
    expect((await agents()).codex.signedIn).toBe(false);
    expect(fs.existsSync(path.join(lonca.home, 'boundary', 'codex'))).toBe(false);
  });

  it('saves an API key for Codex, for the proxy, and signs out of it', async () => {
    const forProxy = path.join(lonca.home, 'boundary', 'codex');
    await lonca.api('PUT', '/agents/codex/api-key', { key: 'sk-not-a-real-key-for-testing' });
    expect((await agents()).codex.signedIn).toBe(true);
    expect(fs.readFileSync(forProxy, 'utf8')).toBe('sk-not-a-real-key-for-testing');
    expect(fs.statSync(forProxy).mode & 0o777).toBe(0o600);
    await lonca.api('POST', '/agents/codex/logout');
    expect((await agents()).codex.signedIn).toBe(false);
    expect(fs.existsSync(forProxy)).toBe(false);
  });
});

describe('the real sign-in flows', () => {
  const tools = () => `${lonca.prefix}-tools`;
  const login = async (agent: string): Promise<LoginState | undefined> => (await lonca.api('GET', '/state')).logins[agent];
  const reached = (agent: string, phase: string, timeout = 30000) => until(`${agent} sign-in to reach ${phase}`, async () => {
    const current = await login(agent);
    if (current?.phase === 'failed' && phase !== 'failed') throw new Error(`failed: ${current.failure}\n${current.output}`);
    return current?.phase === phase ? current : null;
  }, timeout);
    /** The paste page shows up a few seconds into the sign-in, when Claude has got to its prompt. */
  const readyForCode = () => until('Claude to be ready for a code', async () => {
    const current = await reached('claude', 'waiting');
    return current.pasteUrl ? current : null;
  });
  /** Finishing is reported before what it left in the helper has gone. */
  const helperHoldsNoLogin = () => until('the helper to hold no login', () => {
    const found = sandboxExec(tools(), `find ~/.codex /var/tmp/lonca/tty -name auth.json -o -name 'login-codex-*'`);
    return found.code === 0 && found.output.trim() === '';
  }, 20000);
  /** The CLIs alone, since what started them has the same words in its arguments. */
  const codexClis = () => sandboxExec(tools(), `pgrep -fc '^[^ ]*codex(.real)? login'`);
  /** What a browser is sent to when the sign-in page is done with it. */
  const comeBack = (link: string, query = 'code=fakecode') => {
    const url = new URL(link);
    return `${url.searchParams.get('redirect_uri')}?${query}&state=${url.searchParams.get('state')}`;
  };
  let frames: string[];
  let events: import('ws').WebSocket;

  beforeAll(async () => {
    await lonca.startHelper();
    installFakeSignIn(tools());
    await sleep(500);
    frames = [];
    events = new (await import('ws')).WebSocket(`ws://localhost:${lonca.port}/ws?token=${lonca.token}`, { headers: { origin: lonca.url } });
    events.on('message', (data) => frames.push(data.toString()));
    await new Promise((resolve) => events.on('open', resolve));
  });

  afterAll(() => {
    events.close();
    removeFakeSignIn(tools());
  });

  it('signs in to Claude with the real CLI, and the token never reaches the browser', async () => {
    setFakeSignIn(tools(), { mode: 'ok' });
    const started = await lonca.api<LoginState>('POST', '/agents/claude/login');
    expect(started.phase).toBe('starting');
    const waiting = await readyForCode();
    expect(new URL(waiting.url!).hostname).toBe('claude.com');
    expect(new URL(waiting.pasteUrl!).hostname).toBe('claude.com');
    expect(waiting.url).toContain('state=');

    const state = new URL(waiting.pasteUrl!).searchParams.get('state');
    await lonca.api('POST', '/agents/claude/login/code', { code: `fakecode#${state}` });
    const done = await reached('claude', 'done');
    expect(done.url).toBeUndefined();

    const token = `sk-ant-oat01-${'FakeTokenForTesting_-'.repeat(4)}zzzzzzzAA`;
    expect(JSON.parse(fs.readFileSync(path.join(lonca.home, 'secrets.json'), 'utf8')).claudeToken).toBe(token);
    const all = await lonca.api('GET', '/state');
    expect(all.system.agents.claude).toMatchObject({ signedIn: true, summary: 'Signed in with your Claude subscription', usesKey: false });
    // Everything the browser could have been sent.
    expect(frames.join('\n')).not.toContain('sk-ant-oat');
    expect(JSON.stringify(all)).not.toContain('sk-ant-oat');
    expect(await lonca.api('GET', '/agents/claude/login/output')).not.toContain('sk-ant-oat');
    await lonca.api('DELETE', '/agents/claude/login');
    expect(await login('claude')).toBeUndefined();
    await lonca.api('POST', '/agents/claude/logout');
  });

  it('signs in to Claude with the browser coming back to the real CLI, and tells it how it went', async () => {
    setFakeSignIn(tools(), { mode: 'ok' });
    await lonca.api('POST', '/agents/claude/login');
    const waiting = await reached('claude', 'waiting');
    const back = comeBack(waiting.url!);
    expect(back).toMatch(/^http:\/\/localhost:\d+\/callback\?/);

    // Only the sign-in page knows the state, so nothing else reaches the CLI.
    const port = new URL(back).port;
    expect((await fetch(`http://127.0.0.1:${port}/callback?code=fakecode&state=wrong`)).status).toBe(404);
    expect((await login('claude'))?.phase).toBe('waiting');

    const answer = await fetch(back);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('You’re signed in');
    expect((await login('claude'))?.phase).toBe('done');
    const token = `sk-ant-oat01-${'FakeTokenForTesting_-'.repeat(4)}zzzzzzzAA`;
    expect(JSON.parse(fs.readFileSync(path.join(lonca.home, 'secrets.json'), 'utf8')).claudeToken).toBe(token);
    expect(frames.join('\n')).not.toContain('sk-ant-oat');
    await expect(fetch(back)).rejects.toThrow();
    expect(sandboxExec(tools(), `pgrep -fc 'setup-token'`).code).not.toBe(0);
    await lonca.api('DELETE', '/agents/claude/login');
    await lonca.api('POST', '/agents/claude/logout');
  });

  it('tells a browser that came back when the real CLI failed', async () => {
    setFakeSignIn(tools(), { mode: 'rejected' });
    await lonca.api('POST', '/agents/claude/login');
    const waiting = await reached('claude', 'waiting');
    const answer = await fetch(comeBack(waiting.url!));
    expect(await answer.text()).toContain('didn’t finish');
    expect((await login('claude'))).toMatchObject({ phase: 'failed', failure: 'rejected' });
    expect(JSON.parse(fs.readFileSync(path.join(lonca.home, 'secrets.json'), 'utf8')).claudeToken).toBeUndefined();
    await lonca.api('DELETE', '/agents/claude/login');
    setFakeSignIn(tools(), { mode: 'ok' });
  });

  it('reports a code the real CLI refuses, and starts over cleanly', async () => {
    setFakeSignIn(tools(), { mode: 'rejected' });
    await lonca.api('POST', '/agents/claude/login');
    const waiting = await readyForCode();
    const state = new URL(waiting.pasteUrl!).searchParams.get('state');
    await lonca.api('POST', '/agents/claude/login/code', { code: `wrongcode#${state}` });
    const failed = await reached('claude', 'failed', 30000);
    expect(failed.failure).toBe('rejected');
    expect(failed.output).toContain('wasn');
    expect(sandboxExec(tools(), `pgrep -fc 'setup-token'`).code).not.toBe(0);

    setFakeSignIn(tools(), { mode: 'ok' });
    await lonca.api('POST', '/agents/claude/login');
    await reached('claude', 'waiting');
    await lonca.api('DELETE', '/agents/claude/login');
    expect(sandboxExec(tools(), `pgrep -fc 'setup-token'`).code).not.toBe(0);
  });

  it('turns away a code from another sign-in, or a key in the code box', async () => {
    await lonca.api('POST', '/agents/claude/login');
    await readyForCode();
    await expect(lonca.api('POST', '/agents/claude/login/code', { code: 'code#from-an-older-tab' })).rejects.toThrow(/earlier sign-in/);
    await expect(lonca.api('POST', '/agents/claude/login/code', { code: 'sk-ant-api03-a-key-pasted-here' })).rejects.toThrow(/a key, not a sign-in code/);
    await expect(lonca.api('POST', '/agents/claude/login/code', { code: 'x\u001b[201~rm -rf /' })).rejects.toThrow(/doesn’t look like a sign-in code/);
    expect((await login('claude'))?.phase).toBe('waiting');
    await lonca.api('DELETE', '/agents/claude/login');
  });

  it('joins a sign-in already under way, rather than starting a second CLI', async () => {
    await Promise.all([lonca.api('POST', '/agents/claude/login'), lonca.api('POST', '/agents/claude/login')]);
    await reached('claude', 'waiting');
    expect(sandboxExec(tools(), `pgrep -fc '^/usr/local/bin/claude.real setup-token|^claude setup-token'`).output).toBe('1');
    await lonca.api('DELETE', '/agents/claude/login');
  });

  it('cleans up a sign-in the server was following when it restarted', async () => {
    await lonca.api('POST', '/agents/claude/login');
    await reached('claude', 'waiting');
    await lonca.kill();
    await lonca.start();
    await until('the old CLI to go', () => sandboxExec(tools(), `pgrep -fc 'setup-token'`).code !== 0, 20000);
    expect(await login('claude')).toBeUndefined();
  });

  it('signs in to Codex with the browser coming back to the real CLI, for the proxy to use and out of reach of workspaces', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const ws = await lonca.waitForWorkspace(created.workspace.id);
    const forProxy = path.join(lonca.home, 'boundary', 'codex');
    setFakeSignIn(tools(), { mode: 'ok' });
    await lonca.api('POST', '/agents/codex/login');
    const waiting = await reached('codex', 'waiting');
    expect(new URL(waiting.url!).hostname).toBe('auth.openai.com');
    const back = comeBack(waiting.url!);
    expect(back).toMatch(/^http:\/\/127\.0\.0\.1:1455\/auth\/callback\?/);

    // These would end the real CLI's sign-in, the second one by saying it worked.
    for (const route of ['cancel', 'success']) expect((await fetch(`http://127.0.0.1:1455/${route}`)).status).toBe(404);
    expect((await login('codex'))?.phase).toBe('waiting');
    expect(sandboxExec(tools(), `pgrep -fc 'codex.real login|codex login'`).code).toBe(0);

    const answer = await fetch(back);
    expect(await answer.text()).toContain('You’re signed in');
    expect(answer.url).toBe(back);
    expect((await login('codex'))?.phase).toBe('done');
    expect((await lonca.api('GET', '/state')).system.agents.codex).toMatchObject({ signedIn: true, summary: 'Signed in with ChatGPT as probe@example.com' });
    expect(codexClis().code).not.toBe(0);
    await helperHoldsNoLogin();
    await expect(fetch(back)).rejects.toThrow();

    // The CLI got an API key while signing in. What's kept is what a one-time code leaves.
    const saved = path.join(lonca.home, 'helper-credentials', 'codex', 'auth.json');
    const kept = JSON.parse(fs.readFileSync(saved, 'utf8'));
    expect(kept).toMatchObject({ auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    expect(kept.tokens.refresh_token).toBeTruthy();
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    const token = fs.readFileSync(forProxy, 'utf8');
    expect(token).toBe(kept.tokens.access_token);
    expect(sandboxExec(ws.sandboxName, 'cat ~/.codex/auth.json 2>/dev/null; env').output).not.toContain(token);

    // Starting another sign-in and cancelling it must not sign out.
    await lonca.api('POST', '/agents/codex/login');
    await reached('codex', 'waiting');
    await lonca.api('DELETE', '/agents/codex/login');
    await helperHoldsNoLogin();
    expect(fs.readFileSync(forProxy, 'utf8')).toBe(token);
    await expect(fetch(back)).rejects.toThrow();

    await lonca.api('POST', '/agents/codex/logout');
    await lonca.api('DELETE', `/workspaces/${ws.id}`);
  });

  it('tells Codex’s browser sign-ins apart when they fail, and leaves nobody signed in', async () => {
    await lonca.api('POST', '/agents/codex/login');
    let waiting = await reached('codex', 'waiting');
    expect(await (await fetch(comeBack(waiting.url!, 'error=access_denied&error_description=No'))).text()).toContain('didn’t finish');
    expect(await login('codex')).toMatchObject({ phase: 'failed', failure: 'denied' });

    setFakeSignIn(tools(), { mode: 'rejected' });
    await lonca.api('POST', '/agents/codex/login');
    waiting = await reached('codex', 'waiting');
    expect(await (await fetch(comeBack(waiting.url!))).text()).toContain('didn’t finish');
    expect(await login('codex')).toMatchObject({ phase: 'failed', failure: 'rejected' });
    expect((await lonca.api('GET', '/state')).system.agents.codex.signedIn).toBe(false);
    await lonca.api('DELETE', '/agents/codex/login');
    setFakeSignIn(tools(), { mode: 'ok' });
  });

  it('moves Codex over to the one-time code, without the port or the first CLI left behind', async () => {
    await lonca.api('POST', '/agents/codex/login');
    const waiting = await reached('codex', 'waiting');
    await lonca.api('POST', '/agents/codex/login', { method: 'device' });
    expect((await reached('codex', 'waiting')).code).toBe('FAKE-7CODE');
    await expect(fetch(comeBack(waiting.url!))).rejects.toThrow();
    expect(codexClis().output).toBe('1');
    await lonca.api('DELETE', '/agents/codex/login');
  });

  it('ends a sign-in that’s under way on signing out, so that finishing it can’t sign back in', async () => {
    setFakeSignIn(tools(), { mode: 'ok', approved: false });
    await lonca.api('POST', '/agents/codex/login', { method: 'device' });
    await reached('codex', 'waiting');
    await lonca.api('POST', '/agents/codex/logout');
    expect(await login('codex')).toBeUndefined();
    expect(codexClis().code).not.toBe(0);
    expect((await lonca.api('GET', '/state')).system.agents.codex.signedIn).toBe(false);
  });

  it('signs in to Codex with the one-time code on the real CLI, for the proxy to use and out of reach of workspaces', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const ws = await lonca.waitForWorkspace(created.workspace.id);
    const forProxy = path.join(lonca.home, 'boundary', 'codex');
    setFakeSignIn(tools(), { mode: 'ok', approved: false });
    await lonca.api('POST', '/agents/codex/login', { method: 'device' });
    const waiting = await reached('codex', 'waiting');
    expect(waiting.code).toBe('FAKE-7CODE');
    expect(waiting.url).toBe('http://127.0.0.1:8080/codex/device');
    expect(fs.existsSync(forProxy)).toBe(false);

    // Approving on the page is all it takes. Nothing else happens in Lonca.
    setFakeSignIn(tools(), { approved: true });
    await reached('codex', 'done', 30000);
    const agents = (await lonca.api('GET', '/state')).system.agents;
    expect(agents.codex).toMatchObject({ signedIn: true, summary: 'Signed in with ChatGPT as probe@example.com', usesKey: false });
    await helperHoldsNoLogin();
    const token = fs.readFileSync(forProxy, 'utf8');
    expect(token).toBeTruthy();
    expect(sandboxExec(ws.sandboxName, 'cat ~/.codex/auth.json 2>/dev/null; env').output).not.toContain(token);
    await lonca.api('DELETE', '/agents/codex/login');

    // Starting another sign-in and cancelling it must not sign out.
    setFakeSignIn(tools(), { approved: false });
    await lonca.api('POST', '/agents/codex/login', { method: 'device' });
    await reached('codex', 'waiting');
    await lonca.api('DELETE', '/agents/codex/login');
    expect(codexClis().code).not.toBe(0);
    expect(fs.readFileSync(forProxy, 'utf8')).toBe(token);
    expect((await lonca.api('GET', '/state')).system.agents.codex.signedIn).toBe(true);

    await lonca.api('POST', '/agents/codex/logout');
    expect(fs.existsSync(forProxy)).toBe(false);
    await lonca.api('DELETE', `/workspaces/${ws.id}`);
  });

  it('explains when Codex device sign-in is off, or the page turns it down', async () => {
    setFakeSignIn(tools(), { mode: 'disabled', approved: false });
    await lonca.api('POST', '/agents/codex/login', { method: 'device' });
    expect((await reached('codex', 'failed')).failure).toBe('disabled');

    setFakeSignIn(tools(), { mode: 'denied' });
    await lonca.api('POST', '/agents/codex/login', { method: 'device' });
    expect((await reached('codex', 'failed')).failure).toBe('denied');
    expect((await lonca.api('GET', '/state')).system.agents.codex.signedIn).toBe(false);
    await lonca.api('DELETE', '/agents/codex/login');
    setFakeSignIn(tools(), { mode: 'ok' });
  });

  it('keeps a saved key working when another sign-in is cancelled, and ends a sign-in when a key is saved', async () => {
    await lonca.api('POST', '/agents/claude/login');
    await reached('claude', 'waiting');
    const saved = await lonca.api('PUT', '/secrets/claude', { token: 'sk-ant-api03-not-a-real-key' });
    expect(saved).toEqual({ verified: true });
    expect(await login('claude')).toBeUndefined();
    expect(sandboxExec(tools(), `pgrep -fc 'setup-token'`).code).not.toBe(0);
    expect((await lonca.api('GET', '/state')).system.agents.claude).toMatchObject({ signedIn: true, summary: 'Using an API key ending in -key', usesKey: true });
    await lonca.api('POST', '/agents/claude/logout');
  });
});

describe('workspace lifecycle', () => {
  it('stops and restarts a container, and wakes it when a message arrives', async () => {
    const { id, sandboxName } = a.workspace;
    await lonca.api('POST', `/workspaces/${id}/stop`);
    expect((await lonca.workspace(id)).status).toBe('stopped');
    expect(sandboxRunning(sandboxName)).toBe(false);
    await expect(lonca.api('GET', `/workspaces/${id}/files?path=.`)).rejects.toThrow(/stopped/);
    await lonca.api('POST', `/workspaces/${id}/start`);
    expect((await lonca.workspace(id)).status).toBe('ready');
    expect(sandboxExec(sandboxName, 'cat ~/only-in-a').output).toBe('private');
  });

  it('recreates a container deleted behind its back when started', async () => {
    const { id, sandboxName } = a.workspace;
    removeSandbox(sandboxName);
    await sleep(2000);
    await lonca.api('POST', `/workspaces/${id}/start`);
    const entries = await lonca.api<FileEntry[]>('GET', `/workspaces/${id}/files?path=.`);
    expect(entries.map((entry) => entry.name)).toContain('README.md');
  });

  it('archives without losing the branch, then restores', async () => {
    const { id, path: worktree, sandboxName, branch } = a.workspace;
    const repo = path.join(lonca.home, 'projects', project.slug, 'repo.git');
    const commits = sandboxExec(sandboxName, 'git rev-parse HEAD').output;
    await lonca.api('POST', `/workspaces/${id}/archive`);
    expect((await lonca.workspace(id)).status).toBe('archived');
    expect(fs.existsSync(worktree)).toBe(false);
    expect(sandboxRunning(sandboxName)).toBeNull();
    expect(fs.existsSync(path.join(repo, 'worktrees', a.workspace.name))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'refs', 'heads', ...branch.split('/')))).toBe(true);

    await lonca.api('POST', `/workspaces/${id}/restore`);
    await lonca.waitForWorkspace(id);
    expect(sandboxExec(sandboxName, 'git rev-parse HEAD').output).toBe(commits);
    expect(sandboxExec(sandboxName, 'git status --short --branch').output).toContain(branch);
  });

  it('deletes a workspace and everything it owned', async () => {
    const { id, path: worktree, sandboxName, branch } = b.workspace;
    const repo = path.join(lonca.home, 'projects', project.slug, 'repo.git');
    await lonca.api('DELETE', `/workspaces/${id}`);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(sandboxRunning(sandboxName)).toBeNull();
    expect(fs.existsSync(path.join(lonca.home, 'agent-state', id))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'refs', 'heads', ...branch.split('/')))).toBe(false);
    expect((await lonca.workspace(id))).toBeUndefined();
  });
});

describe('project settings', () => {
  it('applies network and resource limits when a sandbox is rebuilt', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    const curl = async () => (await sandboxExecAsync(workspace.sandboxName, `curl -s -o /dev/null -m 4 -w '%{http_code}' http://host.docker.internal:${mock.port}/`)).output;
    const calls = () => fs.readFileSync(path.join(FAKE_SBX_DIR, 'calls.log'), 'utf8').split('\n').filter((line) => line.includes(workspace.sandboxName) && !line.startsWith('secret '));
    if (FAKE_SANDBOX) {
      expect(calls().at(0)).toContain(BLOCKED_DESTINATIONS.join(' '));
      expect(calls().at(-1)).toBe(`policy allow network --sandbox ${workspace.sandboxName} **`);
    } else {
      expect(await curl()).toMatch(/^(000|403)/);
    }

    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', memoryGb: 2, cpus: 1.5 } });
    await lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
    expect(await curl()).toBe('200');
    expect(fs.existsSync(path.join(workspace.path, 'README.md'))).toBe(true);
    if (FAKE_SANDBOX) {
      expect(calls().at(-2)).toMatch(/deny= .*--memory 2048m --cpus 2/);
      expect(calls().at(-1)).toBe(`policy allow network --sandbox ${workspace.sandboxName} **,localhost`);
    }

    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'internet', memoryGb: 0, cpus: 0 } });
    await lonca.api('POST', `/workspaces/${workspace.id}/recreate`);
    if (REAL_SANDBOX) expect(await curl()).toMatch(/^(000|403)/);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('rebuilds the template when asked, and the next workspace starts from it', async () => {
    const installedAt = (name: string) => Number(sandboxExec(name, 'stat -c %Y /usr/local/bin/lonca-run').output);
    const before = installedAt(a.workspace.sandboxName);
    const image = async () => (await lonca.api('GET', '/state')).system.image;
    await lonca.api('POST', '/image/rebuild');
    expect((await image()).state).toBe('building');
    await until('the build to finish', async () => (await image()).state === 'ready', 500000, 1000);
    const workspace = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    expect(installedAt(workspace.sandboxName)).toBeGreaterThan(before);
    expect(sbx('ls', '--json')).not.toContain(`${lonca.prefix}-template`);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  }, 600000);

  it('runs workspaces on a project’s own template, saved from a workspace', async () => {
    const source = await lonca.waitForWorkspace((await lonca.api('POST', `/projects/${project.id}/workspaces`, {})).workspace.id);
    asRoot(source.sandboxName, 'touch /custom-marker');
    sbx('stop', source.sandboxName);
    const custom = `${lonca.prefix}-custom:test`;
    sbx('template', 'save', source.sandboxName, custom);
    await lonca.api('DELETE', `/workspaces/${source.id}`);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: custom } });
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    expect(sandboxExec(workspace.sandboxName, 'test -e /custom-marker').code).toBe(0);
    expect(sandboxExec(workspace.sandboxName, 'id -un').output).toBe('agent');
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: '' } });
    sbx('template', 'rm', '--force', custom);
  });

  it('says so when a project’s template isn’t there, rather than leaving it to Docker', async () => {
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: `${lonca.prefix}-missing:never` } });
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    await until('the failure', async () => (await lonca.workspace(created.workspace.id)).status === 'error', 60000);
    expect((await lonca.workspace(created.workspace.id)).error).toMatch(/no template called/);
    await lonca.api('DELETE', `/workspaces/${created.workspace.id}`);
    await lonca.api('PATCH', `/projects/${project.id}`, { settings: { image: '' } });
  });

  it('runs a repository’s own setup script from lonca.json', async () => {
    const repo = makeFixtureRepo();
    fs.writeFileSync(path.join(repo, 'lonca.json'), JSON.stringify({ scripts: { setup: 'echo from-repo > from-repo.txt' } }));
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'Add settings');
    const created = await lonca.api<Project>('POST', '/projects', { path: repo });
    await lonca.waitForProject(created.id);
    const made = await lonca.api('POST', `/projects/${created.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(made.workspace.id);
    await until('the setup script', () => fs.existsSync(path.join(workspace.path, 'from-repo.txt')), 20000);
    await lonca.api('DELETE', `/projects/${created.id}`);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe('git in workspaces', () => {
  it('gives git and gh the GitHub token, and rewrites ssh remotes to https', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    const name = workspace.sandboxName;
    const credential = sandboxExec(name, `printf 'protocol=https\\nhost=github.com\\n\\n' | GH_TOKEN=not-a-real-token git credential fill`).output;
    expect(credential).toContain('password=not-a-real-token');
    expect(sandboxExec(name, 'git ls-remote git@github.com:octocat/Hello-World.git HEAD').output).toMatch(/^[0-9a-f]{40}\s+HEAD/);
    expect(sandboxExec(name, 'git config --system push.autoSetupRemote').output).toBe('true');
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
  });

  it('still creates a workspace when origin is unreachable, and says so', async () => {
    const repo = makeFixtureRepo();
    git(repo, 'remote', 'add', 'origin', 'https://127.0.0.1:9/nope.git');
    const created = await lonca.api<Project>('POST', '/projects', { path: repo });
    await lonca.waitForProject(created.id);
    const made = await lonca.api('POST', `/projects/${created.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(made.workspace.id);
    expect(workspace.steps.find((step) => step.id === 'worktree')).toMatchObject({ status: 'warning', detail: expect.stringContaining('Could not fetch') });
    expect(fs.existsSync(path.join(workspace.path, 'README.md'))).toBe(true);
    await lonca.api('DELETE', `/projects/${created.id}`);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('clears out terminals when a workspace goes away', async () => {
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    await lonca.api('POST', `/workspaces/${workspace.id}/terminals`);
    await lonca.api('DELETE', `/workspaces/${workspace.id}`);
    const state = await lonca.api('GET', '/state');
    expect(state.terminals.filter((terminal: { workspaceId: string }) => terminal.workspaceId === workspace.id)).toEqual([]);
  });
});

describe('remote repositories', () => {
  it('clones from GitHub and branches from the remote default branch', async () => {
    const created = await lonca.api<Project>('POST', '/projects', { url: 'octocat/Hello-World' });
    const remote = await lonca.waitForProject(created.id);
    expect(remote.settings.defaultBranch).toBe('master');
    expect(remote.githubOwner).toBe('octocat');
    const made = await lonca.api('POST', `/projects/${remote.id}/workspaces`, {});
    const ws = await lonca.waitForWorkspace(made.workspace.id);
    expect(ws.steps.find((step) => step.id === 'worktree')?.status).toBe('done');
    expect(fs.existsSync(path.join(ws.path, 'README'))).toBe(true);
    await lonca.api('DELETE', `/projects/${remote.id}`);
    expect(fs.existsSync(path.join(lonca.home, 'projects', remote.slug))).toBe(false);
  });
});

describe('when Docker Sandboxes can’t run workspaces', () => {
  // Each case gets a server of its own, starting from nothing.
  const home = () => path.join(FAKE_SBX_DIR, 'choosing');
  const withServer = async (env: Record<string, string>, test: (server: Lonca, project: Project) => Promise<void>) => {
    const server = new Lonca({ port: 47183, instance: 'dockertest-choosing', firstWorkspacePort: 46400 });
    server.env = { LONCA_SBX: FAKE_SBX, FAKE_SBX_DIR: home(), ...env };
    fs.mkdirSync(home(), { recursive: true });
    await server.start();
    try {
      const created = await server.api<Project>('POST', '/projects', { path: fixture });
      await test(server, await server.waitForProject(created.id));
    } finally {
      await server.destroy();
    }
  };
  const sandboxState = async (server: Lonca) => (await server.api('POST', '/sandboxes/check')).state;

  it('won’t make a workspace when it isn’t installed', async () => {
    await withServer({ LONCA_SBX: '/nonexistent/sbx' }, async (server, created) => {
      expect(await sandboxState(server)).toBe('not-installed');
      await expect(server.api('POST', `/projects/${created.id}/workspaces`, {})).rejects.toThrow(/503.*isn’t installed/);
      expect((await server.api('GET', '/state')).workspaces).toEqual([]);
    });
  });

  it('won’t make one when it’s signed out or can’t virtualize, and does once it can', async () => {
    fs.writeFileSync(path.join(home(), 'signed-out'), '');
    await withServer({}, async (server, created) => {
      expect(await sandboxState(server)).toBe('signed-out');
      await expect(server.api('POST', `/projects/${created.id}/workspaces`, {})).rejects.toThrow(/503.*Sign in to Docker/);

      fs.rmSync(path.join(home(), 'signed-out'));
      fs.writeFileSync(path.join(home(), 'virtualization'), 'fail');
      const unavailable = await server.api('POST', '/sandboxes/check');
      expect(unavailable).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('virtualization') });
      fs.rmSync(path.join(home(), 'virtualization'));
      expect(await sandboxState(server)).toBe('ready');

      const made = await server.api('POST', `/projects/${created.id}/workspaces`, {});
      const workspace: Workspace = await server.waitForWorkspace(made.workspace.id);
      const inVm = (await server.api<FileEntry[]>('GET', `/workspaces/${workspace.id}/files?path=.`)).map((entry) => entry.name);
      expect(inVm).toContain('README.md');

      // A real terminal, without a real terminal on this side.
      const terminal = await server.api('POST', `/workspaces/${workspace.id}/terminals`);
      const socket = await server.openTerminal(terminal.id);
      socket.send('stty size; echo "in-$LONCA_WORKSPACE_NAME"; test -t 0 && echo is-a-tty\n');
      await until('the terminal to answer', () => socket.output().includes('is-a-tty\r\n'), 20000).catch((error) => {
        throw new Error(`${error}: ${JSON.stringify(socket.output())} ${server.log}`);
      });
      socket.socket.send(JSON.stringify({ type: 'resize', cols: 123, rows: 45 }));
      await sleep(1500);
      socket.send('stty size\n');
      await until('the terminal to take the new size', () => socket.output().includes('45 123'), 20000);
      socket.socket.close();

      // Existing workspaces stay as they are when sign-in lapses, and say what to do.
      fs.writeFileSync(path.join(home(), 'signed-out'), '');
      await sleep(2000);
      expect(await sandboxState(server)).toBe('signed-out');
      await expect(server.api('GET', `/workspaces/${workspace.id}/files?path=.`)).rejects.toThrow(/Sign in to Docker/);
      expect((await server.workspace(workspace.id)).status).toBe('ready');
      fs.rmSync(path.join(home(), 'signed-out'));
      expect(await sandboxState(server)).toBe('ready');

      await server.api('POST', `/workspaces/${workspace.id}/stop`);
      await server.api('POST', `/workspaces/${workspace.id}/start`);
      expect((await server.workspace(workspace.id)).status).toBe('ready');
      await server.api('DELETE', `/workspaces/${workspace.id}`);
      expect(fs.existsSync(workspace.path)).toBe(false);
    });
  });

  it('signs out from Settings, which stops its workspaces, and signs back in', async () => {
    await withServer({}, async (server, created) => {
      expect(await sandboxState(server)).toBe('ready');
      const made = await server.api('POST', `/projects/${created.id}/workspaces`, {});
      const workspace: Workspace = await server.waitForWorkspace(made.workspace.id);
      expect(sandboxRunning(workspace.sandboxName)).toBe(true);
      // An agent partway through a turn, with some of its answer saved and the rest to come.
      const cli = sandboxExec(workspace.sandboxName, 'command -v claude').output;
      asRoot(workspace.sandboxName, `cat > '${cli}' <<'CLI'
#!/bin/bash
cat >/dev/null
echo '{"type":"assistant","message":{"id":"saved","content":[{"type":"text","text":"saved answer"}]}}'
sleep 600
CLI
chmod +x '${cli}'`);
      const session = made.session as Session;
      await server.api('POST', `/sessions/${session.id}/messages`, { text: 'Keep running' });
      await until('the agent’s first output', async () => (await server.items(session.id)).some((item) => item.type === 'text'), 60000);
      const stoppedNotices = async () => (await server.items(session.id)).filter((item) => item.type === 'notice' && item.text.startsWith('The workspace stopped.')).length;

      await server.api('POST', '/sandboxes/logout');
      expect((await server.api('GET', '/state')).system.sandbox.state).toBe('signed-out');
      expect(sandboxRunning(workspace.sandboxName)).toBe(false);
      // Lonca knows it stopped them, though it can't ask until it's signed in again.
      await until('the workspace to be stopped', async () => (await server.workspace(workspace.id)).status === 'stopped', 10000);
      // Its conversation hears about it now, and only once, though it's still waiting to read the rest.
      await until('the conversation to be told', async () => await stoppedNotices() === 1, 10000);
      expect((await server.session(session.id)).activeRunId).toBeTruthy();
      await expect(server.api('POST', `/workspaces/${workspace.id}/start`)).rejects.toThrow(/Sign in to Docker/);

      const login = await server.api('POST', '/sandboxes/login');
      expect(login).toMatchObject({ phase: 'starting' });
      await until('the code', async () => (await server.api('GET', '/state')).system.dockerLogin?.code === 'VKNZ-LBTN', 10000);
      fs.writeFileSync(path.join(home(), 'login-approve'), '');
      await until('the sign-in to finish', async () => (await server.api('GET', '/state')).system.dockerLogin?.phase === 'done', 20000);
      expect((await server.api('GET', '/state')).system.sandbox.state).toBe('ready');

      // Nothing wakes it, and it's all there once it's started.
      await sleep(6000);
      expect((await server.workspace(workspace.id)).status).toBe('stopped');
      expect(sandboxRunning(workspace.sandboxName)).toBe(false);
      expect(await stoppedNotices()).toBe(1);
      await server.api('POST', `/workspaces/${workspace.id}/start`);
      await server.waitForWorkspace(workspace.id);
      await server.waitForIdle(session.id);
      expect((await server.items(session.id)).some((item) => item.type === 'text' && item.text === 'saved answer')).toBe(true);
      const inVm = (await server.api<FileEntry[]>('GET', `/workspaces/${workspace.id}/files?path=.`)).map((entry) => entry.name);
      expect(inVm).toContain('README.md');

      // Signed out from a terminal a moment before, which stopped it too: signing out in Lonca
      // finds it already done, and marks it all the same.
      sbx('stop', workspace.sandboxName);
      fs.writeFileSync(path.join(home(), 'signed-out'), '');
      await server.api('POST', '/sandboxes/logout');
      await until('the workspace to be stopped', async () => (await server.workspace(workspace.id)).status === 'stopped', 10000);
      expect((await server.api('GET', '/state')).system.sandbox.state).toBe('signed-out');
      fs.rmSync(path.join(home(), 'signed-out'));
      expect(await sandboxState(server)).toBe('ready');
      await server.api('DELETE', `/workspaces/${workspace.id}`);
    });
  });
});
