import net from 'node:net';
import { AGENTS } from '../shared/profiles.ts';
import type { AgentId, LoginMethod } from '../shared/types.ts';
import { LOGIN_COLS, LOGIN_ROWS } from './agents/login.ts';
import { TTY_DIR } from './config.ts';
import { publish } from './events.ts';
import { DockerLoginManager } from './docker-login.ts';
import { CLIENT_SECRET_SEARCH, adoptGeminiLogin, clientSecretIn } from './gemini-login.ts';
import { type LoginProcess, LoginManager, listenForReturn } from './login.ts';
import { afterSignInChange, exec, execText, execTty, startSbxLogin } from './sandbox.ts';
import { secretsStatus, setClaudeCredential, state } from './store.ts';
import {
  GEMINI_OPENER, adoptCodexLogin, agentLoginCommand, checkClaudeCredential, checkSandboxes, clearAgentRejected, clearProfileLimit, getProfile, helperRunning,
  helperSandbox, onSandboxesFoundReady, refreshAgents, setDockerLogin, system,
} from './system.ts';
import { newId } from './util.ts';
import { applyCodexSetupEverywhere } from './workspaces.ts';

// Each attempt has a directory of its own, since one being cancelled can overlap the next one
// starting. It holds the CLI's pid and is Codex's home, so that a login can only be taken from
// the attempt that made it, and it goes when the attempt does.
const START = `mkdir -m 700 "$0" && echo 'cli_auth_credentials_store = "file"' > "$0/config.toml" && echo $$ > "$0/pid" && exec "$@"`;
const KILL_ONE = 'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$0/pid" ] && break; sleep 0.2; done; pid=$(head -c 16 "$0/pid" 2>/dev/null) && kill -KILL -- -"$pid" 2>/dev/null; rm -rf "$0"';
const KILL_ALL = 'for dir in "$0"/login-"$1"-*/; do [ -d "$dir" ] || continue; pid=$(head -c 16 "$dir/pid" 2>/dev/null) && kill -KILL -- -"$pid" 2>/dev/null; rm -rf "$dir"; done';

// There's no browser in the helper. A CLI trying to open one puts the link on its terminal
// instead, as a hyperlink that doesn't disturb the screen, to be read like anything else there.
const BROWSER = `${TTY_DIR}/login-browser`;
// Gemini's runs it apart from its terminal, so the attempt says which terminal that is.
const BROWSER_SCRIPT = String.raw`#!/bin/sh
out=$LONCA_TTY
[ -n "$out" ] || out=/dev/tty
printf '\033]8;;%s\007\033]8;;\007' "$1" > "$out"
`;

/** A port nothing on this computer has, for Gemini's page to come back to, so that it isn't one that's taken. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Where Gemini's CLI keeps the login of an attempt, which is its home, and how it signs in. */
async function geminiEnv(attempt: string, method: LoginMethod): Promise<string[]> {
  return [
    `GEMINI_CLI_HOME=${attempt}`,
    'LONCA_GEMINI_AUTH=oauth-personal',
    'GEMINI_CLI_TRUST_WORKSPACE=true',
    'GEMINI_CLI_NO_RELAUNCH=true',
    // It only tries a browser where there's a display.
    ...(method === 'code' ? ['NO_BROWSER=true'] : ['DISPLAY=:0', `OAUTH_CALLBACK_PORT=${await freePort()}`]),
  ];
}

function killLeftovers(helper: string, agent: AgentId): Promise<unknown> {
  return exec(helper, ['bash', '-c', KILL_ALL, TTY_DIR, agent], { timeoutMs: 10000 }).catch(() => {});
}

async function spawnLogin(agent: AgentId, method: LoginMethod): Promise<LoginProcess> {
  const helper = await helperSandbox();
  await killLeftovers(helper, agent);
  // Gemini's CLI runs xdg-open from PATH, rather than what BROWSER says.
  await execText(helper, ['bash', '-c', 'cat > "$0" && chmod +x "$0" && mkdir -p "$1" && cp "$0" "$1/xdg-open"', BROWSER, GEMINI_OPENER], { stdin: BROWSER_SCRIPT, timeoutMs: 10000 });
  const attempt = `${TTY_DIR}/login-${agent}-${newId()}`;
  const wrapped = ['bash', '-c', START, attempt, ...agentLoginCommand(agent, method)];
  const env = [`BROWSER=${BROWSER}`, `CODEX_HOME=${attempt}`, ...(agent === 'gemini' ? await geminiEnv(attempt, method) : [])];
  const tty = await execTty(helper, wrapped, { cols: LOGIN_COLS, rows: LOGIN_ROWS, env });
  const exited = new Promise<number | null>((resolve) => {
    const finish = () => resolve(tty.exitCode().catch(() => null));
    tty.stream.on('end', finish);
    tty.stream.on('close', finish);
    tty.stream.on('error', finish);
  });
  let killed: Promise<void> | null = null;
  return {
    onData: (listener) => tty.stream.on('data', listener),
    exited,
    write: (data) => void tty.stream.write(data),
    deliver: async (port, path) => {
      // Codex finishes when /success is fetched, and redirects there with its answer. Claude
      // redirects to its website, which isn't plain http and so isn't followed.
      await exec(helper, [
        'curl', '-sS', '--globoff', '-o', '/dev/null', '--location', '--max-redirs', '1', '--proto-redir', '=http', '--max-time', '55',
        `http://127.0.0.1:${port}${path}`,
      ], { timeoutMs: 60000 });
    },
    savedLogin: async () => {
      const file = agent === 'gemini' ? `${attempt}/.gemini/oauth_creds.json` : `${attempt}/auth.json`;
      const login = await exec(helper, ['head', '-c', '65536', file], { timeoutMs: 10000 });
      return login.code === 0 ? login.stdout.toString('utf8') : '';
    },
    kill: () => killed ??= exec(helper, ['bash', '-c', KILL_ONE, attempt], { timeoutMs: 10000 }).catch(() => {}).then(() => void tty.stream.destroy()),
  };
}

export const logins = new LoginManager({
  spawn: spawnLogin,
  listen: listenForReturn,
  async checkClaudeToken(token) {
    // It was read off a screen and could be cut short, and the CLI's own status wouldn't notice.
    if ((await checkClaudeCredential(token)) === 'refused') throw new Error('Claude didn’t accept the token it gave.');
  },
  async saveClaudeToken(token, { profileId }) {
    if (!getProfile(profileId)) throw new Error('This sign-in was removed.');
    setClaudeCredential(profileId, token);
    // It could be another account now, whose limits are its own.
    clearAgentRejected(profileId);
    clearProfileLimit(profileId);
    publish({ type: 'settings', settings: state.settings, secrets: secretsStatus() });
    await refreshAgents();
  },
  async finishCodexLogin(login, { profileId }) {
    if (!getProfile(profileId)) throw new Error('This sign-in was removed.');
    if (!adoptCodexLogin(login, profileId)) return false;
    applyCodexSetupEverywhere();
    clearAgentRejected(profileId);
    clearProfileLimit(profileId);
    await refreshAgents();
    return true;
  },
  async finishGeminiLogin(login, { profileId }, attempt) {
    if (!getProfile(profileId)) throw new Error('This sign-in was removed.');
    // The login only works with the client that made it, which is the CLI's own, in its bundle.
    const clientSecret = async () => clientSecretIn(await execText(await helperSandbox(), CLIENT_SECRET_SEARCH, { timeoutMs: 30000 }).catch(() => ''));
    const kept = await adoptGeminiLogin(login, {
      profileId,
      clientId: attempt.clientId,
      clientSecret,
      needsProject: attempt.needsProject,
      // Removing the sign-in ends this attempt too, and what it saved mustn't come back after.
      current: () => attempt.current() && Boolean(getProfile(profileId)),
    });
    if (!kept) return false;
    clearAgentRejected(profileId);
    clearProfileLimit(profileId);
    await refreshAgents();
    return true;
  },
  publish: ({ profileId }, login) => publish({ type: 'login', profileId, login }),
});

export const dockerLogins = new DockerLoginManager({
  async spawn() {
    const login = await startSbxLogin();
    login.stdout.setEncoding('utf8');
    return {
      onOutput: (listener) => login.stdout.on('data', listener),
      exited: login.exited,
      kill: login.kill,
    };
  },
  async check() {
    afterSignInChange();
    await checkSandboxes({ fresh: true });
    return system.sandbox.state;
  },
  publish: setDockerLogin,
});

// Including when that's from `sbx login` in a terminal, with nobody looking at Lonca.
onSandboxesFoundReady(() => dockerLogins.sandboxesReady());

/** A sign-in can't outlive the server that was following it, but its CLI would keep waiting. */
export async function reapLeftoverLogins(): Promise<void> {
  if (!await helperRunning()) return;
  const helper = await helperSandbox();
  const idle = AGENTS.filter((agent) => !logins.busy(agent));
  await Promise.all(idle.map((agent) => killLeftovers(helper, agent)));
}
