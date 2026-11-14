import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { Lonca, git, makeFixtureRepo, until } from '../support/harness.ts';

it('imports a private HTTPS GitHub repository with the saved token and keeps it out of the checkout', async () => {
  const lonca = new Lonca({ port: 48307, instance: 'import-test', firstWorkspacePort: 51600 });
  const fixture = makeFixtureRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-private-remote-'));
  const token = 'github_pat_fake_private_import';
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const requests: { path: string; authenticated: boolean }[] = [];
  const sockets = new Set<Duplex>();
  const remote = https.createServer((req, res) => {
    const pathname = new URL(req.url!, 'https://github.com').pathname;
    const authenticated = req.headers.authorization === authorization;
    requests.push({ path: pathname, authenticated });
    if (!authenticated) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="private repository"' });
      res.end();
      return;
    }
    try {
      // A bare repository with update-server-info supports Git's dumb HTTP transport.
      const data = fs.readFileSync(path.join(root, pathname));
      res.writeHead(200, { 'content-type': pathname.endsWith('/info/refs') ? 'text/plain' : 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  const proxy = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
  try {
    const key = path.join(root, 'key.pem');
    const cert = path.join(root, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', '/CN=github.com', '-addext', 'subjectAltName=DNS:github.com',
    ], { stdio: 'ignore' });
    remote.setSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
    git(fixture, 'checkout', '--quiet', '-b', 'development');
    fs.mkdirSync(path.join(root, 'owner'));
    const bare = path.join(root, 'owner/private.git');
    git(fixture, 'clone', '--quiet', '--bare', fixture, bare);
    git(bare, 'update-server-info');
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const remotePort = (remote.address() as net.AddressInfo).port;
    // Preserve github.com as the credential host while routing TLS to the local fixture.
    proxy.on('connect', (req, socket, head) => {
      if (req.url !== 'github.com:443') { socket.destroy(); return; }
      const upstream = net.connect(remotePort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(socket);
      sockets.add(upstream);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as net.AddressInfo).port;
    const config = path.join(root, 'gitconfig');
    fs.writeFileSync(config, `[credential]\n\thelper =\n[http "https://github.com/"]\n\tproxy = http://127.0.0.1:${proxyPort}\n\tsslCAInfo = ${cert}\n`);
    lonca.env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, NO_PROXY: '', no_proxy: '' };
    await lonca.start();
    await lonca.api('PUT', '/secrets/github', { token });
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { url: 'owner/private' })).id);
    expect(project.remoteUrl).toBe('https://github.com/owner/private.git');
    // Authentication must also work for remote set-head, not just the initial fetch.
    expect(project.settings.defaultBranch).toBe('development');
    expect(requests.some((request) => request.path.endsWith('/info/refs') && request.authenticated)).toBe(true);
    expect(requests.some((request) => request.path.endsWith('/HEAD') && request.authenticated)).toBe(true);
    const imported = path.join(lonca.home, 'projects', project.slug, 'cache.git');
    expect(git(imported, 'rev-parse', 'refs/remotes/origin/development')).toBe(git(fixture, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(imported, 'config'), 'utf8')).not.toMatch(/credential|github_pat/);
    // A workspace's checkout is copied from that, after a fetch that uses the token as well.
    const fetched = requests.length;
    const made = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(made.workspace.id);
    expect(workspace.steps.find((step) => step.id === 'checkout')?.status).toBe('done');
    expect(requests.slice(fetched).some((request) => request.authenticated)).toBe(true);
    expect(fs.readFileSync(path.join(workspace.path, '.git', 'config'), 'utf8')).not.toMatch(/credential|github_pat/);
    // A project added by its SSH address uses the token too, over HTTPS, as workspaces do.
    const viaSsh = await lonca.waitForProject((await lonca.api('POST', '/projects', { url: 'git@github.com:owner/private.git' })).id);
    expect(viaSsh.settings.defaultBranch).toBe('development');
    const sshMade = await lonca.api('POST', `/projects/${viaSsh.id}/workspaces`, {});
    expect((await lonca.waitForWorkspace(sshMade.workspace.id)).steps.find((step) => step.id === 'checkout')?.status).toBe('done');
    expect(JSON.stringify(project)).not.toContain(token);
    expect(lonca.log).not.toContain(token);
  } finally {
    await lonca.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([remote, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('ends an import’s Git, and the token it holds, when Lonca shuts down', async () => {
  const lonca = new Lonca({ port: 48308, instance: 'import-stop-test', firstWorkspacePort: 51700 });
  // A server that takes the connection and never answers keeps the import going. It's on this
  // computer, since a network can answer for an address that wouldn't, as a proxy or firewall does,
  // and then Git ends before the test sees it.
  const connections = new Set<net.Socket>();
  const silent = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const remote = `https://127.0.0.1:${(silent.address() as net.AddressInfo).port}/nobody/stop-test.git`;
  lonca.env = { NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  const running = () => {
    try {
      return execFileSync('pgrep', ['-f', remote.replace(/\./g, '\\.')], { encoding: 'utf8' }).trim() !== '';
    } catch {
      return false;
    }
  };
  try {
    await lonca.start();
    await lonca.api('POST', '/projects', { url: remote });
    // Git's own setup has the address too, so wait until it has reached the server.
    await until('the import’s Git', () => connections.size > 0 && running(), 15000);
    await lonca.stop();
    await until('Git to end', () => !running(), 5000);
  } finally {
    await lonca.destroy();
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});
