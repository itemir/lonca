import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppState, ClientEvent } from '../shared/types.ts';
import { resumeActiveRuns, retryActiveRuns } from './agents/runner.ts';
import { createApi } from './api.ts';
import { launchUrl, parseRequestUrl, requireLocalRequest, requireToken, securityHeaders, upgradeAllowed } from './auth.ts';
import { HTTP_PORT, LONCA_HOME, WEB_DIST } from './config.ts';
import { subscribe } from './events.ts';
import { setClientFocus } from './notify.ts';
import { flushState, flushTranscripts, saveState, state } from './store.ts';
import { checkDisk, checkSandboxes, ensureSandboxImage, moveCodexLogin, onSandboxesReady, refreshAgents, refreshCodexCatalog, system } from './system.ts';
import { attachTerminal, closeWorkspaceTerminals, reconcileTerminals, runSetupScript } from './terminals.ts';
import { reapLeftoverLogins } from './logins.ts';
import { reapSbxLogin } from './sbx-login-pid.ts';
import { reconcileProjects, stopHostGit } from './projects.ts';
import { errorMessage } from './util.ts';
import { markInterruptedWork, onWorkspaceTeardown, reconcileWorkspaces, setSetupScriptStarter } from './workspaces.ts';

function hostGitConfig(key: string): string {
  try {
    return execFileSync('git', ['config', '--global', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function describeMe(): AppState['me'] {
  state.settings.gitName ||= hostGitConfig('user.name');
  state.settings.gitEmail ||= hostGitConfig('user.email');
  saveState();
  const name = state.settings.gitName || os.userInfo().username;
  return { name, machine: `${name}’s ${process.platform === 'darwin' ? 'Mac' : os.hostname()}` };
}

setSetupScriptStarter(async (workspace, script) => {
  await runSetupScript(workspace, script);
});

onWorkspaceTeardown(closeWorkspaceTerminals);

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(requireLocalRequest);
app.use('/api', requireToken, createApi(describeMe()));
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get('/{*path}', (_req, res) => {
    res.sendFile('index.html', { root: WEB_DIST });
  });
}

const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (!upgradeAllowed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = parseRequestUrl(req.url);
  sockets.handleUpgrade(req, socket, head, (client: WebSocket) => {
    // Oversized or malformed frames surface here; without a listener they'd end the process.
    client.on('error', (error) => console.error('websocket error:', error.message));
    if (url?.pathname === '/ws') {
      const unsubscribe = subscribe((event) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
      });
      client.on('close', () => {
        unsubscribe();
        setClientFocus(client, false);
      });
      client.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString()) as ClientEvent;
          if (event.type === 'focus') setClientFocus(client, event.focused === true);
        } catch {
          // Nothing else is sent this way, so there's nothing to do with it.
        }
      });
      return;
    }
    const terminal = /^\/ws\/terminals\/([\w-]+)(\/window)?$/.exec(url?.pathname ?? '');
    const windowId = terminal?.[2] ? url?.searchParams.get('windowId') : undefined;
    if (terminal?.[2] && (!windowId || !/^[\w-]{1,64}$/.test(windowId))) {
      client.close(4400, 'A terminal window needs an identity');
      return;
    }
    if (!terminal || !attachTerminal(terminal[1], client, windowId ?? undefined)) client.close(4404, 'No such terminal');
  });
});

let prepared = false;
let preparing = false;

/** Work that needs Docker Sandboxes. Runs once it's usable, which may be long after startup. */
async function prepare(): Promise<void> {
  if (prepared || preparing) return;
  preparing = true;
  try {
    // Sessions can't recover without these, so they're retried on the next check if they fail.
    await reconcileWorkspaces();
    await resumeActiveRuns();
    prepared = true;
  } catch (error) {
    console.error('could not check on running workspaces:', errorMessage(error));
    return;
  } finally {
    preparing = false;
  }
  try {
    await ensureSandboxImage();
    await reapLeftoverLogins();
    await refreshAgents();
    void refreshCodexCatalog();
  } catch (error) {
    console.error('startup task failed:', errorMessage(error));
  }
}

// Once workspaces can run, pick up any that were out of reach.
onSandboxesReady(() => {
  prepared = false;
});

// Every time while workspaces can't run, to pick up as soon as they can. Otherwise only often
// enough to notice they've stopped being able to, without running `sbx` every few seconds.
const SANDBOX_CHECK_EVERY = 6;
let checks = 0;

async function watchSandboxes(): Promise<void> {
  if (system.sandbox.state !== 'ready' || checks++ % SANDBOX_CHECK_EVERY === 0) {
    await checkSandboxes().catch((error) => console.error('could not check for Docker Sandboxes:', errorMessage(error)));
  }
  if (system.sandbox.state === 'ready') {
    await prepare();
    if (prepared) await retryActiveRuns();
    // Finding out about the template can fail with the rest of startup having worked.
    if (prepared && system.image.state === 'unknown') await ensureSandboxImage().catch((error) => console.error('could not check for the template:', errorMessage(error)));
    await reconcileTerminals().catch((error) => console.error('could not check script processes:', errorMessage(error)));
  } else {
    prepared = false;
  }
}

moveCodexLogin();
reapSbxLogin();
reconcileProjects();
markInterruptedWork();

server.listen(HTTP_PORT, '127.0.0.1', () => {
  const url = launchUrl();
  console.log(`\n  Lonca is running at ${url}\n  Data is stored in ${LONCA_HOME}\n`);
  if (process.env.LONCA_NO_OPEN !== '1') {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(opener, [url], () => {});
  }
  void refreshAgents();
  void watchSandboxes();
  setInterval(() => void watchSandboxes(), 5000).unref();
  checkDisk();
  setInterval(checkDisk, 10000).unref();
  // Signing in is checked when it changes, but a Codex sign-in also has to be renewed before it ends.
  setInterval(() => void refreshAgents().catch((error) => console.error('could not check sign-ins:', errorMessage(error))), 60 * 60 * 1000).unref();
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${HTTP_PORT} is already in use. Set PORT to run Lonca on another port.`);
    process.exit(1);
  }
  throw error;
});

// Agents run for hours and keep working while this process is down, but a local tool should
// stay up rather than let one bad event end it for every workspace.
process.on('uncaughtException', (error) => console.error('uncaught error:', error));
process.on('unhandledRejection', (error) => console.error('unhandled rejection:', error));

function shutdown(): void {
  // Git runs in process groups of its own, with the GitHub token for imports and fetches, so it'd outlive this.
  stopHostGit();
  try {
    flushTranscripts();
    flushState({ required: true });
    process.exit(0);
  } catch (error) {
    // Keep pending data and recovery controls available if the disk is full. Another
    // SIGINT/SIGTERM can finish shutdown once writes succeed.
    console.error('Could not save before shutdown; Lonca is still running. Restore storage and try stopping again:', errorMessage(error));
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
