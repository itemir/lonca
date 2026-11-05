import http from 'node:http';
import type { AgentId, LoginFailure, LoginMethod, LoginState } from '../shared/types.ts';
import {
  LoginScreen, type RedirectLink, classifyCodexFailure, findClaudeLink, findClaudeToken, findCodexDevice, findRedirectLink,
  isClaudeCodeRejected, isClaudeStuck, loginLinkState, redact,
} from './agents/login.ts';
import { HttpError, errorMessage, sleep } from './util.ts';

// Signing in drives the agents' own CLIs on a hidden terminal: Lonca reads what they draw and
// types what they ask for. The browser only ever sees the state below, so a token the CLI
// prints goes straight from this process to the secrets file without reaching a page.
//
// A sign-in page sends the browser back to a port on `localhost`, where the CLI is listening.
// The CLI is in a container, so Lonca answers on that port of this computer and passes the
// request in. The browser gets Lonca's page and not the CLI's answer, which can't be relied on:
// Claude's redirects to its success page even when it failed, and Codex's has a token in it.

export interface LoginProcess {
  onData(listener: (data: Buffer) => void): void;
  /** Resolves with the exit code once the CLI has gone. */
  exited: Promise<number | null>;
  write(data: string): void;
  /** Gives the CLI's listener the browser's return from the sign-in page. */
  deliver(port: number, path: string): Promise<void>;
  kill(): Promise<void>;
}

/** How a sign-in went, for the browser that came back from it. Null means it isn't that browser. */
export type ReturnOutcome = 'done' | 'failed' | null;

export interface LoginDriver {
  spawn(agent: AgentId, method: LoginMethod): Promise<LoginProcess>;
  /** Answers on a port of this computer until the function it gives is called. Fails if the port is taken. */
  listen(port: number, onReturn: (target: URL) => Promise<ReturnOutcome>): Promise<() => void>;
  saveClaudeToken(token: string): Promise<void>;
  /** After `codex login` exits: moves its login to the shared volume and reports whether it took. */
  finishCodexLogin(): Promise<boolean>;
  /** Puts things back after a sign-in that didn't finish. */
  cleanUp(agent: AgentId): Promise<void>;
  publish(agent: AgentId, login: LoginState | null): void;
}

export const LOGIN_TIMINGS = {
  noLinkMs: 30_000,
  codeResultMs: 60_000,
  expiresMs: 20 * 60_000,
  // The CLI repaints in pieces, so a token only counts once the screen has settled.
  settledMs: 1000,
  echoMs: 1000,
};

const NO_LINKS = { url: undefined, pasteUrl: undefined, code: undefined };

const returnPage = (title: string, text: string): string => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 28em; margin: 20vh auto 0; padding: 0 16px; font: 15px/1.5 system-ui, sans-serif; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
</style>
<h1>${title}</h1>
<p>${text}</p>
</html>
`;

const RETURN_PAGES = {
  done: returnPage('You’re signed in', 'You can close this tab and go back to Lonca.'),
  failed: returnPage('That sign-in didn’t finish', 'Go back to Lonca to see why and try again.'),
};

export function listenForReturn(port: number, onReturn: (target: URL) => Promise<ReturnOutcome>): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const answer = (outcome: ReturnOutcome) => {
        res.writeHead(outcome ? 200 : 404, { 'content-type': outcome ? 'text/html; charset=utf-8' : 'text/plain', connection: 'close' });
        res.end(outcome ? RETURN_PAGES[outcome] : 'Not found');
      };
      const target = URL.parse(req.url ?? '', 'http://localhost');
      if (req.method !== 'GET' || !target) return answer(null);
      void onReturn(target).catch(() => 'failed' as const).then(answer);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(() => server.close()));
  });
}

class LoginSession {
  state: LoginState;
  private screen = new LoginScreen();
  private process: LoginProcess | null = null;
  private timers: NodeJS.Timeout[] = [];
  private settleTimer: NodeJS.Timeout | null = null;
  private echoed: (() => void) | null = null;
  private cancelled = false;
  private portOpened: Promise<void> | null = null;
  private stopListening: (() => void) | null = null;
  private settle: () => void = () => {};
  private settled = new Promise<void>((resolve) => {
    this.settle = resolve;
  });
  private agent: AgentId;
  private driver: LoginDriver;
  private timings: typeof LOGIN_TIMINGS;

  constructor(agent: AgentId, method: LoginMethod, driver: LoginDriver, timings: typeof LOGIN_TIMINGS) {
    this.agent = agent;
    this.driver = driver;
    this.timings = timings;
    this.state = { agent, method, phase: 'starting' };
  }

  get finished(): boolean {
    return this.state.phase === 'done' || this.state.phase === 'failed';
  }

  private get isWaiting(): boolean {
    return this.state.phase === 'starting' || this.state.phase === 'waiting';
  }

  private update(patch: Partial<LoginState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.cancelled) this.driver.publish(this.agent, this.state);
  }

  private later(ms: number, action: () => void): void {
    const timer = setTimeout(action, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  async start(): Promise<void> {
    if (this.cancelled) return;
    this.driver.publish(this.agent, this.state);
    this.later(this.timings.expiresMs, () => {
      if (!this.finished) void this.fail('expired');
    });
    try {
      const process = await this.driver.spawn(this.agent, this.state.method);
      if (this.cancelled || this.finished) {
        await process.kill();
        return;
      }
      this.process = process;
      // Starting can take minutes if the image is being rebuilt, which isn't the CLI's doing.
      this.later(this.timings.noLinkMs, () => {
        if (this.state.phase === 'starting') void this.fail('no-link');
      });
      process.onData((data) => void this.onData(data));
      void process.exited.then((code) => this.onExit(code));
    } catch (error) {
      await this.fail('unavailable', errorMessage(error));
    }
  }

  private async onData(data: Buffer): Promise<void> {
    if (this.finished || this.cancelled) return;
    await this.screen.write(data);
    this.echoed?.();
    if (this.finished || this.cancelled) return;
    const text = this.screen.text();
    if (this.state.method === 'device' && this.state.phase === 'starting') {
      const device = findCodexDevice(text);
      if (device) this.update({ phase: 'waiting', url: device.url, code: device.code });
    }
    if (this.state.method === 'browser' && this.isWaiting) {
      const redirect = this.portOpened ? null : findRedirectLink(this.screen);
      if (redirect) this.portOpened = this.openReturnPort(redirect);
      const pasteUrl = this.agent === 'claude' && !this.state.pasteUrl ? findClaudeLink(this.screen) : null;
      if (pasteUrl) {
        // After the port, so that this page on its own means the other one isn't coming.
        await this.portOpened;
        if (this.isWaiting) this.update({ phase: 'waiting', pasteUrl });
      }
    }
    if (this.agent === 'claude' && this.state.phase === 'submitting') {
      if (isClaudeCodeRejected(text)) {
        await this.fail('rejected');
        return;
      }
      if (isClaudeStuck(text)) {
        await this.fail('stopped');
        return;
      }
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => void this.saveTokenIfPrinted(), this.timings.settledMs);
    }
  }

  private async openReturnPort(link: RedirectLink): Promise<void> {
    let stop: () => void;
    try {
      stop = await this.driver.listen(link.port, (target) => this.onReturn(link, target));
    } catch {
      // Claude's other page doesn't need the port. Codex's other way in means starting over.
      if (this.agent === 'codex') await this.fail('port-busy', String(link.port));
      return;
    }
    if (this.finished || this.cancelled) return stop();
    this.stopListening = stop;
    this.update({ phase: 'waiting', url: link.url });
  }

  private async onReturn(link: RedirectLink, target: URL): Promise<ReturnOutcome> {
    // Any web page can send a browser to this port, but only the sign-in page knows the state.
    // Nothing else gets through either: a bare GET of Codex's /cancel or /success ends its sign-in.
    if (target.pathname !== link.path || target.searchParams.get('state') !== link.state) return null;
    if (this.state.phase === 'waiting' && this.process) {
      this.awaitResult();
      this.process.deliver(link.port, target.pathname + target.search).catch((error) => {
        // Past this phase the CLI has already taken it, whatever became of the request.
        if (this.state.phase === 'submitting') void this.fail('stopped', errorMessage(error));
      });
    }
    await this.settled;
    return this.state.phase === 'done' ? 'done' : 'failed';
  }

  private awaitResult(): void {
    this.update({ phase: 'submitting' });
    this.later(this.timings.codeResultMs, () => {
      if (this.state.phase === 'submitting') void this.fail('rejected');
    });
  }

  private async saveTokenIfPrinted(): Promise<boolean> {
    if (this.finished || this.cancelled || this.state.phase === 'saving') return this.state.phase === 'saving';
    const token = findClaudeToken(this.screen.text());
    if (!token) return false;
    this.update({ phase: 'saving', ...NO_LINKS });
    try {
      await this.driver.saveClaudeToken(token);
      await this.succeed();
    } catch (error) {
      await this.fail('save-failed', errorMessage(error));
    }
    return true;
  }

  private async onExit(code: number | null): Promise<void> {
    this.process = null;
    if (this.finished || this.cancelled) return;
    // Anything the CLI wrote just before exiting has to be on screen before this looks at it.
    await this.screen.write('');
    if (this.finished || this.cancelled) return;
    if (this.agent === 'claude') {
      if (!(await this.saveTokenIfPrinted()) && !this.finished) await this.fail('stopped');
      return;
    }
    if (code === 0) {
      this.update({ phase: 'saving', ...NO_LINKS });
      try {
        if (await this.driver.finishCodexLogin()) await this.succeed();
        else await this.fail('stopped');
      } catch (error) {
        await this.fail('save-failed', errorMessage(error));
      }
      return;
    }
    await this.fail(classifyCodexFailure(this.screen.text()));
  }

  /** Whoever came back from the sign-in page gets their answer, and the port is free again. */
  private stopWaiting(): void {
    this.settle();
    this.stopListening?.();
    this.stopListening = null;
  }

  private async succeed(): Promise<void> {
    // Saving takes a while, and this attempt may have ended meanwhile and another begun.
    if (this.finished || this.cancelled) return;
    this.clearTimers();
    this.update({ phase: 'done', ...NO_LINKS });
    this.stopWaiting();
    this.screen.dispose();
    await this.process?.kill().catch(() => {});
    this.process = null;
  }

  private async fail(failure: LoginFailure, message?: string): Promise<void> {
    if (this.finished || this.cancelled) return;
    this.clearTimers();
    // The screen can still hold what the CLI printed, so only a redacted copy leaves here.
    const output = redact(this.screen.text());
    this.update({ phase: 'failed', failure, message, output, ...NO_LINKS });
    this.stopWaiting();
    this.screen.dispose();
    await this.process?.kill().catch(() => {});
    this.process = null;
    await this.driver.cleanUp(this.agent).catch(() => {});
  }

  async submitCode(code: string): Promise<void> {
    // Claude takes a few seconds to get to its prompt, and shows this page when it has.
    if (this.state.phase !== 'waiting' || !this.process || !this.state.pasteUrl) {
      throw new HttpError(409, 'This sign-in isn’t waiting for a code. Start again to get a new one.');
    }
    const trimmed = code.trim();
    // A pasted escape sequence could end the bracketed paste and type anything into the CLI.
    // eslint-disable-next-line no-control-regex
    if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) throw new HttpError(400, 'That doesn’t look like a sign-in code. Copy it again from the page.');
    if (/^sk-/.test(trimmed)) throw new HttpError(400, 'That’s a key, not a sign-in code.');
    const expected = loginLinkState(this.state.pasteUrl);
    const given = trimmed.includes('#') ? trimmed.slice(trimmed.indexOf('#') + 1) : null;
    if (expected && given && expected !== given) {
      throw new HttpError(400, 'That code is from an earlier sign-in. Open the page again to get a new one.');
    }

    this.awaitResult();
    // Return only counts once the CLI has taken in the code, or it's ignored.
    const echoed = new Promise<void>((resolve) => {
      this.echoed = resolve;
    });
    this.process.write(`\x1b[200~${trimmed}\x1b[201~`);
    await Promise.race([echoed, sleep(this.timings.echoMs)]);
    this.echoed = null;
    this.process?.write('\r');
  }

  output(): string {
    return this.state.output ?? (this.finished ? '' : redact(this.screen.text()));
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.clearTimers();
    this.stopWaiting();
    if (this.state.phase !== 'done' && this.state.phase !== 'failed') this.screen.dispose();
    await this.process?.kill().catch(() => {});
    this.process = null;
    await this.driver.cleanUp(this.agent).catch(() => {});
  }
}

export class LoginManager {
  private sessions = new Map<AgentId, LoginSession>();
  private driver: LoginDriver;
  private timings: typeof LOGIN_TIMINGS;

  constructor(driver: LoginDriver, timings: typeof LOGIN_TIMINGS = LOGIN_TIMINGS) {
    this.driver = driver;
    this.timings = timings;
  }

  states(): Partial<Record<AgentId, LoginState>> {
    return Object.fromEntries([...this.sessions].map(([agent, session]) => [agent, session.state]));
  }

  /**
   * Joins a sign-in already under way, so a second tab or a double click doesn't start another,
   * unless this asks for the other way of signing in, which replaces it.
   * Reports null if it was cancelled while starting, which can take a while.
   */
  async start(agent: AgentId, method: LoginMethod = 'browser'): Promise<LoginState | null> {
    const current = this.sessions.get(agent);
    if (current && !current.finished && current.state.method === method) return current.state;
    const session = new LoginSession(agent, method, this.driver, this.timings);
    this.sessions.set(agent, session);
    if (current && !current.finished) await current.cancel();
    await session.start();
    return this.sessions.get(agent)?.state ?? null;
  }

  async submitCode(agent: AgentId, code: string): Promise<void> {
    const session = this.sessions.get(agent);
    if (!session) throw new HttpError(409, 'This sign-in has ended. Start again to get a new code.');
    await session.submitCode(code);
  }

  output(agent: AgentId): string {
    return this.sessions.get(agent)?.output() ?? '';
  }

  async cancel(agent: AgentId): Promise<void> {
    const session = this.sessions.get(agent);
    this.sessions.delete(agent);
    // Always said, so a page out of step with the server gets back in step.
    this.driver.publish(agent, null);
    await session?.cancel();
  }
}
