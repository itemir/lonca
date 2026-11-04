import type { AgentId, LoginFailure, LoginState } from '../shared/types.ts';
import {
  LoginScreen, classifyCodexFailure, findClaudeLink, findClaudeToken, findCodexDevice, isClaudeCodeRejected, isClaudeStuck,
  loginLinkState, redact,
} from './agents/login.ts';
import { HttpError, errorMessage, sleep } from './util.ts';

// Signing in drives the agents' own CLIs on a hidden terminal: Lonca reads what they draw and
// types what they ask for. The browser only ever sees the state below, so a token the CLI
// prints goes straight from this process to the secrets file without reaching a page.

export interface LoginProcess {
  onData(listener: (data: Buffer) => void): void;
  /** Resolves with the exit code once the CLI has gone. */
  exited: Promise<number | null>;
  write(data: string): void;
  kill(): Promise<void>;
}

export interface LoginDriver {
  spawn(agent: AgentId): Promise<LoginProcess>;
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

class LoginSession {
  state: LoginState;
  private screen = new LoginScreen();
  private process: LoginProcess | null = null;
  private timers: NodeJS.Timeout[] = [];
  private settleTimer: NodeJS.Timeout | null = null;
  private echoed: (() => void) | null = null;
  private cancelled = false;
  private agent: AgentId;
  private driver: LoginDriver;
  private timings: typeof LOGIN_TIMINGS;

  constructor(agent: AgentId, driver: LoginDriver, timings: typeof LOGIN_TIMINGS) {
    this.agent = agent;
    this.driver = driver;
    this.timings = timings;
    this.state = { agent, phase: 'starting' };
  }

  get finished(): boolean {
    return this.state.phase === 'done' || this.state.phase === 'failed';
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
    this.driver.publish(this.agent, this.state);
    this.later(this.timings.expiresMs, () => {
      if (!this.finished) void this.fail('expired');
    });
    try {
      const process = await this.driver.spawn(this.agent);
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
    if (this.state.phase === 'starting') {
      if (this.agent === 'claude') {
        const url = findClaudeLink(this.screen);
        if (url) this.update({ phase: 'waiting', url });
      } else {
        const device = findCodexDevice(text);
        if (device) this.update({ phase: 'waiting', url: device.url, code: device.code });
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

  private async saveTokenIfPrinted(): Promise<boolean> {
    if (this.finished || this.cancelled || this.state.phase === 'saving') return this.state.phase === 'saving';
    const token = findClaudeToken(this.screen.text());
    if (!token) return false;
    this.update({ phase: 'saving', url: undefined });
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
      this.update({ phase: 'saving', url: undefined, code: undefined });
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

  private async succeed(): Promise<void> {
    this.clearTimers();
    this.update({ phase: 'done', url: undefined, code: undefined });
    this.screen.dispose();
    await this.process?.kill().catch(() => {});
    this.process = null;
  }

  private async fail(failure: LoginFailure, message?: string): Promise<void> {
    if (this.finished || this.cancelled) return;
    this.clearTimers();
    // The screen can still hold what the CLI printed, so only a redacted copy leaves here.
    const output = redact(this.screen.text());
    this.update({ phase: 'failed', failure, message, output, url: undefined, code: undefined });
    this.screen.dispose();
    await this.process?.kill().catch(() => {});
    this.process = null;
    await this.driver.cleanUp(this.agent).catch(() => {});
  }

  async submitCode(code: string): Promise<void> {
    if (this.state.phase !== 'waiting' || !this.process) {
      throw new HttpError(409, 'This sign-in isn’t waiting for a code. Start again to get a new one.');
    }
    const trimmed = code.trim();
    // A pasted escape sequence could end the bracketed paste and type anything into the CLI.
    // eslint-disable-next-line no-control-regex
    if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) throw new HttpError(400, 'That doesn’t look like a sign-in code. Copy it again from the page.');
    if (/^sk-/.test(trimmed)) throw new HttpError(400, 'That’s a key, not a sign-in code.');
    const expected = this.state.url ? loginLinkState(this.state.url) : null;
    const given = trimmed.includes('#') ? trimmed.slice(trimmed.indexOf('#') + 1) : null;
    if (expected && given && expected !== given) {
      throw new HttpError(400, 'That code is from an earlier sign-in. Open the page again to get a new one.');
    }

    this.update({ phase: 'submitting' });
    this.later(this.timings.codeResultMs, () => {
      if (this.state.phase === 'submitting') void this.fail('rejected');
    });
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
   * Joins a sign-in already under way, so a second tab or a double click doesn't start another.
   * Reports null if it was cancelled while starting, which can take a while.
   */
  async start(agent: AgentId): Promise<LoginState | null> {
    const current = this.sessions.get(agent);
    if (current && !current.finished) return current.state;
    const session = new LoginSession(agent, this.driver, this.timings);
    this.sessions.set(agent, session);
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
