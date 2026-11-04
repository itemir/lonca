import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentId, LoginState } from '../../shared/types.ts';
import {
  LoginScreen, classifyCodexFailure, findClaudeLink, findClaudeToken, findCodexDevice, isClaudeCodeRejected, redact,
} from '../../server/agents/login.ts';
import { LOGIN_TIMINGS, type LoginDriver, LoginManager, type LoginProcess } from '../../server/login.ts';

// These are the real CLIs' byte streams, recorded from complete runs against fake services on
// a 500-column terminal. The token in them is fake. The CLIs paint with cursor movements, so
// any stand-in that prints plain lines would pass tests that the real thing fails.
const recording = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'login', `${name}.bin`));

const FAKE_TOKEN = `sk-ant-oat01-${'FakeTokenForTesting_-'.repeat(4)}zzzzzzzAA`;

/** Feeds a recording in random pieces, since a stream can be cut anywhere. */
async function render(name: string, seed = 1): Promise<LoginScreen> {
  const data = recording(name);
  const screen = new LoginScreen();
  let random = seed;
  for (let offset = 0; offset < data.length;) {
    random = (random * 48271) % 2147483647;
    const size = 1 + (random % 400);
    await screen.write(data.subarray(offset, offset + size));
    offset += size;
  }
  return screen;
}

describe('reading the real CLIs’ screens', () => {
  it('finds the token Claude printed, however the output was cut up', async () => {
    for (const seed of [1, 7, 99, 12345]) {
      const screen = await render('claude-success', seed);
      expect(findClaudeToken(screen.text())).toBe(FAKE_TOKEN);
      screen.dispose();
    }
  });

  it('finds the whole sign-in link, from its hyperlink', async () => {
    const screen = await render('claude-success');
    const link = findClaudeLink(screen)!;
    expect(new URL(link).hostname).toBe('claude.com');
    expect(new URL(link).searchParams.get('state')).toBeTruthy();
    expect(new URL(link).searchParams.get('code_challenge')).toBeTruthy();
    screen.dispose();
  });

  it('recognizes a code Claude refused', async () => {
    const screen = await render('claude-rejected');
    expect(isClaudeCodeRejected(screen.text())).toBe(true);
    expect(findClaudeToken(screen.text())).toBeNull();
    screen.dispose();
    const fine = await render('claude-success');
    expect(isClaudeCodeRejected(fine.text())).toBe(false);
    fine.dispose();
  });

  it('finds Codex’s link and one-time code', async () => {
    const screen = await render('codex-success');
    expect(findCodexDevice(screen.text())).toEqual({ url: 'http://platform.claude.com:8080/codex/device', code: 'FAKE-7CODE' });
    screen.dispose();
  });

  it('tells Codex’s failures apart', async () => {
    const disabled = await render('codex-disabled');
    expect(classifyCodexFailure(disabled.text())).toBe('disabled');
    expect(findCodexDevice(disabled.text())).toBeNull();
    disabled.dispose();
    const denied = await render('codex-denied');
    expect(classifyCodexFailure(denied.text())).toBe('denied');
    denied.dispose();
    expect(classifyCodexFailure('something new')).toBe('stopped');
    expect(classifyCodexFailure('the device code timed out')).toBe('expired');
  });

  it('never lets a credential out in what it shows of a screen', async () => {
    const screen = await render('claude-success');
    const shown = redact(screen.text());
    expect(shown).not.toContain('sk-ant-oat');
    expect(shown).not.toContain('FakeTokenForTesting');
    expect(shown).toContain('Long-lived authentication token created');
    screen.dispose();
    expect(redact('key sk-proj-abcdefghijklmnop end')).toBe('key sk-… end');
    expect(redact(`opaque ${'a'.repeat(60)} end`)).toBe('opaque … end');
    expect(redact('see https://example.com/a?state=' + 'b'.repeat(60))).toContain('https://example.com/a?state=');
  });

  it('reads a token the CLI wrapped itself, and masks every piece of it', () => {
    const screen = `Your token:\n\n  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n  ABCDEFGHIJKLMNOP\n  tail_-end\n\nStore this token securely.\n`;
    expect(findClaudeToken(screen)).toBe('sk-ant-oat01-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPtail_-end');
    const shown = redact(screen);
    expect(shown).not.toContain('ABCDEFGHIJKLMNOP');
    expect(shown).not.toContain('tail_-end');
    expect(shown).toContain('Store this token securely.');
  });

  it('isn’t led astray by another link on the screen', async () => {
    const docs = new LoginScreen();
    await docs.write('\x1b]8;;https://docs.example.com/guide\x07guide\x1b]8;;\x07\r\n\x1b]8;;https://claude.com/cai/oauth/authorize?state=s\x07Sign in\x1b]8;;\x07\r\n');
    expect(findClaudeLink(docs)).toBe('https://claude.com/cai/oauth/authorize?state=s');
    docs.dispose();
    expect(findCodexDevice('Release notes: https://example.com/notes\n1. Open https://auth.example.com/device\n2. Enter this one-time code\n  AB12-CD34\n'))
      .toEqual({ url: 'https://auth.example.com/device', code: 'AB12-CD34' });
  });
});

class FakeProcess implements LoginProcess {
  written: string[] = [];
  killed = false;
  private listener: (data: Buffer) => void = () => {};
  private resolveExit!: (code: number | null) => void;
  exited = new Promise<number | null>((resolve) => {
    this.resolveExit = resolve;
  });

  onData(listener: (data: Buffer) => void): void {
    this.listener = listener;
  }

  write(data: string): void {
    this.written.push(data);
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  emit(data: Buffer | string): void {
    this.listener(Buffer.from(data));
  }

  exit(code: number | null): void {
    this.resolveExit(code);
  }
}

const TIMINGS = { ...LOGIN_TIMINGS, settledMs: 10, echoMs: 10 };

function setup(overrides: Partial<LoginDriver> = {}, timings = TIMINGS) {
  const processes: FakeProcess[] = [];
  const published: (LoginState | null)[] = [];
  const saved: string[] = [];
  const cleanedUp: AgentId[] = [];
  const driver: LoginDriver = {
    spawn: async () => {
      const process = new FakeProcess();
      processes.push(process);
      return process;
    },
    saveClaudeToken: async (token) => {
      saved.push(token);
    },
    finishCodexLogin: async () => true,
    cleanUp: async (agent) => {
      cleanedUp.push(agent);
    },
    publish: (_agent, login) => published.push(login),
    ...overrides,
  };
  return { manager: new LoginManager(driver, timings), processes, published, saved, cleanedUp };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays a recording up to the prompt: the real CLI's frames before the code is entered. */
function promptFrames(name: string): Buffer {
  const data = recording(name);
  const marker = Buffer.from('Paste');
  const end = data.indexOf(marker);
  return data.subarray(0, data.indexOf(Buffer.from('\n'), end) + 1 || data.length);
}

describe('the Claude sign-in', () => {
  it('goes from link to saved token, typing the code as a paste and then Return', async () => {
    const { manager, processes, published, saved } = setup();
    await manager.start('claude');
    expect(manager.states().claude?.phase).toBe('starting');
    const process = processes[0];
    process.emit(promptFrames('claude-success'));
    await tick();
    const waiting = manager.states().claude!;
    expect(waiting.phase).toBe('waiting');
    const state = new URL(waiting.url!).searchParams.get('state');

    const submitted = manager.submitCode('claude', `abc#${state}`);
    expect(manager.states().claude?.phase).toBe('submitting');
    await submitted;
    expect(process.written).toEqual([`\x1b[200~abc#${state}\x1b[201~`, '\r']);

    process.emit(recording('claude-success'));
    await tick();
    process.exit(0);
    await tick();
    expect(manager.states().claude?.phase).toBe('done');
    expect(saved).toEqual([FAKE_TOKEN]);
    expect(JSON.stringify(published)).not.toContain('sk-ant-oat');
    expect(manager.output('claude')).not.toContain('sk-ant-oat');
  });

  it('saves the token even if the CLI exits before the screen has settled', async () => {
    const { manager, processes, saved } = setup({}, { ...TIMINGS, settledMs: 60000 });
    await manager.start('claude');
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode('claude', 'abc');
    processes[0].emit(recording('claude-success'));
    processes[0].exit(0);
    await tick();
    expect(saved).toEqual([FAKE_TOKEN]);
    expect(manager.states().claude?.phase).toBe('done');
  });

  it('reports a refused code and stops the CLI, which would otherwise wait forever', async () => {
    const { manager, processes, published } = setup();
    await manager.start('claude');
    processes[0].emit(promptFrames('claude-rejected'));
    await tick();
    await manager.submitCode('claude', 'wrong');
    processes[0].emit(recording('claude-rejected'));
    await tick();
    const failed = manager.states().claude!;
    expect(failed).toMatchObject({ phase: 'failed', failure: 'rejected' });
    expect(failed.output).toContain('accepted');
    expect(processes[0].killed).toBe(true);
    expect(JSON.stringify(published)).not.toContain('sk-ant-oat');
  });

  it('shows what the CLI said when it’s stuck on something other than the code', async () => {
    const { manager, processes } = setup();
    await manager.start('claude');
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode('claude', 'abc');
    processes[0].emit('\r\nCouldn’t verify your organization’s settings (a network proxy answered instead of Anthropic).\r\n\r\nPress Enter to retry.\r\n');
    await tick();
    const failed = manager.states().claude!;
    expect(failed).toMatchObject({ phase: 'failed', failure: 'stopped' });
    expect(failed.output).toContain('a network proxy answered');
    expect(processes[0].killed).toBe(true);
  });

  it('gives up when nothing comes back after a code', async () => {
    const { manager, processes } = setup({}, { ...TIMINGS, codeResultMs: 20 });
    await manager.start('claude');
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode('claude', 'abc');
    await tick(50);
    expect(manager.states().claude).toMatchObject({ phase: 'failed', failure: 'rejected' });
  });

  it('turns away codes it shouldn’t pass on, and stays ready for the right one', async () => {
    const { manager, processes } = setup();
    await expect(manager.submitCode('claude', 'abc')).rejects.toThrow(/ended/);
    await manager.start('claude');
    await expect(manager.submitCode('claude', 'abc')).rejects.toThrow(/isn’t waiting/);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await expect(manager.submitCode('claude', 'abc#not-this-sign-in')).rejects.toThrow(/earlier sign-in/);
    await expect(manager.submitCode('claude', 'sk-ant-api03-abc')).rejects.toThrow(/a key/);
    await expect(manager.submitCode('claude', 'abc\x1b[201~\rrm -rf /')).rejects.toThrow(/doesn’t look/);
    await expect(manager.submitCode('claude', '   ')).rejects.toThrow(/doesn’t look/);
    expect(processes[0].written).toEqual([]);
    expect(manager.states().claude?.phase).toBe('waiting');
  });

  it('fails clearly when the CLI stops, shows no link, or can’t start', async () => {
    const stopped = setup();
    await stopped.manager.start('claude');
    stopped.processes[0].exit(1);
    await tick();
    expect(stopped.manager.states().claude).toMatchObject({ phase: 'failed', failure: 'stopped' });

    const noLink = setup({}, { ...TIMINGS, noLinkMs: 20 });
    await noLink.manager.start('claude');
    noLink.processes[0].emit('something unexpected');
    await tick(50);
    expect(noLink.manager.states().claude).toMatchObject({ phase: 'failed', failure: 'no-link', output: 'something unexpected' });
    expect(noLink.processes[0].killed).toBe(true);

    const broken = setup({ spawn: async () => { throw new Error('no helper'); } });
    await broken.manager.start('claude');
    expect(broken.manager.states().claude).toMatchObject({ phase: 'failed', failure: 'unavailable', message: 'no helper' });
  });

  it('expires a sign-in left open', async () => {
    const { manager, processes } = setup({}, { ...TIMINGS, expiresMs: 20 });
    await manager.start('claude');
    processes[0].emit(promptFrames('claude-success'));
    await tick(50);
    expect(manager.states().claude).toMatchObject({ phase: 'failed', failure: 'expired' });
    expect(processes[0].killed).toBe(true);
  });

  it('reports a token it couldn’t save', async () => {
    const { manager, processes } = setup({ saveClaudeToken: async () => { throw new Error('disk full'); } });
    await manager.start('claude');
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode('claude', 'abc');
    processes[0].emit(recording('claude-success'));
    processes[0].exit(0);
    await tick();
    const failed = manager.states().claude!;
    expect(failed).toMatchObject({ phase: 'failed', failure: 'save-failed', message: 'disk full' });
    expect(failed.output).not.toContain('sk-ant-oat');
  });
});

describe('the Codex sign-in', () => {
  it('shows the code, then finishes by itself once approved', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes } = setup({ finishCodexLogin: finish });
    await manager.start('codex');
    processes[0].emit(recording('codex-success').subarray(0, recording('codex-success').indexOf(Buffer.from('Continue only'))));
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'waiting', code: 'FAKE-7CODE', url: 'http://platform.claude.com:8080/codex/device' });
    processes[0].exit(0);
    await tick();
    expect(finish).toHaveBeenCalledOnce();
    expect(manager.states().codex?.phase).toBe('done');
    expect(manager.states().codex?.code).toBeUndefined();
  });

  it('doesn’t call it done if the login didn’t take', async () => {
    const { manager, processes } = setup({ finishCodexLogin: async () => false });
    await manager.start('codex');
    processes[0].emit(recording('codex-success'));
    processes[0].exit(0);
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'failed', failure: 'stopped' });
  });

  it('says why when device sign-in is off, and puts the shared login back', async () => {
    const { manager, processes, cleanedUp } = setup();
    await manager.start('codex');
    processes[0].emit(recording('codex-disabled'));
    processes[0].exit(1);
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'failed', failure: 'disabled' });
    expect(cleanedUp).toEqual(['codex']);
  });
});

describe('starting and stopping a sign-in', () => {
  it('joins one already under way, and replaces one that’s finished', async () => {
    const { manager, processes } = setup();
    await Promise.all([manager.start('claude'), manager.start('claude')]);
    expect(processes).toHaveLength(1);
    processes[0].exit(1);
    await tick();
    expect(manager.states().claude?.phase).toBe('failed');
    await manager.start('claude');
    expect(processes).toHaveLength(2);
    expect(manager.states().claude?.phase).toBe('starting');
  });

  it('cancels cleanly, and stops anything that arrives afterwards from mattering', async () => {
    const { manager, processes, published, cleanedUp, saved } = setup();
    await manager.start('claude');
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.cancel('claude');
    expect(processes[0].killed).toBe(true);
    expect(manager.states().claude).toBeUndefined();
    expect(published.at(-1)).toBeNull();
    expect(cleanedUp).toEqual(['claude']);
    processes[0].exit(0);
    await tick();
    expect(saved).toEqual([]);
    expect(published.at(-1)).toBeNull();
  });

  it('kills a CLI that was still starting when the sign-in was cancelled, and says it’s gone', async () => {
    let release = () => {};
    const process = new FakeProcess();
    const { manager } = setup({
      spawn: () => new Promise((resolve) => {
        release = () => resolve(process);
      }),
    });
    const starting = manager.start('claude');
    await tick();
    await manager.cancel('claude');
    release();
    expect(await starting).toBeNull();
    expect(process.killed).toBe(true);
  });

  it('doesn’t blame the CLI for a slow start, or lose track of one that ends up expired', async () => {
    let release = () => {};
    const process = new FakeProcess();
    const slow = setup({
      spawn: () => new Promise((resolve) => {
        release = () => resolve(process);
      }),
    }, { ...TIMINGS, noLinkMs: 20, expiresMs: 60 });
    const starting = slow.manager.start('claude');
    await tick(40);
    expect(slow.manager.states().claude?.phase).toBe('starting');
    await tick(40);
    expect(slow.manager.states().claude?.failure).toBe('expired');
    release();
    await starting;
    expect(process.killed).toBe(true);
  });

  it('tells a page that’s out of step that nothing is under way', async () => {
    const { manager, published } = setup();
    await manager.cancel('claude');
    expect(published).toEqual([null]);
  });
});
