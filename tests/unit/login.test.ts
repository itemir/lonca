import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LoginMethod, LoginState } from '../../shared/types.ts';
import {
  LoginScreen, askingConsent, classifyCodexFailure, classifyGeminiFailure, findClaudeLink, findClaudeToken, findCodexDevice, findGeminiCodeLink,
  findRedirectLink, geminiIneligibility, geminiNeedsProject, isClaudeCodeRejected, isGeminiCodeRejected, isGeminiConsent, linkClientId, redact,
} from '../../server/agents/login.ts';
import { LOGIN_TIMINGS, type LoginDriver, LoginManager, type LoginProcess, type ReturnOutcome, listenForReturn } from '../../server/login.ts';

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
    for (const name of ['claude-success', 'claude-redirect-success']) {
      for (const seed of [1, 7, 99, 12345]) {
        const screen = await render(name, seed);
        expect(findClaudeToken(screen.text())).toBe(FAKE_TOKEN);
        screen.dispose();
      }
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

  it('tells the page that comes back from the page that shows a code, on Claude’s screen', async () => {
    const screen = await render('claude-redirect-success');
    const redirect = findRedirectLink(screen)!;
    expect(new URL(redirect.url).hostname).toBe('claude.com');
    expect(redirect).toMatchObject({ path: '/callback', port: expect.any(Number), state: new URL(redirect.url).searchParams.get('state') });
    const paste = findClaudeLink(screen)!;
    expect(new URL(paste).searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(new URL(paste).searchParams.get('state')).toBe(redirect.state);
    screen.dispose();
  });

  it('finds Codex’s page that comes back, which it prints', async () => {
    const screen = await render('codex-redirect-success');
    const redirect = findRedirectLink(screen)!;
    expect(new URL(redirect.url).hostname).toBe('auth.openai.com');
    expect(redirect).toMatchObject({ port: 1455, path: '/auth/callback' });
    expect(redirect.state).toBeTruthy();
    screen.dispose();
  });

  it('doesn’t take just any link for one that comes back', async () => {
    const shown = async (text: string) => {
      const screen = new LoginScreen();
      await screen.write(`${text}\r\nwhat comes after it\r\n`);
      const redirect = findRedirectLink(screen);
      screen.dispose();
      return redirect;
    };
    const link = (back: string, state = '&state=s') => `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(back)}${state}`;
    expect(await shown(link('http://localhost:1234/cb'))).toMatchObject({ port: 1234, path: '/cb', state: 's' });
    expect(await shown(link('http://127.0.0.1:1234/cb'))).toMatchObject({ port: 1234 });
    expect(await shown(link('https://platform.example.com/cb'))).toBeNull();
    expect(await shown(link('http://evil.example.com:1234/cb'))).toBeNull();
    expect(await shown(link('http://localhost/cb'))).toBeNull();
    expect(await shown(link('http://localhost:1234/cb', ''))).toBeNull();
    expect(await shown('https://example.com/no-redirect?state=s')).toBeNull();
  });

  it('recognizes a code Claude refused', async () => {
    const screen = await render('claude-rejected');
    expect(isClaudeCodeRejected(screen.text())).toBe(true);
    expect(findClaudeToken(screen.text())).toBeNull();
    screen.dispose();
    const redirected = await render('claude-redirect-rejected');
    expect(isClaudeCodeRejected(redirected.text())).toBe(true);
    expect(findClaudeToken(redirected.text())).toBeNull();
    redirected.dispose();
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
    const turnedDown = await render('codex-redirect-denied');
    expect(classifyCodexFailure(turnedDown.text())).toBe('denied');
    turnedDown.dispose();
    const refused = await render('codex-redirect-rejected');
    expect(classifyCodexFailure(refused.text())).toBe('rejected');
    refused.dispose();
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

describe('reading Gemini’s screens', () => {
  it('finds its question before opening a browser, and the page that comes back, from the hyperlink it opens', async () => {
    const screen = await render('gemini-redirect-success');
    expect(isGeminiConsent(screen.text())).toBe(true);
    const redirect = findRedirectLink(screen)!;
    expect(new URL(redirect.url).hostname).toBe('accounts.google.com');
    expect(redirect).toMatchObject({ path: '/oauth2callback', port: expect.any(Number), state: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(new URL(redirect.url).searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${redirect.port}/oauth2callback`);
    expect(findGeminiCodeLink(screen.text())).toBeNull();
    screen.dispose();
  });

  it('finds the page that shows a code, printed over two rows, once it asks for the code', async () => {
    const data = recording('gemini-code-success');
    const prompt = data.indexOf(Buffer.from('Enter the authorization code: '));
    const screen = new LoginScreen();
    await screen.write(data.subarray(0, prompt));
    expect(findGeminiCodeLink(screen.text())).toBeNull();
    await screen.write(data.subarray(prompt, prompt + 'Enter the authorization code: '.length));
    const link = findGeminiCodeLink(screen.text())!;
    expect(new URL(link).searchParams.get('redirect_uri')).toBe('https://codeassist.google.com/authcode');
    expect(new URL(link).searchParams.get('code_challenge_method')).toBe('S256');
    expect(link.length).toBeGreaterThan(500);
    screen.dispose();
  });

  it('tells Gemini’s failures apart, and an account that needs a project from one Gemini won’t serve', async () => {
    const reads: Record<string, [string, boolean, string | null]> = {
      'gemini-redirect-rejected': ['rejected', false, null],
      'gemini-redirect-denied': ['denied', false, null],
      'gemini-code-rejected': ['rejected', false, null],
      'gemini-redirect-project': ['stopped', true, null],
      'gemini-code-ineligible': ['stopped', false, 'Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.'],
      'gemini-redirect-success': ['stopped', false, null],
    };
    for (const [name, [failure, project, ineligible]] of Object.entries(reads)) {
      const screen = await render(name);
      expect(classifyGeminiFailure(screen.text())).toBe(failure);
      expect(geminiNeedsProject(screen.text())).toBe(project);
      expect(geminiIneligibility(screen.text())).toBe(ineligible);
      screen.dispose();
    }
    const refused = await render('gemini-code-rejected');
    expect(isGeminiCodeRejected(refused.text())).toBe(true);
    refused.dispose();
    expect(classifyGeminiFailure('Authorization timed out after 5 minutes.')).toBe('expired');
  });
});

class FakeProcess implements LoginProcess {
  written: string[] = [];
  delivered: { port: number; path: string }[] = [];
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

  async deliver(port: number, path: string): Promise<void> {
    this.delivered.push({ port, path });
  }

  savedLogin = async (): Promise<string> => 'what the CLI saved';

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
// Each provider's first sign-in, whose id is the provider's.
const CLAUDE = { agent: 'claude', profileId: 'claude' } as const;
const CODEX = { agent: 'codex', profileId: 'codex' } as const;
const GEMINI = { agent: 'gemini', profileId: 'gemini' } as const;

function setup(overrides: Partial<LoginDriver> = {}, timings = TIMINGS) {
  const processes: FakeProcess[] = [];
  const methods: LoginMethod[] = [];
  const published: (LoginState | null)[] = [];
  const saved: string[] = [];
  const ports = new Map<number, (target: URL) => Promise<ReturnOutcome>>();
  const driver: LoginDriver = {
    spawn: async (_agent, method) => {
      const process = new FakeProcess();
      processes.push(process);
      methods.push(method);
      return process;
    },
    listen: async (port, onReturn) => {
      ports.set(port, onReturn);
      return () => ports.delete(port);
    },
    checkClaudeToken: async () => {},
    saveClaudeToken: async (token) => {
      saved.push(token);
    },
    finishCodexLogin: async () => true,
    finishGeminiLogin: async (login) => Boolean(login),
    publish: (_agent, login) => published.push(login),
    ...overrides,
  };
  return { manager: new LoginManager(driver, timings), processes, methods, published, saved, ports };
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
    await manager.start(CLAUDE);
    expect(manager.states().claude?.phase).toBe('starting');
    const process = processes[0];
    process.emit(promptFrames('claude-success'));
    await tick();
    const waiting = manager.states().claude!;
    expect(waiting.phase).toBe('waiting');
    expect(waiting.url).toBeUndefined();
    const state = new URL(waiting.pasteUrl!).searchParams.get('state');

    const submitted = manager.submitCode(CLAUDE, `abc#${state}`);
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
    expect(manager.output(CLAUDE)).not.toContain('sk-ant-oat');
  });

  it('saves the token even if the CLI exits before the screen has settled', async () => {
    const { manager, processes, saved } = setup({}, { ...TIMINGS, settledMs: 60000 });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode(CLAUDE, 'abc');
    processes[0].emit(recording('claude-success'));
    processes[0].exit(0);
    await tick();
    expect(saved).toEqual([FAKE_TOKEN]);
    expect(manager.states().claude?.phase).toBe('done');
  });

  it('reports a refused code and stops the CLI, which would otherwise wait forever', async () => {
    const { manager, processes, published } = setup();
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-rejected'));
    await tick();
    await manager.submitCode(CLAUDE, 'wrong');
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
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode(CLAUDE, 'abc');
    processes[0].emit('\r\nCouldn’t verify your organization’s settings (a network proxy answered instead of Anthropic).\r\n\r\nPress Enter to retry.\r\n');
    await tick();
    const failed = manager.states().claude!;
    expect(failed).toMatchObject({ phase: 'failed', failure: 'stopped' });
    expect(failed.output).toContain('a network proxy answered');
    expect(processes[0].killed).toBe(true);
  });

  it('gives up when nothing comes back after a code', async () => {
    const { manager, processes } = setup({}, { ...TIMINGS, codeResultMs: 20 });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode(CLAUDE, 'abc');
    await tick(50);
    expect(manager.states().claude).toMatchObject({ phase: 'failed', failure: 'rejected' });
  });

  it('turns away codes it shouldn’t pass on, and stays ready for the right one', async () => {
    const { manager, processes } = setup();
    await expect(manager.submitCode(CLAUDE, 'abc')).rejects.toThrow(/ended/);
    await manager.start(CLAUDE);
    await expect(manager.submitCode(CLAUDE, 'abc')).rejects.toThrow(/isn’t waiting/);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await expect(manager.submitCode(CLAUDE, 'abc#not-this-sign-in')).rejects.toThrow(/earlier sign-in/);
    await expect(manager.submitCode(CLAUDE, 'sk-ant-api03-abc')).rejects.toThrow(/a key/);
    await expect(manager.submitCode(CLAUDE, 'abc\x1b[201~\rrm -rf /')).rejects.toThrow(/doesn’t look/);
    await expect(manager.submitCode(CLAUDE, '   ')).rejects.toThrow(/doesn’t look/);
    expect(processes[0].written).toEqual([]);
    expect(manager.states().claude?.phase).toBe('waiting');
  });

  it('fails clearly when the CLI stops, shows no link, or can’t start', async () => {
    const stopped = setup();
    await stopped.manager.start(CLAUDE);
    stopped.processes[0].exit(1);
    await tick();
    expect(stopped.manager.states().claude).toMatchObject({ phase: 'failed', failure: 'stopped' });

    const noLink = setup({}, { ...TIMINGS, noLinkMs: 20 });
    await noLink.manager.start(CLAUDE);
    noLink.processes[0].emit('something unexpected');
    await tick(50);
    expect(noLink.manager.states().claude).toMatchObject({ phase: 'failed', failure: 'no-link', output: 'something unexpected' });
    expect(noLink.processes[0].killed).toBe(true);

    const broken = setup({ spawn: async () => { throw new Error('no helper'); } });
    await broken.manager.start(CLAUDE);
    expect(broken.manager.states().claude).toMatchObject({ phase: 'failed', failure: 'unavailable', message: 'no helper' });
  });

  it('expires a sign-in left open', async () => {
    const { manager, processes } = setup({}, { ...TIMINGS, expiresMs: 20 });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick(50);
    expect(manager.states().claude).toMatchObject({ phase: 'failed', failure: 'expired' });
    expect(processes[0].killed).toBe(true);
  });

  it('reports a token it couldn’t save', async () => {
    const { manager, processes } = setup({ saveClaudeToken: async () => { throw new Error('disk full'); } });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode(CLAUDE, 'abc');
    processes[0].emit(recording('claude-success'));
    processes[0].exit(0);
    await tick();
    const failed = manager.states().claude!;
    expect(failed).toMatchObject({ phase: 'failed', failure: 'save-failed', message: 'disk full' });
    expect(failed.output).not.toContain('sk-ant-oat');
  });
});

describe('the Codex sign-in with a one-time code', () => {
  it('shows the code, then finishes by itself once approved', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes } = setup({ finishCodexLogin: finish });
    await manager.start(CODEX, 'device');
    processes[0].emit(recording('codex-success').subarray(0, recording('codex-success').indexOf(Buffer.from('Continue only'))));
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'waiting', code: 'FAKE-7CODE', url: 'http://platform.claude.com:8080/codex/device' });
    processes[0].exit(0);
    await tick();
    expect(finish).toHaveBeenCalledExactlyOnceWith('what the CLI saved', { agent: 'codex', profileId: 'codex' });
    expect(manager.states().codex?.phase).toBe('done');
    expect(manager.states().codex?.code).toBeUndefined();
    expect(processes[0].killed).toBe(true);
  });

  it('keeps nothing from an attempt cancelled while its login was being read', async () => {
    const finish = vi.fn(async () => true);
    let read = (_login: string) => {};
    const { manager, processes } = setup({ finishCodexLogin: finish });
    await manager.start(CODEX, 'device');
    processes[0].savedLogin = () => new Promise((resolve) => {
      read = resolve;
    });
    processes[0].emit(recording('codex-success'));
    processes[0].exit(0);
    await tick();
    expect(manager.states().codex?.phase).toBe('saving');
    await manager.cancel(CODEX);
    read('a login');
    await tick();
    expect(finish).not.toHaveBeenCalled();
    expect(processes[0].killed).toBe(true);
  });

  it('doesn’t call it done if the login didn’t take', async () => {
    const { manager, processes } = setup({ finishCodexLogin: async () => false });
    await manager.start(CODEX, 'device');
    processes[0].emit(recording('codex-success'));
    processes[0].exit(0);
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'failed', failure: 'stopped' });
  });

  it('says why when device sign-in is off, and leaves nothing behind', async () => {
    const { manager, processes } = setup();
    await manager.start(CODEX, 'device');
    processes[0].emit(recording('codex-disabled'));
    processes[0].exit(1);
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'failed', failure: 'disabled' });
    expect(processes[0].killed).toBe(true);
  });
});

/** Codex's real frames from before anything has come back to it. */
function codexPrompt(name: string): Buffer {
  const data = recording(name);
  return data.subarray(0, data.indexOf(Buffer.from('\n'), data.indexOf(Buffer.from('On a remote'))) + 1);
}

/** What a browser asks for when the sign-in page sends it back. */
function returning(link: string, extra = 'code=abc'): URL {
  const url = new URL(link);
  const back = new URL(url.searchParams.get('redirect_uri')!);
  return new URL(`${back.pathname}?${extra}&state=${url.searchParams.get('state')}`, 'http://localhost');
}

function portOf(link: string): number {
  return Number(new URL(new URL(link).searchParams.get('redirect_uri')!).port);
}

describe('coming back from the sign-in page', () => {
  it('Claude: goes from the browser’s return to a saved token with nothing typed', async () => {
    const { manager, processes, saved, published, ports } = setup();
    await manager.start(CLAUDE);
    const process = processes[0];
    process.emit(promptFrames('claude-redirect-success'));
    await tick();
    const waiting = manager.states().claude!;
    expect(waiting.phase).toBe('waiting');
    expect(new URL(waiting.url!).searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(new URL(waiting.pasteUrl!).searchParams.get('redirect_uri')).toMatch(/^https:/);
    const port = portOf(waiting.url!);

    const target = returning(waiting.url!);
    let outcome: ReturnOutcome | undefined;
    void ports.get(port)!(target).then((value) => {
      outcome = value;
    });
    await tick();
    expect(manager.states().claude?.phase).toBe('submitting');
    expect(process.delivered).toEqual([{ port, path: target.pathname + target.search }]);
    // The browser hears how it went, which the CLI's own answer wouldn't have said.
    expect(outcome).toBeUndefined();

    process.emit(recording('claude-redirect-success'));
    await tick();
    process.exit(0);
    await tick();
    expect(manager.states().claude?.phase).toBe('done');
    expect(saved).toEqual([FAKE_TOKEN]);
    expect(outcome).toBe('done');
    expect(process.written).toEqual([]);
    expect(ports.size).toBe(0);
    expect(JSON.stringify(published)).not.toContain('sk-ant-oat');
  });

  it('Claude: tells the browser when the CLI refused the sign-in, and stops listening', async () => {
    const { manager, processes, ports } = setup();
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-redirect-rejected'));
    await tick();
    const { url } = manager.states().claude!;
    const outcome = ports.get(portOf(url!))!(returning(url!));
    processes[0].emit(recording('claude-redirect-rejected'));
    expect(await outcome).toBe('failed');
    expect(manager.states().claude).toMatchObject({ phase: 'failed', failure: 'rejected' });
    expect(processes[0].killed).toBe(true);
    expect(ports.size).toBe(0);
  });

  it('turns away anything but the sign-in page, which is the only thing that knows the state', async () => {
    const { manager, processes, ports } = setup();
    await manager.start(CODEX);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    const { url } = manager.states().codex!;
    const onReturn = ports.get(1455)!;
    const state = new URL(url!).searchParams.get('state');
    const asked = (target: string) => onReturn(new URL(target, 'http://localhost'));
    expect(await asked('/auth/callback?code=abc')).toBeNull();
    expect(await asked('/auth/callback?code=abc&state=not-it')).toBeNull();
    // Codex's own listener would end the sign-in for these, with or without a state.
    expect(await asked('/cancel')).toBeNull();
    expect(await asked(`/cancel?state=${state}`)).toBeNull();
    expect(await asked('/success')).toBeNull();
    expect(await asked(`/success?id_token=x&state=${state}`)).toBeNull();
    expect(await asked('/favicon.ico')).toBeNull();
    expect(processes[0].delivered).toEqual([]);
    expect(manager.states().codex?.phase).toBe('waiting');
  });

  it('passes on one return, however many times the browser asks', async () => {
    const { manager, processes, ports } = setup();
    await manager.start(CODEX);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    const { url } = manager.states().codex!;
    const first = ports.get(1455)!(returning(url!));
    const second = ports.get(1455)!(returning(url!));
    await tick();
    expect(processes[0].delivered).toHaveLength(1);
    processes[0].exit(0);
    expect(await first).toBe('done');
    expect(await second).toBe('done');
  });

  it('Codex: finishes when the CLI exits, having shared its login, and never publishes the answer', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes, methods, published, ports } = setup({ finishCodexLogin: finish });
    await manager.start(CODEX);
    expect(methods).toEqual(['browser']);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    const waiting = manager.states().codex!;
    expect(waiting).toMatchObject({ phase: 'waiting' });
    expect(waiting.code).toBeUndefined();
    expect(new URL(waiting.url!).hostname).toBe('auth.openai.com');

    const target = returning(waiting.url!, 'code=the-code-from-the-page');
    const outcome = ports.get(1455)!(target);
    await tick();
    expect(manager.states().codex?.phase).toBe('submitting');
    expect(processes[0].delivered).toEqual([{ port: 1455, path: target.pathname + target.search }]);

    processes[0].emit(recording('codex-redirect-success'));
    processes[0].exit(0);
    expect(await outcome).toBe('done');
    expect(finish).toHaveBeenCalledOnce();
    expect(manager.states().codex?.phase).toBe('done');
    expect(manager.states().codex?.url).toBeUndefined();
    expect(ports.size).toBe(0);
    expect(JSON.stringify(published)).not.toContain('the-code-from-the-page');
  });

  it('Codex: doesn’t take a printed link until it has all of it, wherever the output was cut', async () => {
    const { manager, processes, ports } = setup();
    await manager.start(CODEX);
    // Without its hyperlink, which arrives whole, so that only the printed one can be cut.
    const printed = Buffer.from(codexPrompt('codex-redirect-success').toString('latin1').replace(/\x1b\]8;;[^\x07]*\x07/g, ''), 'latin1');
    const cut = printed.indexOf(Buffer.from('state=')) + 'state='.length + 8;
    processes[0].emit(printed.subarray(0, cut));
    await tick();
    expect(manager.states().codex?.phase).toBe('starting');
    expect(ports.size).toBe(0);

    processes[0].emit(printed.subarray(cut));
    await tick();
    const { url } = manager.states().codex!;
    const state = /[?&]state=([^&\s]+)/.exec(printed.toString('latin1'))![1];
    expect(new URL(url!).searchParams.get('state')).toBe(state);
    expect(new URL(url!).searchParams.get('scope')).toBeTruthy();
    expect(ports.size).toBe(1);
  });

  it('Claude: only offers the paste page alone if the port really couldn’t be opened', async () => {
    let release = () => {};
    const { manager, processes, published } = setup({
      listen: () => new Promise((resolve) => {
        release = () => resolve(() => {});
      }),
    });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-redirect-success'));
    await tick();
    expect(manager.states().claude?.phase).toBe('starting');
    release();
    await tick();
    expect(manager.states().claude).toMatchObject({ phase: 'waiting', url: expect.any(String), pasteUrl: expect.any(String) });
    expect(published.filter((state) => state?.pasteUrl && !state.url)).toEqual([]);
  });

  it('doesn’t blame a sign-in the CLI has finished for a return it couldn’t follow to the end', async () => {
    let refuse = (_error: Error) => {};
    let saved = () => {};
    const { manager, processes, ports } = setup({
      finishCodexLogin: () => new Promise((resolve) => {
        saved = () => resolve(true);
      }),
    });
    await manager.start(CODEX);
    processes[0].deliver = () => new Promise((_resolve, reject) => {
      refuse = reject;
    });
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    const outcome = ports.get(1455)!(returning(manager.states().codex!.url!));
    await tick();
    processes[0].exit(0);
    await tick();
    expect(manager.states().codex?.phase).toBe('saving');
    refuse(new Error('docker went away'));
    await tick();
    expect(manager.states().codex?.phase).toBe('saving');
    saved();
    expect(await outcome).toBe('done');
    expect(manager.states().codex?.phase).toBe('done');
  });

  it('doesn’t save a token if the sign-in was cancelled while it was being checked', async () => {
    let checked = () => {};
    const { manager, processes, saved } = setup({
      checkClaudeToken: () => new Promise((resolve) => {
        checked = resolve;
      }),
    });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode(CLAUDE, 'abc');
    processes[0].emit(recording('claude-success'));
    processes[0].exit(0);
    await tick();
    expect(manager.states().claude?.phase).toBe('saving');
    await manager.cancel(CLAUDE);
    checked();
    await tick();
    expect(saved).toEqual([]);
  });

  it('doesn’t let an attempt that’s over say it worked, over the one that replaced it', async () => {
    let saved = () => {};
    const { manager, processes, published } = setup({
      saveClaudeToken: () => new Promise((resolve) => {
        saved = resolve;
      }),
    }, { ...TIMINGS, expiresMs: 300 });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.submitCode(CLAUDE, 'abc');
    processes[0].emit(recording('claude-success'));
    processes[0].exit(0);
    await tick();
    expect(manager.states().claude?.phase).toBe('saving');
    await tick(320);
    expect(manager.states().claude).toMatchObject({ phase: 'failed', failure: 'expired' });

    await manager.start(CLAUDE);
    expect(manager.states().claude?.phase).toBe('starting');
    saved();
    await tick();
    expect(manager.states().claude?.phase).toBe('starting');
    expect(published.map((state) => state?.phase)).not.toContain('done');
  });

  it('remembers which way it’s signing in, for the page to pick up after a reload', async () => {
    const { manager } = setup();
    await manager.start(CODEX, 'device');
    expect(manager.states().codex?.method).toBe('device');
    await manager.cancel(CODEX);
    await manager.start(CODEX);
    expect(manager.states().codex?.method).toBe('browser');
  });

  it('Codex: tells a page that said no from a sign-in the service refused', async () => {
    for (const [name, failure] of [['codex-redirect-denied', 'denied'], ['codex-redirect-rejected', 'rejected']] as const) {
      const { manager, processes, ports } = setup();
      await manager.start(CODEX);
      processes[0].emit(codexPrompt(name));
      await tick();
      const { url } = manager.states().codex!;
      const outcome = ports.get(1455)!(returning(url!));
      processes[0].emit(recording(name));
      processes[0].exit(1);
      expect(await outcome).toBe('failed');
      expect(manager.states().codex).toMatchObject({ phase: 'failed', failure });
      await tick();
      expect(processes[0].killed).toBe(true);
      expect(ports.size).toBe(0);
    }
  });

  it('Claude: still works by pasting a code if the port is taken', async () => {
    const { manager, processes, saved } = setup({ listen: async () => { throw new Error('EADDRINUSE'); } });
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-redirect-success'));
    await tick();
    const waiting = manager.states().claude!;
    expect(waiting.phase).toBe('waiting');
    expect(waiting.url).toBeUndefined();
    expect(waiting.pasteUrl).toBeTruthy();
    await manager.submitCode(CLAUDE, `abc#${new URL(waiting.pasteUrl!).searchParams.get('state')}`);
    processes[0].emit(recording('claude-redirect-success'));
    processes[0].exit(0);
    await tick();
    expect(saved).toEqual([FAKE_TOKEN]);
    expect(manager.states().claude?.phase).toBe('done');
  });

  it('Claude: won’t take a code until it’s got to its prompt, some seconds after the page that comes back', async () => {
    const { manager, processes } = setup();
    await manager.start(CLAUDE);
    const frames = promptFrames('claude-redirect-success');
    processes[0].emit(frames.subarray(0, frames.indexOf(Buffer.from('Browser'))));
    await tick();
    expect(manager.states().claude).toMatchObject({ phase: 'waiting', url: expect.any(String) });
    expect(manager.states().claude?.pasteUrl).toBeUndefined();
    await expect(manager.submitCode(CLAUDE, 'abc')).rejects.toThrow(/isn’t waiting/);
    expect(processes[0].written).toEqual([]);
  });

  it('Codex: has nothing to paste a code into', async () => {
    const { manager, processes } = setup();
    await manager.start(CODEX);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    await expect(manager.submitCode(CODEX, 'abc')).rejects.toThrow(/isn’t waiting/);
    expect(processes[0].written).toEqual([]);
  });

  it('Claude: a code pasted while the page could still come back works too', async () => {
    const { manager, processes, saved, ports } = setup();
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-redirect-success'));
    await tick();
    const { pasteUrl, url } = manager.states().claude!;
    await manager.submitCode(CLAUDE, `abc#${new URL(pasteUrl!).searchParams.get('state')}`);
    expect(processes[0].written[0]).toContain('abc#');
    // The browser turning up after all doesn't hand the CLI a second answer.
    const late = ports.get(portOf(url!))!(returning(url!));
    await tick();
    expect(processes[0].delivered).toEqual([]);
    processes[0].emit(recording('claude-redirect-success'));
    processes[0].exit(0);
    expect(await late).toBe('done');
    expect(saved).toEqual([FAKE_TOKEN]);
  });

  it('Codex: says the port is taken, and the one-time code doesn’t need it', async () => {
    const listen = vi.fn(async () => { throw new Error('EADDRINUSE'); });
    const { manager, processes, methods } = setup({ listen });
    await manager.start(CODEX);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'failed', failure: 'port-busy', message: '1455' });
    expect(processes[0].killed).toBe(true);

    await manager.start(CODEX, 'device');
    expect(methods).toEqual(['browser', 'device']);
    processes[1].emit(recording('codex-success'));
    await tick();
    expect(manager.states().codex).toMatchObject({ phase: 'waiting', code: 'FAKE-7CODE' });
    expect(listen).toHaveBeenCalledOnce();
  });

  it('moves over to the one-time code, stopping the CLI and the port, and joins it after that', async () => {
    const { manager, processes, methods, ports, published } = setup();
    await manager.start(CODEX);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    expect(ports.size).toBe(1);

    await manager.start(CODEX, 'device');
    expect(methods).toEqual(['browser', 'device']);
    expect(processes[0].killed).toBe(true);
    expect(ports.size).toBe(0);
    expect(manager.states().codex?.phase).toBe('starting');
    expect(published).not.toContain(null);

    await manager.start(CODEX, 'device');
    expect(processes).toHaveLength(2);

    // The first CLI has gone. It doesn't get to end the sign-in that replaced it.
    processes[0].exit(1);
    await tick();
    expect(manager.states().codex?.phase).toBe('starting');
  });

  it('answers a browser that’s still waiting when the sign-in is cancelled, and frees the port', async () => {
    const { manager, processes, ports } = setup();
    await manager.start(CODEX);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    const { url } = manager.states().codex!;
    const outcome = ports.get(1455)!(returning(url!));
    await tick();
    await manager.cancel(CODEX);
    expect(await outcome).toBe('failed');
    expect(ports.size).toBe(0);
  });

  it('frees a port that was only just opened when the sign-in was cancelled', async () => {
    let release = () => {};
    const stop = vi.fn();
    const { manager, processes } = setup({
      listen: () => new Promise((resolve) => {
        release = () => resolve(stop);
      }),
    });
    await manager.start(CODEX);
    processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    await manager.cancel(CODEX);
    release();
    await tick();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('fails clearly if the return can’t be passed to the CLI, or the CLI never says anything', async () => {
    const stuck = setup();
    await stuck.manager.start(CODEX);
    stuck.processes[0].deliver = async () => { throw new Error('docker went away'); };
    stuck.processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    const outcome = stuck.ports.get(1455)!(returning(stuck.manager.states().codex!.url!));
    expect(await outcome).toBe('failed');
    expect(stuck.manager.states().codex).toMatchObject({ phase: 'failed', failure: 'stopped', message: 'docker went away' });

    const silent = setup({}, { ...TIMINGS, codeResultMs: 20 });
    await silent.manager.start(CODEX);
    silent.processes[0].emit(codexPrompt('codex-redirect-success'));
    await tick();
    const ignored = silent.ports.get(1455)!(returning(silent.manager.states().codex!.url!));
    expect(await ignored).toBe('failed');
    expect(silent.manager.states().codex).toMatchObject({ phase: 'failed', failure: 'rejected' });
  });
});

describe('the port a browser comes back to', () => {
  const freePort = () => new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

  const ask = (port: number, target: string, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: target, method, agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.on('error', reject);
    request.end();
  });

  it('shows how the sign-in went, and nothing for anyone else', async () => {
    const port = await freePort();
    const onReturn = vi.fn(async (target: URL): Promise<ReturnOutcome> => {
      const state = target.searchParams.get('state');
      return state === 'good' ? 'done' : state === 'bad' ? 'failed' : null;
    });
    const stop = await listenForReturn(port, onReturn);
    try {
      expect(await ask(port, '/callback?state=good')).toMatchObject({ status: 200, body: expect.stringContaining('You’re signed in') });
      expect(onReturn.mock.lastCall![0].search).toBe('?state=good');
      expect(await ask(port, '/callback?state=bad')).toMatchObject({ status: 200, body: expect.stringContaining('didn’t finish') });
      expect(await ask(port, '/callback?state=other')).toEqual({ status: 404, body: 'Not found' });

      onReturn.mockClear();
      expect((await ask(port, '/callback?state=good', 'POST')).status).toBe(404);
      expect((await ask(port, '//')).status).toBe(404);
      expect(onReturn).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('never repeats what it was asked in its answer', async () => {
    const port = await freePort();
    const stop = await listenForReturn(port, async () => 'failed');
    try {
      const { body } = await ask(port, '/callback?error=%3Cscript%3Ealert(1)%3C/script%3E&code=the-code');
      expect(body).not.toContain('script>alert');
      expect(body).not.toContain('the-code');
    } finally {
      stop();
    }
  });

  it('reports a port that’s taken, and lets go of one it’s done with', async () => {
    const port = await freePort();
    const stop = await listenForReturn(port, async () => null);
    await expect(listenForReturn(port, async () => null)).rejects.toThrow(/EADDRINUSE/);
    stop();
    await expect(ask(port, '/')).rejects.toThrow(/ECONNREFUSED/);
    const again = await listenForReturn(port, async () => null);
    again();
  });

  it('finishes answering a browser that was waiting when it was told to stop', async () => {
    const port = await freePort();
    let finish = (_outcome: ReturnOutcome) => {};
    const stop = await listenForReturn(port, () => new Promise((resolve) => {
      finish = resolve;
    }));
    const answer = ask(port, '/callback');
    await tick();
    finish('done');
    stop();
    expect((await answer).status).toBe(200);
  });
});

/** Gemini's real frames up to the hyperlink it opens, or to where it asks for a code. */
function geminiPrompt(name: string): Buffer {
  const data = recording(name);
  const asked = data.indexOf(Buffer.from('Enter the authorization code: '));
  if (asked >= 0) return data.subarray(0, asked + 'Enter the authorization code: '.length);
  const link = data.indexOf(Buffer.from('\x1b]8;;https://'));
  return data.subarray(0, data.indexOf(Buffer.from('\x1b]8;;\x07'), link) + 4);
}

/** The link the CLI handed its browser in a recording. */
function geminiLink(name: string): string {
  const data = recording(name).toString('latin1');
  return /\x1b\]8;;(https:\/\/[^\x07]+)\x07/.exec(data)![1];
}

describe('the Gemini sign-in', () => {
  // As the recordings have it, in place of the CLI's own.
  const RECORDED_CLIENT = '123456789012-loncamadeupclientforrecordings00.apps.googleusercontent.com';

  it('says to go on to the browser, once, and finishes when the CLI has saved a login', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes, methods, ports, published } = setup({ finishGeminiLogin: finish });
    await manager.start(GEMINI);
    expect(methods).toEqual(['browser']);
    const process = processes[0];
    const prompt = geminiPrompt('gemini-redirect-success');
    process.emit(prompt.subarray(0, prompt.indexOf(Buffer.from('\x1b]8;;'))));
    await tick();
    expect(process.written).toEqual(['\r']);
    expect(manager.states().gemini?.phase).toBe('starting');
    process.emit(prompt.subarray(prompt.indexOf(Buffer.from('\x1b]8;;'))));
    await tick();
    const waiting = manager.states().gemini!;
    expect(waiting.phase).toBe('waiting');
    expect(new URL(waiting.url!).hostname).toBe('accounts.google.com');
    // Choosing the account, and so that Google gives a refresh token to one that has let the CLI in before.
    expect(new URL(waiting.url!).searchParams.get('prompt')).toBe('select_account consent');
    expect(waiting.url!.startsWith(geminiLink('gemini-redirect-success'))).toBe(true);
    expect(waiting.pasteUrl).toBeUndefined();
    const port = portOf(waiting.url!);
    const target = returning(waiting.url!, 'code=4/the-code-from-the-page');
    const outcome = ports.get(port)!(target);
    await tick();
    expect(manager.states().gemini?.phase).toBe('submitting');
    expect(process.delivered).toEqual([{ port, path: target.pathname + target.search }]);
    process.emit(recording('gemini-redirect-success').subarray(prompt.length));
    process.exit(0);
    expect(await outcome).toBe('done');
    expect(finish).toHaveBeenCalledExactlyOnceWith('what the CLI saved', GEMINI, { clientId: RECORDED_CLIENT, needsProject: false, current: expect.any(Function) });
    expect(manager.states().gemini).toMatchObject({ phase: 'done' });
    expect(manager.states().gemini?.needsProject).toBeUndefined();
    expect(process.written).toEqual(['\r']);
    expect(ports.size).toBe(0);
    expect(JSON.stringify(published)).not.toContain('the-code-from-the-page');
  });

  it('says so when the account needs a Google Cloud project, and keeps the login', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes, ports } = setup({ finishGeminiLogin: finish });
    await manager.start(GEMINI);
    processes[0].emit(geminiPrompt('gemini-redirect-project'));
    await tick();
    const { url } = manager.states().gemini!;
    const outcome = ports.get(portOf(url!))!(returning(url!));
    processes[0].emit(recording('gemini-redirect-project'));
    processes[0].exit(0);
    expect(await outcome).toBe('done');
    // So that it's kept with the login, for Settings to say.
    expect(finish).toHaveBeenCalledExactlyOnceWith('what the CLI saved', GEMINI, expect.objectContaining({ needsProject: true }));
    expect(manager.states().gemini).toMatchObject({ phase: 'done', needsProject: true });
  });

  it('tells a refused or turned-down sign-in from one that worked, though the CLI ends well either way', async () => {
    for (const [name, failure] of [['gemini-redirect-rejected', 'rejected'], ['gemini-redirect-denied', 'denied']] as const) {
      const finish = vi.fn(async (login: string) => Boolean(login));
      const { manager, processes, ports } = setup({ finishGeminiLogin: finish });
      await manager.start(GEMINI);
      processes[0].savedLogin = async () => '';
      processes[0].emit(geminiPrompt(name));
      await tick();
      const { url } = manager.states().gemini!;
      const outcome = ports.get(portOf(url!))!(returning(url!));
      processes[0].emit(recording(name));
      processes[0].exit(0);
      expect(await outcome).toBe('failed');
      expect(manager.states().gemini).toMatchObject({ phase: 'failed', failure });
      expect(finish).toHaveBeenCalledExactlyOnceWith('', GEMINI, expect.objectContaining({ clientId: RECORDED_CLIENT }));
      expect(ports.size).toBe(0);
    }
  });

  it('won’t keep an account Gemini won’t serve, and says why', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes } = setup({ finishGeminiLogin: finish });
    await manager.start(GEMINI, 'code');
    processes[0].emit(recording('gemini-code-ineligible'));
    processes[0].exit(0);
    await tick();
    expect(manager.states().gemini).toMatchObject({ phase: 'failed', failure: 'denied', message: expect.stringContaining('not eligible for Gemini Code Assist') });
    expect(finish).not.toHaveBeenCalled();
  });

  it('reports a sign-in Google wouldn’t renew, which would stop working within the hour', async () => {
    const { manager, processes, ports } = setup({ finishGeminiLogin: async () => { throw new Error('Google wouldn’t renew the sign-in (invalid_client)'); } });
    await manager.start(GEMINI);
    processes[0].emit(geminiPrompt('gemini-redirect-success'));
    await tick();
    const { url } = manager.states().gemini!;
    const outcome = ports.get(portOf(url!))!(returning(url!));
    processes[0].emit(recording('gemini-redirect-success'));
    processes[0].exit(0);
    expect(await outcome).toBe('failed');
    expect(manager.states().gemini).toMatchObject({ phase: 'failed', failure: 'save-failed', message: expect.stringContaining('invalid_client') });
  });

  it('with a code: shows the page, types the code as a paste and then Return, and finishes', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes, methods } = setup({ finishGeminiLogin: finish });
    await manager.start(GEMINI, 'code');
    expect(methods).toEqual(['code']);
    const process = processes[0];
    const prompt = geminiPrompt('gemini-code-success');
    process.emit(prompt.subarray(0, prompt.length - 10));
    await tick();
    expect(manager.states().gemini?.phase).toBe('starting');
    process.emit(prompt.subarray(prompt.length - 10));
    await tick();
    const waiting = manager.states().gemini!;
    expect(waiting).toMatchObject({ phase: 'waiting', method: 'code' });
    expect(waiting.url).toBeUndefined();
    expect(new URL(waiting.pasteUrl!).searchParams.get('redirect_uri')).toBe('https://codeassist.google.com/authcode');
    expect(new URL(waiting.pasteUrl!).searchParams.get('prompt')).toBe('select_account consent');

    await expect(manager.submitCode(GEMINI, `AIza${'k'.repeat(35)}`)).rejects.toThrow(/a key/);
    const submitted = manager.submitCode(GEMINI, '4/0AbCdEf-the-code');
    expect(manager.states().gemini?.phase).toBe('submitting');
    await submitted;
    expect(process.written).toEqual(['\x1b[200~4/0AbCdEf-the-code\x1b[201~', '\r']);
    process.emit(recording('gemini-code-success').subarray(prompt.length));
    process.exit(0);
    await tick();
    expect(finish).toHaveBeenCalledExactlyOnceWith('what the CLI saved', GEMINI, expect.objectContaining({ clientId: RECORDED_CLIENT }));
    expect(manager.states().gemini?.phase).toBe('done');
    expect(manager.states().gemini?.pasteUrl).toBeUndefined();
  });

  it('keeps nothing of an attempt that’s been cancelled or replaced while it finishes', async () => {
    for (const end of ['cancel', 'replace'] as const) {
      let attempt: import('../../server/login.ts').GeminiAttempt | undefined;
      let finished = (_kept: boolean) => {};
      const { manager, processes } = setup({
        finishGeminiLogin: (_login, _target, given) => new Promise<boolean>((resolve) => {
          attempt = given;
          finished = resolve;
        }),
      });
      await manager.start(GEMINI, 'code');
      processes[0].emit(geminiPrompt('gemini-code-success'));
      await tick();
      await manager.submitCode(GEMINI, '4/the-code');
      processes[0].emit(recording('gemini-code-success').subarray(geminiPrompt('gemini-code-success').length));
      processes[0].exit(0);
      await tick();
      expect(manager.states().gemini?.phase).toBe('saving');
      expect(attempt!.current()).toBe(true);
      if (end === 'cancel') await manager.cancel(GEMINI);
      else await manager.start(GEMINI);
      expect(attempt!.current()).toBe(false);
      finished(false);
      await tick();
      expect(manager.states().gemini?.phase).toBe(end === 'cancel' ? undefined : 'starting');
    }
  });

  it('asks to choose the account and for consent, on a link that doesn’t already say how to prompt', () => {
    const link = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&access_type=offline&scope=a%20b&client_id=x';
    expect(askingConsent(link)).toBe(`${link}&prompt=select_account%20consent`);
    expect(new URL(askingConsent(link)).searchParams.get('prompt')).toBe('select_account consent');
    expect(askingConsent(`${link}&prompt=select_account`)).toBe(`${link}&prompt=select_account`);
    expect(askingConsent('not a link')).toBe('not a link');
    expect(linkClientId(link)).toBe('x');
    expect(linkClientId('https://accounts.google.com/o/oauth2/v2/auth')).toBeUndefined();
  });

  it('with a code: reports one Google refused, and stops the CLI, which would ask again', async () => {
    const finish = vi.fn(async () => true);
    const { manager, processes } = setup({ finishGeminiLogin: finish });
    await manager.start(GEMINI, 'code');
    processes[0].emit(geminiPrompt('gemini-code-rejected'));
    await tick();
    await manager.submitCode(GEMINI, 'wrong');
    processes[0].emit(recording('gemini-code-rejected').subarray(geminiPrompt('gemini-code-rejected').length));
    await tick();
    expect(manager.states().gemini).toMatchObject({ phase: 'failed', failure: 'rejected' });
    expect(manager.states().gemini?.output).toContain('Failed to authenticate with authorization code');
    expect(processes[0].killed).toBe(true);
    expect(finish).not.toHaveBeenCalled();
  });

  it('says the port is taken, which a code doesn’t need, and moves over to the code', async () => {
    const listen = vi.fn(async () => { throw new Error('EADDRINUSE'); });
    const { manager, processes, methods } = setup({ listen });
    await manager.start(GEMINI);
    processes[0].emit(geminiPrompt('gemini-redirect-success'));
    await tick();
    expect(manager.states().gemini).toMatchObject({ phase: 'failed', failure: 'port-busy' });
    expect(processes[0].killed).toBe(true);
    await manager.start(GEMINI, 'code');
    expect(methods).toEqual(['browser', 'code']);
    processes[1].emit(geminiPrompt('gemini-code-success'));
    await tick();
    expect(manager.states().gemini).toMatchObject({ phase: 'waiting', pasteUrl: expect.stringContaining('accounts.google.com') });
    expect(listen).toHaveBeenCalledOnce();
  });
});

describe('starting and stopping a sign-in', () => {
  it('joins one already under way, and replaces one that’s finished', async () => {
    const { manager, processes } = setup();
    await Promise.all([manager.start(CLAUDE), manager.start(CLAUDE)]);
    expect(processes).toHaveLength(1);
    processes[0].exit(1);
    await tick();
    expect(manager.states().claude?.phase).toBe('failed');
    await manager.start(CLAUDE);
    expect(processes).toHaveLength(2);
    expect(manager.states().claude?.phase).toBe('starting');
  });

  it('cancels cleanly, and stops anything that arrives afterwards from mattering', async () => {
    const { manager, processes, published, saved } = setup();
    await manager.start(CLAUDE);
    processes[0].emit(promptFrames('claude-success'));
    await tick();
    await manager.cancel(CLAUDE);
    expect(processes[0].killed).toBe(true);
    expect(manager.states().claude).toBeUndefined();
    expect(published.at(-1)).toBeNull();
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
    const starting = manager.start(CLAUDE);
    await tick();
    await manager.cancel(CLAUDE);
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
    const starting = slow.manager.start(CLAUDE);
    await tick(40);
    expect(slow.manager.states().claude?.phase).toBe('starting');
    await tick(40);
    expect(slow.manager.states().claude?.failure).toBe('expired');
    release();
    await starting;
    expect(process.killed).toBe(true);
  });

  it('keeps one sign-in per provider under way, since they come back to the same port, and each to its own sign-in', async () => {
    const saved: { token: string; profileId: string }[] = [];
    const { manager, processes, published } = setup({ saveClaudeToken: async (token, target) => void saved.push({ token, profileId: target.profileId }) });
    const work = { agent: 'claude' as const, profileId: 'claude' };
    const personal = { agent: 'claude' as const, profileId: 'claude-aaaaaaaaaaaa' };
    await manager.start(work);
    await manager.start({ agent: 'codex', profileId: 'codex' });
    await manager.start(personal);
    expect(processes).toHaveLength(3);
    expect(processes[0].killed).toBe(true);
    expect(processes[1].killed).toBe(false);
    expect(Object.keys(manager.states()).sort()).toEqual(['claude-aaaaaaaaaaaa', 'codex']);
    expect(manager.states()['claude-aaaaaaaaaaaa']).toMatchObject({ agent: 'claude', profileId: 'claude-aaaaaaaaaaaa', phase: 'starting' });
    expect(published).toContainEqual(null);
    expect(manager.busy('claude')).toBe(true);
    processes[2].emit(promptFrames('claude-success'));
    await tick();
    const state = new URL(manager.states()['claude-aaaaaaaaaaaa']!.pasteUrl!).searchParams.get('state');
    await manager.submitCode(personal, `abc#${state}`);
    processes[2].emit(recording('claude-success'));
    await tick();
    processes[2].exit(0);
    await tick();
    expect(saved).toEqual([{ token: FAKE_TOKEN, profileId: 'claude-aaaaaaaaaaaa' }]);
    expect(manager.busy('claude')).toBe(false);
  });

  it('tells a page that’s out of step that nothing is under way', async () => {
    const { manager, published } = setup();
    await manager.cancel(CLAUDE);
    expect(published).toEqual([null]);
  });
});
