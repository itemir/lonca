import type { AgentId, LoginMethod } from '../shared/types.ts';
import { LOGIN_COLS, LOGIN_ROWS } from './agents/login.ts';
import { TTY_DIR } from './config.ts';
import { exec, execText, execTty } from './docker.ts';
import { publish } from './events.ts';
import { type LoginProcess, LoginManager, listenForReturn } from './login.ts';
import { secretsStatus, state, updateSecrets } from './store.ts';
import { agentLoginCommand, checkClaudeCredential, clearAgentRejected, refreshAgents, shareCodexLogin, system, toolsContainer } from './system.ts';
import { newId, sleep } from './util.ts';

// One pid file per CLI, since a sign-in that's being cancelled can overlap the next one starting.
const KILL_ONE = 'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$0" ] && break; sleep 0.2; done; pid=$(head -c 16 "$0" 2>/dev/null) && kill -KILL -- -"$pid" 2>/dev/null; rm -f "$0"';
const KILL_ALL = 'for file in "$0"/login-"$1"-*.pid; do [ -f "$file" ] || continue; pid=$(head -c 16 "$file") && kill -KILL -- -"$pid" 2>/dev/null; rm -f "$file"; done';

// There's no browser in the helper. A CLI trying to open one puts the link on its terminal
// instead, as a hyperlink that doesn't disturb the screen, to be read like anything else there.
const BROWSER = `${TTY_DIR}/login-browser`;
const BROWSER_SCRIPT = String.raw`#!/bin/sh
printf '\033]8;;%s\007\033]8;;\007' "$1" > /dev/tty
`;

function killLeftovers(containerId: string, agent: AgentId): Promise<unknown> {
  return exec(containerId, ['bash', '-c', KILL_ALL, TTY_DIR, agent], { timeoutMs: 10000 }).catch(() => {});
}

async function spawnLogin(agent: AgentId, method: LoginMethod): Promise<LoginProcess> {
  const containerId = await toolsContainer();
  await killLeftovers(containerId, agent);
  await execText(containerId, ['bash', '-c', 'cat > "$0" && chmod +x "$0"', BROWSER], { stdin: BROWSER_SCRIPT, timeoutMs: 10000 });
  const pidFile = `${TTY_DIR}/login-${agent}-${newId()}.pid`;
  const wrapped = ['bash', '-c', 'echo $$ > "$0"; exec "$@"', pidFile, ...agentLoginCommand(agent, method)];
  const tty = await execTty(containerId, wrapped, { cols: LOGIN_COLS, rows: LOGIN_ROWS, env: [`BROWSER=${BROWSER}`] });
  const exited = new Promise<number | null>((resolve) => {
    let ended = false;
    const finish = async () => {
      if (ended) return;
      ended = true;
      // Docker can take a moment to report the exit code after the stream ends.
      for (let i = 0; i < 20; i++) {
        const code = await tty.exitCode().catch(() => null);
        if (code !== null) return resolve(code);
        await sleep(100);
      }
      resolve(null);
    };
    tty.stream.on('end', finish);
    tty.stream.on('close', finish);
    tty.stream.on('error', finish);
  });
  return {
    onData: (listener) => tty.stream.on('data', listener),
    exited,
    write: (data) => void tty.stream.write(data),
    deliver: async (port, path) => {
      // Codex finishes when /success is fetched, and redirects there with its answer. Claude
      // redirects to its website, which isn't plain http and so isn't followed.
      await exec(containerId, [
        'curl', '-sS', '--globoff', '-o', '/dev/null', '--location', '--max-redirs', '1', '--proto-redir', '=http', '--max-time', '55',
        `http://127.0.0.1:${port}${path}`,
      ], { timeoutMs: 60000 });
    },
    kill: async () => {
      await exec(containerId, ['bash', '-c', KILL_ONE, pidFile], { timeoutMs: 10000 }).catch(() => {});
      tty.stream.destroy();
    },
  };
}

export const logins = new LoginManager({
  spawn: spawnLogin,
  listen: listenForReturn,
  async saveClaudeToken(token) {
    // It was read off a screen and could be cut short, and the CLI's own status wouldn't notice.
    if ((await checkClaudeCredential(token)) === 'refused') throw new Error('Claude didn’t accept the token it gave.');
    updateSecrets({ claudeToken: token });
    clearAgentRejected('claude');
    publish({ type: 'settings', settings: state.settings, secrets: secretsStatus() });
    await refreshAgents();
  },
  async finishCodexLogin() {
    clearAgentRejected('codex');
    await refreshAgents();
    return system.agents.codex.signedIn;
  },
  async cleanUp(agent) {
    // Starting `codex login` removes the link to the shared login, so put it back.
    if (agent === 'codex') await shareCodexLogin(await toolsContainer());
  },
  publish: (agent, login) => publish({ type: 'login', agent, login }),
});

/** A sign-in can't outlive the server that was following it, but its CLI would keep waiting. */
export async function reapLeftoverLogins(): Promise<void> {
  const containerId = await toolsContainer();
  const live = logins.states();
  const idle = (['claude', 'codex'] as const).filter((agent) => !live[agent] || live[agent].phase === 'done' || live[agent].phase === 'failed');
  await Promise.all(idle.map((agent) => killLeftovers(containerId, agent)));
}
