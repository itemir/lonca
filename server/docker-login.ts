import type { DockerLoginFailure, DockerLoginState, SandboxStatus } from '../shared/types.ts';
import { LOGIN_TIMINGS } from './login.ts';
import { errorMessage } from './util.ts';

// Docker Sandboxes signs in with a one-time code: `sbx login` prints the code and a page to enter
// it on, then waits until someone has. It's run on this computer as the user, so it signs in the
// user's own sbx, the one their terminal uses too. Lonca only reads what it prints, and never sees
// or keeps the login itself, which sbx stores where it always does.

export interface DockerLoginProcess {
  onOutput(listener: (text: string) => void): void;
  /** Resolves once sbx has gone, with what it said on stderr. */
  exited: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

export interface DockerLoginDriver {
  spawn(): Promise<DockerLoginProcess>;
  /** Finds out afresh where Docker Sandboxes stands. */
  check(): Promise<SandboxStatus['state']>;
  publish(login: DockerLoginState | null): void;
}

export const DOCKER_LOGIN_TIMINGS = { noCodeMs: LOGIN_TIMINGS.noLinkMs, expiresMs: LOGIN_TIMINGS.expiresMs };

const MAX_OUTPUT = 16384;

/**
 * Reads the code and the page from what `sbx login` prints, wherever they are in it. Output comes
 * in pieces, so each only counts once its line has ended, or a link cut short could be taken whole.
 */
export function parseDockerLogin(output: string): { code: string; url: string } | null {
  const text = output.replace(/\r/g, '');
  const link = /Open this URL to sign in:\s*(https:\/\/\S+)(?=\s)/i.exec(text)?.[1] ?? /https:\/\/\S*[?&]user_code=\S+(?=\s)/i.exec(text)?.[0];
  const url = link ? URL.parse(link) : null;
  if (!url || url.protocol !== 'https:') return null;
  const code = /confirmation code is:\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)(?=\s)/i.exec(text)?.[1] ?? url.searchParams.get('user_code');
  return code ? { code, url: url.href } : null;
}

/** sbx's error, in words for the page. */
export function describeSbxFailure(stderr: string): string | undefined {
  const lines = stderr.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const error = lines.find((line) => /^error:/i.test(line)) ?? lines.at(-1);
  if (!error) return undefined;
  const text = error.replace(/^error:\s*/i, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

class DockerLoginSession {
  state: DockerLoginState = { phase: 'starting' };
  private process: DockerLoginProcess | null = null;
  private output = '';
  private timers: NodeJS.Timeout[] = [];
  private cancelled = false;
  /** Settles once there's no sbx left, whether it never started or has exited. */
  private gone: Promise<unknown> = Promise.resolve();
  private driver: DockerLoginDriver;
  private timings: typeof DOCKER_LOGIN_TIMINGS;

  constructor(driver: DockerLoginDriver, timings: typeof DOCKER_LOGIN_TIMINGS) {
    this.driver = driver;
    this.timings = timings;
  }

  get finished(): boolean {
    return this.state.phase === 'done' || this.state.phase === 'failed';
  }

  private update(state: DockerLoginState): void {
    this.state = state;
    if (!this.cancelled) this.driver.publish(state);
  }

  private later(ms: number, action: () => void): void {
    const timer = setTimeout(action, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  private stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.process?.kill();
  }

  /** `after` settles once the sbx before this one has gone, since there's only ever one. */
  async start(after: Promise<unknown>): Promise<void> {
    this.update(this.state);
    const spawning = after.then(() => (this.cancelled || this.finished ? null : this.driver.spawn()));
    this.gone = spawning.then((process) => process?.exited, () => undefined);
    let process: DockerLoginProcess | null;
    try {
      process = await spawning;
    } catch (error) {
      this.fail('unavailable', errorMessage(error));
      return;
    }
    if (!process) return;
    this.process = process;
    // Cancelled, or signed in some other way, while it was starting.
    if (this.cancelled || this.finished) {
      process.kill();
      return;
    }
    this.later(this.timings.noCodeMs, () => {
      if (this.state.phase === 'starting') this.fail('no-code');
    });
    this.later(this.timings.expiresMs, () => {
      // Once sbx has exited, what it did decides, however long finding that out takes.
      if (this.state.phase === 'starting' || this.state.phase === 'waiting') this.fail('expired');
    });
    process.onOutput((text) => this.onOutput(text));
    void process.exited.then((result) => this.onExit(result));
  }

  private onOutput(text: string): void {
    this.output = (this.output + text).slice(-MAX_OUTPUT);
    if (this.state.phase !== 'starting' || this.cancelled) return;
    const found = parseDockerLogin(this.output);
    if (found) this.update({ phase: 'waiting', ...found });
  }

  private async onExit({ code, stderr }: { code: number | null; stderr: string }): Promise<void> {
    this.process = null;
    this.output = (this.output + stderr).slice(-MAX_OUTPUT);
    const ending = !this.finished && !this.cancelled;
    if (ending) this.update({ phase: 'checking' });
    // Whatever ended it, Lonca has to know where sbx stands now, and only sbx can say.
    let checkFailure: string | undefined;
    const sandboxes = await this.driver.check().catch((error) => {
      checkFailure = errorMessage(error);
      return null;
    });
    if (!ending || this.cancelled) return;
    // Signed in, though something else can still be in the way, which Settings explains.
    if (sandboxes === 'ready' || (code === 0 && sandboxes !== null && sandboxes !== 'signed-out')) {
      this.stop();
      this.update({ phase: 'done' });
      return;
    }
    // Settings keeps checking, and picks it up from there if it did sign in.
    if (code === 0 && sandboxes === null) {
      this.fail('unchecked', checkFailure);
      return;
    }
    // It can exit cleanly without having signed in, for all anyone here knows.
    this.fail('stopped', code === 0 ? undefined : describeSbxFailure(stderr));
  }

  get waiting(): boolean {
    return this.state.phase === 'starting' || this.state.phase === 'waiting';
  }

  /** Signed in some other way, such as `sbx login` in a terminal, so this code is no use now. */
  endSignedIn(): void {
    if (!this.waiting || this.cancelled) return;
    this.stop();
    this.update({ phase: 'done' });
  }

  private fail(failure: DockerLoginFailure, message?: string): void {
    if (this.finished || this.cancelled) return;
    this.stop();
    this.update({ phase: 'failed', failure, message, output: this.output.replace(/\r/g, '').trim() });
  }

  /** Settles once there's no sbx left of this one, which the kill's own fallback makes sure of. */
  get exited(): Promise<unknown> {
    return this.gone;
  }

  cancel(): void {
    this.cancelled = true;
    this.stop();
  }
}

/** One sign-in at a time, whoever asks for it. */
export class DockerLoginManager {
  private session: DockerLoginSession | null = null;
  /** Settles once every sbx login so far has gone, including one cancelled or failed and still exiting. */
  private allGone: Promise<unknown> = Promise.resolve();
  private driver: DockerLoginDriver;
  private timings: typeof DOCKER_LOGIN_TIMINGS;

  constructor(driver: DockerLoginDriver, timings: typeof DOCKER_LOGIN_TIMINGS = DOCKER_LOGIN_TIMINGS) {
    this.driver = driver;
    this.timings = timings;
  }

  state(): DockerLoginState | null {
    return this.session?.state ?? null;
  }

  /** Joins a sign-in already under way, so a second tab or a double click doesn't start another. */
  async start(): Promise<DockerLoginState | null> {
    if (this.session && !this.session.finished) return this.session.state;
    const session = new DockerLoginSession(this.driver, this.timings);
    this.session = session;
    // Its sbx waits for the last one's, so there's one process, and one record of it, at a time.
    const starting = session.start(this.allGone);
    this.allGone = session.exited;
    await starting;
    return this.session === session ? session.state : null;
  }

  /** Resolves once its sbx has gone, so that nothing it does can come after what's next. */
  async cancel(): Promise<void> {
    const session = this.session;
    this.session = null;
    // Always said, so a page out of step with the server gets back in step.
    this.driver.publish(null);
    session?.cancel();
    await this.allGone;
  }

  /** Workspaces can run, so a sign-in still waiting for its code to be used is done with. */
  sandboxesReady(): void {
    this.session?.endSignedIn();
  }
}
