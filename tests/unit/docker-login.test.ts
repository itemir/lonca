import { describe, expect, it } from 'vitest';
import type { DockerLoginState, SandboxStatus } from '../../shared/types.ts';
import { DOCKER_LOGIN_TIMINGS, type DockerLoginDriver, DockerLoginManager, describeSbxFailure, parseDockerLogin } from '../../server/docker-login.ts';

// What sbx v0.51.0 printed for `sbx login` with no terminal and nothing on stdin.
const REAL_OUTPUT = `By logging in, you agree to our Subscription Service Agreement. For more details, see https://www.docker.com/legal/docker-subscription-service-agreement/

Your one-time device confirmation code is: VKNZ-LBTN
Complete sign-in in your browser, then return to this terminal.
Open this URL to sign in: https://login.docker.com/activate?user_code=VKNZ-LBTN

Waiting for authentication...
`;
const CANCELLED = 'error: auth login failed: completing login: context canceled\n';
const FOUND = { code: 'VKNZ-LBTN', url: 'https://login.docker.com/activate?user_code=VKNZ-LBTN' };

describe('reading what sbx login prints', () => {
  it('finds the code and the page, and not the agreement’s link', () => {
    expect(parseDockerLogin(REAL_OUTPUT)).toEqual(FOUND);
  });

  it('finds them on a terminal’s line endings, and among other text', () => {
    expect(parseDockerLogin(REAL_OUTPUT.replaceAll('\n', '\r\n'))).toEqual(FOUND);
    expect(parseDockerLogin(`\x1b[1mStarting\x1b[0m\n${REAL_OUTPUT}Still waiting...\n`)).toEqual(FOUND);
  });

  it('waits until both have arrived whole, wherever the output is cut', () => {
    const whole = REAL_OUTPUT.indexOf('VKNZ-LBTN\n\nWaiting') + 'VKNZ-LBTN\n'.length;
    for (let end = 0; end <= REAL_OUTPUT.length; end++) {
      expect(parseDockerLogin(REAL_OUTPUT.slice(0, end))).toEqual(end < whole ? null : FOUND);
    }
  });

  it('takes the code from the page when it isn’t printed on its own', () => {
    expect(parseDockerLogin('Open this URL to sign in: https://login.docker.com/activate?user_code=ABCD-EFGH\n')).toEqual({
      code: 'ABCD-EFGH', url: 'https://login.docker.com/activate?user_code=ABCD-EFGH',
    });
  });

  it('won’t send anyone to a page that isn’t https', () => {
    expect(parseDockerLogin('Your one-time device confirmation code is: VKNZ-LBTN\nOpen this URL to sign in: http://login.docker.com/activate?user_code=VKNZ-LBTN\n')).toBeNull();
  });

  it('puts sbx’s error in plain words', () => {
    expect(describeSbxFailure(CANCELLED)).toBe('Auth login failed: completing login: context canceled');
    expect(describeSbxFailure('some warning\r\nerror: not signed in to Docker\r\n  try: sbx login\r\n')).toBe('Not signed in to Docker');
    expect(describeSbxFailure('')).toBeUndefined();
  });
});

/** A stand-in for sbx login: prints when told, and exits when killed, as the real one does. */
function fakeSbx(options: { sandboxes?: () => SandboxStatus['state']; spawnFails?: string; slowToDie?: boolean } = {}) {
  const published: (DockerLoginState | null)[] = [];
  const spawned: { print: (text: string) => void; exit: (code: number, stderr?: string) => void; killed: boolean }[] = [];
  let checks = 0;
  const driver: DockerLoginDriver = {
    async spawn() {
      if (options.spawnFails) throw new Error(options.spawnFails);
      let listener: (text: string) => void = () => {};
      let exit!: (result: { code: number | null; stderr: string }) => void;
      const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        exit = resolve;
      });
      const process = {
        print: (text: string) => listener(text),
        exit: (code: number, stderr = '') => exit({ code, stderr }),
        killed: false,
      };
      spawned.push(process);
      return {
        onOutput: (next) => {
          listener = next;
        },
        exited,
        kill: () => {
          process.killed = true;
          // Otherwise it's left for the test to say when it's gone.
          if (!options.slowToDie) exit({ code: 1, stderr: CANCELLED });
        },
      };
    },
    async check() {
      checks++;
      return options.sandboxes?.() ?? 'signed-out';
    },
    publish: (login) => published.push(login),
  };
  return { driver, published, spawned, checks: () => checks };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('signing in to Docker Sandboxes', () => {
  it('shows the code, and finishes once sbx is signed in', async () => {
    let sandboxes: SandboxStatus['state'] = 'signed-out';
    const fake = fakeSbx({ sandboxes: () => sandboxes });
    const manager = new DockerLoginManager(fake.driver);
    expect(await manager.start()).toEqual({ phase: 'starting' });
    fake.spawned[0].print(REAL_OUTPUT.slice(0, 200));
    expect(manager.state()?.phase).toBe('starting');
    fake.spawned[0].print(REAL_OUTPUT.slice(200));
    expect(manager.state()).toEqual({ phase: 'waiting', ...FOUND });

    sandboxes = 'ready';
    fake.spawned[0].exit(0, '');
    await settle();
    expect(manager.state()).toEqual({ phase: 'done' });
    expect(fake.checks()).toBe(1);
    expect(fake.published.map((login) => login?.phase)).toEqual(['starting', 'waiting', 'checking', 'done']);
  });

  it('has one sign-in at a time', async () => {
    const fake = fakeSbx();
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);
    expect(await manager.start()).toEqual({ phase: 'waiting', ...FOUND });
    expect(fake.spawned).toHaveLength(1);
  });

  it('reports sbx’s error when it fails, and what it printed', async () => {
    const fake = fakeSbx();
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);
    fake.spawned[0].exit(1, 'error: auth login failed: completing login: access denied\n');
    await settle();
    expect(manager.state()).toMatchObject({ phase: 'failed', failure: 'stopped', message: 'Auth login failed: completing login: access denied' });
    expect(manager.state()?.output).toContain('Waiting for authentication...');
    expect(manager.state()?.output).toContain('access denied');
    expect(manager.state()?.code).toBeUndefined();
  });

  it('doesn’t call it signed in because sbx exited cleanly', async () => {
    const fake = fakeSbx();
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].exit(0);
    await settle();
    expect(manager.state()).toMatchObject({ phase: 'failed', failure: 'stopped', message: undefined });
  });

  it('counts a sign-in that worked even when something else is in the way', async () => {
    const fake = fakeSbx({ sandboxes: () => 'unavailable' });
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].exit(0);
    await settle();
    expect(manager.state()?.phase).toBe('done');
  });

  it('says when sbx can’t be started', async () => {
    const fake = fakeSbx({ spawnFails: 'Lonca can’t find the sbx command' });
    const manager = new DockerLoginManager(fake.driver);
    expect(await manager.start()).toMatchObject({ phase: 'failed', failure: 'unavailable', message: 'Lonca can’t find the sbx command' });
  });

  it('stops sbx when cancelled, says so, and still checks where it stands', async () => {
    const fake = fakeSbx();
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);
    await manager.cancel();
    expect(fake.spawned[0].killed).toBe(true);
    expect(manager.state()).toBeNull();
    expect(fake.published.at(-1)).toBeNull();
    // The kill's own exit doesn't turn into a failure for anyone to see.
    expect(fake.published.some((login) => login?.phase === 'failed')).toBe(false);
    expect(fake.checks()).toBe(1);
    // And a new one can start.
    await manager.start();
    expect(fake.spawned).toHaveLength(2);
  });

  it('ends a sign-in still waiting once sbx is signed in some other way', async () => {
    const fake = fakeSbx();
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);
    manager.sandboxesReady();
    expect(fake.spawned[0].killed).toBe(true);
    expect(manager.state()).toEqual({ phase: 'done' });
    await settle();
    // The kill's exit changes nothing, and the code isn't on offer any more.
    expect(manager.state()).toEqual({ phase: 'done' });
    expect(fake.published.at(-1)).toEqual({ phase: 'done' });
    expect(fake.published.some((login) => login?.phase === 'failed')).toBe(false);
  });

  it('ends one signed in while sbx is still starting, once it has', async () => {
    let started!: () => void;
    const fake = fakeSbx();
    const spawn = fake.driver.spawn;
    fake.driver.spawn = async () => {
      await new Promise<void>((resolve) => {
        started = resolve;
      });
      return spawn();
    };
    const manager = new DockerLoginManager(fake.driver);
    const starting = manager.start();
    await settle();
    manager.sandboxesReady();
    started();
    await starting;
    expect(fake.spawned[0].killed).toBe(true);
    expect(manager.state()).toEqual({ phase: 'done' });
  });

  it('leaves one alone that sbx has already finished', async () => {
    let answer!: (state: SandboxStatus['state']) => void;
    const fake = fakeSbx();
    fake.driver.check = () => new Promise((resolve) => {
      answer = resolve;
    });
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].exit(0);
    await settle();
    manager.sandboxesReady();
    expect(manager.state()?.phase).toBe('checking');
    answer('ready');
    await settle();
    expect(manager.state()?.phase).toBe('done');
  });

  it('cancels only once sbx has gone', async () => {
    const fake = fakeSbx({ slowToDie: true });
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);
    let cancelled = false;
    const cancelling = manager.cancel().then(() => {
      cancelled = true;
    });
    await settle();
    expect(fake.spawned[0].killed).toBe(true);
    expect(cancelled).toBe(false);
    fake.spawned[0].exit(1, CANCELLED);
    await cancelling;
    expect(cancelled).toBe(true);
  });

  it('runs one sbx login at a time, even when retried while the last is still exiting', async () => {
    const fake = fakeSbx({ slowToDie: true });
    const manager = new DockerLoginManager(fake.driver, { ...DOCKER_LOGIN_TIMINGS, noCodeMs: 20 });
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);

    // Cancelled, and started again before the first has gone.
    const cancelling = manager.cancel();
    const retried = manager.start();
    await settle();
    expect(fake.spawned).toHaveLength(1);
    expect(manager.state()).toEqual({ phase: 'starting' });
    // A second click joins the one that's waiting its turn.
    await manager.start();
    fake.spawned[0].exit(1, CANCELLED);
    await cancelling;
    await retried;
    expect(fake.spawned).toHaveLength(2);

    // Failed, and its sbx not gone yet when it's tried again.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(manager.state()).toMatchObject({ phase: 'failed', failure: 'no-code' });
    expect(fake.spawned[1].killed).toBe(true);
    const again = manager.start();
    await settle();
    expect(fake.spawned).toHaveLength(2);
    fake.spawned[1].exit(1, CANCELLED);
    await again;
    expect(fake.spawned).toHaveLength(3);
  });

  it('doesn’t start a waiting sbx at all once it’s cancelled', async () => {
    const fake = fakeSbx({ slowToDie: true });
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    const cancelling = manager.cancel();
    const retried = manager.start();
    const cancelledAgain = manager.cancel();
    fake.spawned[0].exit(1, CANCELLED);
    await Promise.all([cancelling, retried, cancelledAgain]);
    expect(fake.spawned).toHaveLength(1);
    expect(manager.state()).toBeNull();
  });

  it('says so when sbx finished but Lonca couldn’t find out how it went', async () => {
    const fake = fakeSbx();
    fake.driver.check = async () => {
      throw new Error('cannot connect to sandboxd');
    };
    const manager = new DockerLoginManager(fake.driver);
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);
    fake.spawned[0].exit(0);
    await settle();
    expect(manager.state()).toMatchObject({ phase: 'failed', failure: 'unchecked', message: 'cannot connect to sandboxd' });
  });

  it('gives up when no code arrives, and when nobody approves in time', async () => {
    const timings = { ...DOCKER_LOGIN_TIMINGS, noCodeMs: 20, expiresMs: 60 };
    const silent = fakeSbx();
    const quiet = new DockerLoginManager(silent.driver, timings);
    await quiet.start();
    silent.spawned[0].print('Starting...\n');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(quiet.state()).toMatchObject({ phase: 'failed', failure: 'no-code', output: 'Starting...' });
    expect(silent.spawned[0].killed).toBe(true);

    const waiting = fakeSbx();
    const slow = new DockerLoginManager(waiting.driver, timings);
    await slow.start();
    waiting.spawned[0].print(REAL_OUTPUT);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(slow.state()).toMatchObject({ phase: 'failed', failure: 'expired' });
    expect(waiting.spawned[0].killed).toBe(true);
  });

  it('isn’t ended by the time limit while it finds out how sbx did', async () => {
    let answer!: (state: SandboxStatus['state']) => void;
    const fake = fakeSbx();
    fake.driver.check = () => new Promise((resolve) => {
      answer = resolve;
    });
    const manager = new DockerLoginManager(fake.driver, { ...DOCKER_LOGIN_TIMINGS, expiresMs: 20 });
    await manager.start();
    fake.spawned[0].print(REAL_OUTPUT);
    fake.spawned[0].exit(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(manager.state()?.phase).toBe('checking');
    answer('ready');
    await settle();
    expect(manager.state()?.phase).toBe('done');
  });
});
