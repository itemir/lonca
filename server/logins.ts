import type { AgentId, LoginMethod } from '../shared/types.ts';
import { LOGIN_COLS, LOGIN_ROWS } from './agents/login.ts';
import { TTY_DIR } from './config.ts';
import { publish } from './events.ts';
import { type LoginProcess, LoginManager, listenForReturn } from './login.ts';
import { exec, execText, execTty } from './sandbox.ts';
import { secretsStatus, state, updateSecrets } from './store.ts';
import { adoptCodexLogin, agentLoginCommand, checkClaudeCredential, clearAgentRejected, helperRunning, helperSandbox, refreshAgents } from './system.ts';
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
const BROWSER_SCRIPT = String.raw`#!/bin/sh
printf '\033]8;;%s\007\033]8;;\007' "$1" > /dev/tty
`;

function killLeftovers(helper: string, agent: AgentId): Promise<unknown> {
  return exec(helper, ['bash', '-c', KILL_ALL, TTY_DIR, agent], { timeoutMs: 10000 }).catch(() => {});
}

async function spawnLogin(agent: AgentId, method: LoginMethod): Promise<LoginProcess> {
  const helper = await helperSandbox();
  await killLeftovers(helper, agent);
  await execText(helper, ['bash', '-c', 'cat > "$0" && chmod +x "$0"', BROWSER], { stdin: BROWSER_SCRIPT, timeoutMs: 10000 });
  const attempt = `${TTY_DIR}/login-${agent}-${newId()}`;
  const wrapped = ['bash', '-c', START, attempt, ...agentLoginCommand(agent, method)];
  const tty = await execTty(helper, wrapped, { cols: LOGIN_COLS, rows: LOGIN_ROWS, env: [`BROWSER=${BROWSER}`, `CODEX_HOME=${attempt}`] });
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
      const login = await exec(helper, ['head', '-c', '65536', `${attempt}/auth.json`], { timeoutMs: 10000 });
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
  async saveClaudeToken(token) {
    updateSecrets({ claudeToken: token });
    clearAgentRejected('claude');
    publish({ type: 'settings', settings: state.settings, secrets: secretsStatus() });
    await refreshAgents();
  },
  async finishCodexLogin(login) {
    if (!adoptCodexLogin(login)) return false;
    applyCodexSetupEverywhere();
    clearAgentRejected('codex');
    await refreshAgents();
    return true;
  },
  publish: (agent, login) => publish({ type: 'login', agent, login }),
});

/** A sign-in can't outlive the server that was following it, but its CLI would keep waiting. */
export async function reapLeftoverLogins(): Promise<void> {
  if (!await helperRunning()) return;
  const helper = await helperSandbox();
  const live = logins.states();
  const idle = (['claude', 'codex'] as const).filter((agent) => !live[agent] || live[agent].phase === 'done' || live[agent].phase === 'failed');
  await Promise.all(idle.map((agent) => killLeftovers(helper, agent)));
}
