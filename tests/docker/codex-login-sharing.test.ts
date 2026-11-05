import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Lonca, docker, dockerExec, until } from '../support/harness.ts';

let lonca: Lonca;
const helper = () => `${lonca.prefix}-tools`;
const SHARED = '/var/lib/lonca/credentials/codex/auth.json';
const PRIVATE = '/home/lonca/.codex/auth.json';
const CHATGPT = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: 'sk-incidental-browser-login-key',
  tokens: { id_token: 'header.payload.signature', access_token: 'access_fake', refresh_token: 'refresh_fake' },
};
const API_KEY = { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-deliberately-configured-key' };

beforeAll(async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  lonca = new Lonca({ port, instance: `codex-login-sharing-${process.pid}`, firstWorkspacePort: 59300 });
  await lonca.start();
  await until('initial agent checks', async () => (await lonca.api('GET', '/state')).system.agentsChecked, 540000);
});

afterAll(async () => {
  await lonca?.destroy();
});

function writeLogin(file: string, value: unknown): void {
  execFileSync('docker', [
    'exec', '-i', '--user', 'lonca', helper(), 'bash', '-c',
    'rm -f "$1" && cat > "$1" && chmod 600 "$1"', 'write-login', file,
  ], { input: typeof value === 'string' ? value : JSON.stringify(value) });
}

function sharedLogin(): unknown {
  const result = dockerExec(helper(), `cat ${SHARED}`);
  expect(result.code).toBe(0);
  return JSON.parse(result.output);
}

async function restartHelper(): Promise<void> {
  docker('restart', '-t', '1', helper());
  await until('helper startup', () => dockerExec(helper(), 'test -e /run/lonca/ready').code === 0, 15000);
  expect(dockerExec(helper(), 'test -L ~/.codex/auth.json').code).toBe(0);
  expect(dockerExec(helper(), `stat -c %a ${SHARED}`).output).toBe('600');
}

it('removes a browser login’s incidental API key before sharing it during helper startup', async () => {
  // Stop the server so a refresh cannot hide what the container itself shares at startup.
  await lonca.stop();
  try {
    writeLogin(PRIVATE, CHATGPT);
    await restartHelper();
    expect(sharedLogin()).toEqual({ ...CHATGPT, OPENAI_API_KEY: null });
  } finally {
    await lonca.start();
  }
});

it('removes an incidental key already shared by an older image, even through an existing symlink', async () => {
  writeLogin(SHARED, CHATGPT);
  expect(dockerExec(helper(), 'test -L ~/.codex/auth.json').code).toBe(0);
  await lonca.api('POST', '/agents/refresh');
  expect(sharedLogin()).toEqual({ ...CHATGPT, OPENAI_API_KEY: null });
  expect(dockerExec(helper(), `stat -c %a ${SHARED}`).output).toBe('600');
});

it('sanitizes a private login in an older image without the shared script installed', async () => {
  const script = '/usr/local/bin/lonca-share-codex-login';
  docker('exec', helper(), 'mv', script, `${script}.away`);
  try {
    writeLogin(PRIVATE, CHATGPT);
    await lonca.api('POST', '/agents/refresh');
    expect(sharedLogin()).toEqual({ ...CHATGPT, OPENAI_API_KEY: null });
    expect(dockerExec(helper(), 'test -L ~/.codex/auth.json').code).toBe(0);
  } finally {
    docker('exec', helper(), 'mv', `${script}.away`, script);
  }
});

it('still shares a manually configured key in an older image without jq', async () => {
  docker('exec', helper(), 'mv', '/usr/bin/jq', '/usr/bin/jq.away');
  try {
    writeLogin(PRIVATE, API_KEY);
    await lonca.api('POST', '/agents/refresh');
    expect(sharedLogin()).toEqual(API_KEY);
    expect(dockerExec(helper(), 'test -L ~/.codex/auth.json').code).toBe(0);
  } finally {
    docker('exec', helper(), 'mv', '/usr/bin/jq.away', '/usr/bin/jq');
  }
});

it('preserves an intentionally configured API key through helper startup and refresh', async () => {
  await lonca.stop();
  try {
    writeLogin(PRIVATE, API_KEY);
    await restartHelper();
    expect(sharedLogin()).toEqual(API_KEY);
  } finally {
    await lonca.start();
  }
  await lonca.api('POST', '/agents/refresh');
  expect(sharedLogin()).toEqual(API_KEY);
});

it.each([
  { state: 'empty', contents: '' },
  { state: 'truncated', contents: '{"auth_mode":"chatgpt","OPENAI_API_KEY":"sk-incomplete' },
])('keeps the shared login when a private login is $state after an interrupted write', async ({ contents }) => {
  await lonca.stop();
  try {
    writeLogin(SHARED, API_KEY);
    writeLogin(PRIVATE, contents);
    await restartHelper();
    expect(sharedLogin()).toEqual(API_KEY);
  } finally {
    await lonca.start();
  }
});
