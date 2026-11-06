import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { forgetSbxLogin, reapSbxLogin, recordSbxLogin } from '../../server/sbx-login-pid.ts';

const FAKE_SBX = path.join(import.meta.dirname, '..', 'support', 'fake-sbx');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-sbx-login-'));
const record = path.join(dir, 'sbx-login.json');
const children: ChildProcess[] = [];

/** The stand-in for sbx, waiting for its code to be used as the real one does. */
function waitingLogin(): ChildProcess {
  const child = spawn(FAKE_SBX, ['login'], { env: { ...process.env, FAKE_SBX_DIR: dir }, stdio: 'ignore' });
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once('exit', () => resolve());
});

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** A server that has been killed, which is when its login is left behind. */
let goneServer: number;
beforeAll(async () => {
  const server = spawn('true', { stdio: 'ignore' });
  await exited(server);
  goneServer = server.pid!;
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  fs.rmSync(record, { force: true });
});

describe('ending an sbx login the last server left waiting', () => {
  it('ends the one it noted', async () => {
    const child = waitingLogin();
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(owner);
    recordSbxLogin(child.pid!, `${FAKE_SBX} login`, record, owner.pid!);
    expect(fs.existsSync(record)).toBe(true);
    owner.kill('SIGKILL');
    await exited(owner);
    reapSbxLogin(record);
    await exited(child);
    expect(fs.existsSync(record)).toBe(false);
  });

  it('leaves a process that only has its pid, or started at another time', async () => {
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(other);
    recordSbxLogin(other.pid!, `${FAKE_SBX} login`, record);
    fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), owner: goneServer }));
    reapSbxLogin(record);

    const login = waitingLogin();
    recordSbxLogin(login.pid!, `${FAKE_SBX} login`, record);
    const noted = JSON.parse(fs.readFileSync(record, 'utf8'));
    fs.writeFileSync(record, JSON.stringify({ ...noted, owner: goneServer, started: 'Thu Jan  1 00:00:00 1970' }));
    reapSbxLogin(record);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(other)).toBe(true);
    expect(alive(login)).toBe(true);
    expect(fs.existsSync(record)).toBe(false);
  });

  it('leaves the login of a server that’s still running, such as Lonca started a second time', async () => {
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(owner);
    const login = waitingLogin();
    recordSbxLogin(login.pid!, `${FAKE_SBX} login`, record, owner.pid!);
    reapSbxLogin(record);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(login)).toBe(true);
    expect(fs.existsSync(record)).toBe(true);

    // Once that server has gone, the next start ends it.
    owner.kill('SIGKILL');
    await exited(owner);
    reapSbxLogin(record);
    await exited(login);
    expect(fs.existsSync(record)).toBe(false);
  });

  it('forgets one that exited, but not a newer one', () => {
    fs.writeFileSync(record, JSON.stringify({ pid: 1234, command: 'sbx login', started: 'x' }));
    forgetSbxLogin(999, record);
    expect(fs.existsSync(record)).toBe(true);
    forgetSbxLogin(1234, record);
    expect(fs.existsSync(record)).toBe(false);
  });

  it('copes with nothing noted, or something that isn’t a record', () => {
    expect(() => reapSbxLogin(record)).not.toThrow();
    fs.writeFileSync(record, 'not json');
    expect(() => reapSbxLogin(record)).not.toThrow();
    fs.writeFileSync(record, JSON.stringify({ pid: 1, command: 'init', started: 'x' }));
    expect(() => reapSbxLogin(record)).not.toThrow();
  });
});
