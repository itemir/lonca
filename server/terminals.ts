import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import type { TerminalClientMessage, TerminalInfo, Workspace } from '../shared/types.ts';
import { TTY_DIR } from './config.ts';
import { execText, execTty, isSandboxRunning, stopSandbox, type TtyProcess } from './sandbox.ts';
import { execEnv } from './env.ts';
import { publish } from './events.ts';
import { flushState, getProject, state } from './store.ts';
import { system } from './system.ts';
import { HttpError, KeyedQueue, errorMessage, newId } from './util.ts';
import { publishWorkspace, runningSandbox } from './workspaces.ts';

const SCROLLBACK_BYTES = 512 * 1024;
const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;
// Runtime shutdown closes exec streams before the runtime stops reporting running.
// Let the next recovery pass observe that transition before issuing another exec.
const DISCONNECT_SETTLE_MS = 5000;
// A window that's reloading comes straight back, and the panel shouldn't take its terminal meanwhile.
const WINDOW_RELOAD_MS = 1000;

const RECORD_PID = String.raw`
set -eu
file="$1"; launch="$2"; shift 2
stat=$(sed 's/.*) //' /proc/$$/stat)
start=$(echo "$stat" | cut -d ' ' -f 20)
printf '%s:%s' "$(cat /proc/sys/kernel/random/boot_id)" "$start" > "$file.identity"
echo $$ > "$file"
printf '%s' "$launch" > "$file.launch"
exec "$@"
`;

/** What a PID record says about its terminal's session. */
type RecordState = 'leader' | 'jobs' | 'dead' | 'error';
type Records = Map<string, { state: RecordState; reason?: string }>;

class Terminal {
  info: TerminalInfo;
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** How much of the end of the scrollback arrived with no view attached. */
  private unseen = 0;
  private clients = new Set<WebSocket>();
  /** The window this terminal was moved to. One view at a time decides its size and answers its programs. */
  private window: WebSocket | null = null;
  /** Stays known while its socket reconnects, so Bring it back can still dismiss it. */
  private windowId: string | null = null;
  private dismissedWindows = new Set<string>();
  private windowLeaving: ReturnType<typeof setTimeout> | undefined;
  private process: TtyProcess | null = null;
  private stream: Duplex | null = null;
  private sandbox = '';
  private size = { cols: 100, rows: 30 };
  private onExit?: (code: number | null) => void;
  private generation = 0;
  /** onExit has the result of the process this started, which comes once, when that ends. */
  private reported = false;
  private checkAfter = 0;
  private disconnectedExit: number | null | undefined;

  constructor(info: TerminalInfo) {
    this.info = info;
  }

  get pidFile(): string {
    return `${TTY_DIR}/${this.info.id}.pid`;
  }

  /** Running with no stream to say when it ends, so the recovery pass has to look. */
  get unwatched(): boolean {
    return this.info.status === 'running' && this.process === null;
  }

  get settling(): boolean {
    return this.unwatched && Date.now() < this.checkAfter;
  }

  private record(data: Buffer): void {
    this.chunks.push(data);
    this.bytes += data.length;
    while (this.bytes > SCROLLBACK_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
    if (this.clients.size === 0) this.unseen = Math.min(this.unseen + data.length, this.bytes);
    for (const client of this.clients) {
      // A client that can't keep up misses output rather than growing the server's memory.
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < MAX_CLIENT_BACKLOG) {
        client.send(data, { binary: true });
      }
    }
  }

  async start(
    sandbox: string,
    cmd: string[],
    options: { env?: string[]; workdir?: string; banner?: string; onExit?: (code: number | null) => void },
  ): Promise<void> {
    this.sandbox = sandbox;
    this.onExit = options.onExit;
    this.reported = false;
    this.checkAfter = 0;
    this.disconnectedExit = undefined;
    this.chunks = [];
    this.bytes = 0;
    this.unseen = 0;
    this.info.status = 'running';
    this.info.exitCode = null;
    delete this.info.disconnected;
    delete this.info.jobsOnly;
    const generation = ++this.generation;
    this.broadcastControl({ type: 'reset' });
    if (options.banner) this.record(Buffer.from(options.banner));
    // Recording the pid lets the server signal the process later; sbx has no command for it.
    const launch = newId();
    const wrapped = ['bash', '-c', RECORD_PID, 'lonca-terminal', this.pidFile, launch, ...cmd];
    const process = await execTty(sandbox, wrapped, { env: options.env, workdir: options.workdir, ...this.size });
    this.process = process;
    this.stream = process.stream;
    process.stream.on('data', (data: Buffer) => { if (this.generation === generation) this.record(data); });
    let ended = false;
    const finish = async () => {
      if (ended) return;
      ended = true;
      const code = await process.exitCode().catch(() => null);
      if (this.process !== process) return;
      this.process = null;
      this.stream = null;
      this.disconnectedExit = code;
      const interrupted = code === null || code === 125 || code >= 128;
      if (interrupted) this.checkAfter = Date.now() + DISCONNECT_SETTLE_MS;
      // Losing the stream is not proof that the terminal's jobs exited. The periodic
      // recovery pass keeps its controls available while the sandbox is out of reach.
      try {
        // A sandbox exec would restart a stopped VM just to inspect its dead TTY.
        const running = await isSandboxRunning(this.sandbox);
        if (this.generation !== generation) return;
        if (!running) {
          this.exited(code);
          return;
        }
        if (interrupted) {
          this.recovered(this.sandbox);
          return;
        }
        const record = (await recordStates(this.sandbox, ['status', this.pidFile])).get(this.pidFile)?.state;
        if (this.generation !== generation) return;
        if (record === 'dead') this.exited(code);
        // Its own process has ended, so that code is the result, whatever it left running.
        else if (record === 'jobs') this.leaderExited(code);
        else this.recovered(this.sandbox);
      } catch {
        if (this.generation === generation) this.recovered(this.sandbox);
      }
    };
    process.stream.on('end', finish);
    process.stream.on('close', finish);
    process.stream.on('error', finish);
    publish({ type: 'terminal', terminal: this.info });
    // Starting `sbx exec` is earlier than starting its command. Do not release the
    // operation lock until Stop can address this launch rather than a missing/old PID.
    await execText(sandbox, ['bash', '-c', String.raw`
for _ in $(seq 1 100); do
  [ "$(head -c 32 "$1.launch" 2>/dev/null)" = "$2" ] && exit 0
  sleep 0.05
done
echo 'The terminal did not record its process' >&2
exit 1
`, 'lonca-terminal-ready', this.pidFile, launch], { timeoutMs: 10000 });
  }

  private broadcastControl(message: unknown): void {
    const text = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  }

  attach(socket: WebSocket, windowId?: string): void {
    if (windowId) {
      if (this.dismissedWindows.has(windowId)) {
        socket.send(JSON.stringify({ type: 'window-closed' }));
        socket.close();
        return;
      }
      // A newer window replaces an older one, as a window opened from another browser tab can.
      this.dismissWindow(windowId);
      this.windowId = windowId;
      this.window = socket;
      this.setWindowed(true);
    }
    this.clients.add(socket);
    // A view answers what programs ask the terminal, and shouldn't again for what another already has.
    // What nobody has seen is still waiting for its answers, so that comes after the marker.
    const replay = Buffer.concat(this.chunks);
    const seen = replay.length - this.unseen;
    socket.send(JSON.stringify({ type: 'replay', ...this.size }));
    if (seen > 0) socket.send(replay.subarray(0, seen), { binary: true });
    socket.send(JSON.stringify({ type: 'replayed' }));
    if (this.unseen > 0) socket.send(replay.subarray(seen), { binary: true });
    this.unseen = 0;
    socket.on('message', (data, isBinary) => {
      // Anything else still attached can't take the terminal back from its window.
      if (this.window && this.window !== socket) return;
      if (isBinary) {
        this.stream?.write(data as Buffer);
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as TerminalClientMessage;
        if (message.type === 'resize' && message.cols > 0 && message.rows > 0) {
          this.size = { cols: message.cols, rows: message.rows };
          this.process?.resize(message.cols, message.rows).catch(() => {});
        }
      } catch {
        // Ignore malformed control messages.
      }
    });
    socket.on('close', () => {
      this.clients.delete(socket);
      if (this.window !== socket) return;
      this.window = null;
      this.windowLeaving = setTimeout(() => this.setWindowed(false), WINDOW_RELOAD_MS);
    });
  }

  private setWindowed(windowed: boolean): void {
    if (Boolean(this.info.windowed) === windowed) return;
    if (windowed) this.info.windowed = true;
    else delete this.info.windowed;
    publish({ type: 'terminal', terminal: this.info });
  }

  /** Tells the window to close, which it can't do by itself just from losing its connection. */
  private dismissWindow(reconnectingId?: string): void {
    clearTimeout(this.windowLeaving);
    if (this.windowId && this.windowId !== reconnectingId) this.dismissedWindows.add(this.windowId);
    this.windowId = null;
    const window = this.window;
    this.window = null;
    if (window?.readyState !== WebSocket.OPEN) return;
    window.send(JSON.stringify({ type: 'window-closed' }));
    window.close();
  }

  closeWindow(): void {
    this.dismissWindow();
    this.setWindowed(false);
  }

  recovered(sandbox: string, onExit?: (code: number | null) => void): void {
    this.sandbox = sandbox;
    if (onExit) this.onExit = onExit;
    if (this.bytes === 0) this.record(Buffer.from('This process survived a lost connection. Its previous terminal output is unavailable. You can stop it or start it again.\r\n'));
    this.info.status = 'running';
    this.info.disconnected = true;
    publish({ type: 'terminal', terminal: this.info });
  }

  /** Its own process ended with this code, but something it started is still running. */
  private leaderExited(code: number | null): void {
    this.info.exitCode = code;
    this.info.jobsOnly = true;
    this.report(code);
    this.recovered(this.sandbox);
  }

  /** Found after a restart with only what it started left. Its result was settled then, or can't be known now. */
  adoptJobs(sandbox: string): void {
    this.reported = true;
    this.info.jobsOnly = true;
    this.recovered(sandbox);
  }

  exited(code: number | null): void {
    if (this.info.status === 'exited') return;
    // What a script left running doesn't change its own result.
    const result = this.reported && code === null ? this.info.exitCode : code;
    this.info.status = 'exited';
    this.info.exitCode = result;
    delete this.info.jobsOnly;
    publish({ type: 'terminal', terminal: this.info });
    this.report(result);
  }

  private report(code: number | null): void {
    if (this.reported) return;
    this.reported = true;
    this.onExit?.(code);
  }

  /** Applies what the runtime says about this terminal, for one with no stream to say it. */
  settle(state: RecordState | 'stopped'): void {
    if (this.info.status === 'exited') return;
    // An in-flight process check may predate the disconnect and its exit code.
    if (state !== 'stopped' && this.settling) return;
    if (state === 'stopped') this.retire(this.disconnectedExit ?? null);
    else if (!this.process && state === 'dead') this.exited(this.disconnectedExit ?? null);
    else if (!this.process && state === 'jobs' && this.disconnectedExit !== undefined) {
      this.leaderExited(this.disconnectedExit);
      this.disconnectedExit = undefined;
    } else if (state === 'leader') this.disconnectedExit = undefined;
  }

  async stop(): Promise<void> {
    if (await isSandboxRunning(this.sandbox)) await stopPidFile(this.sandbox, this.pidFile);
    // Only retire the handle after all its jobs are gone, even without a TTY stream.
    this.retire();
  }

  /** Ends this handle, once its processes are known to be gone. */
  retire(code: number | null = null): void {
    this.exited(code);
    this.generation++;
    this.process = null;
    this.stream?.destroy();
    this.stream = null;
  }

  dispose(): void {
    const wasRunning = this.process !== null;
    this.dismissWindow();
    this.stream?.destroy();
    this.process = null;
    this.stream = null;
    for (const client of this.clients) client.close();
    this.clients.clear();
    if (wasRunning) this.report(null);
  }
}

/**
 * Shared by recovery, Stop, rerun, and teardown; transport failures always propagate.
 * `status FILE...` and `scan DIR` describe records, one line each, without failing on a damaged
 * one. `stop FILE` ends a record's whole session, and fails if the record can't be trusted.
 */
const SCRIPT_RECORDS = String.raw`
set -uo pipefail
action="$1"; shift
# Each TTY starts a session led by the recorded PID. Interactive Bash puts jobs in
# separate process groups, so checking/signalling only -$pid would abandon them.
# The session ID stays reserved while its children survive, even if Bash has exited.
# Zombies cannot run and need only be reaped by their parent or the VM's init.
members() { ps -e -o pid=,sid=,stat= | awk -v sid="$1" '$2 == sid && $3 !~ /^Z/ { print $1 }'; }
forget() { rm -f "$1" "$1.identity" "$1.launch"; }
# Sets state to leader, jobs, dead or error, and pid and pids for a session that's still there.
inspect() {
  file="$1"; pid=''; pids=''; reason=''; stale=0
  [ -e "$file" ] || { state=dead; return; }
  [ -f "$file" ] || { state=error; reason='The script PID file is not a regular file'; return; }
  pid=$(timeout 1 head -c 16 "$file") || pid=''
  case "$pid" in ''|*[!0-9]*) state=error; reason='The script PID file is invalid'; return;; esac
  [ "$pid" -gt 1 ] || { state=error; reason='The script PID file is invalid'; return; }
  # A stopped/restarted runtime may reuse a PID. New terminals also record process identity.
  if [ -f "$file.identity" ]; then
    expected=$(timeout 1 head -c 128 "$file.identity")
    actual="$(cat /proc/sys/kernel/random/boot_id):$(echo "$expected" | cut -d : -f 2)"
    if [ -e "/proc/$pid/stat" ]; then
      stat=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null) || stat=''
      [ -z "$stat" ] || actual="$(cat /proc/sys/kernel/random/boot_id):$(echo "$stat" | cut -d ' ' -f 20)"
    fi
    if [ "$actual" != "$expected" ]; then state=dead; stale=1; return; fi
  fi
  pids=$(members "$pid")
  if [ -z "$pids" ]; then state=dead; stale=1; return; fi
  state=jobs
  for member in $pids; do if [ "$member" = "$pid" ]; then state=leader; fi; done
}
describe() {
  if [ "$state" = error ]; then printf '%s\terror\t%s\n' "$1" "$reason"; else printf '%s\t%s\n' "$1" "$state"; fi
}
case "$action" in
  status)
    for file in "$@"; do inspect "$file"; describe "$file"; done
    ;;
  scan)
    # Also clears out records whose sessions are gone, which nothing else would.
    for file in "$1"/*.pid; do
      [ -e "$file" ] || [ -L "$file" ] || continue
      inspect "$file"
      describe "$file"
      if [ "$stale" = 1 ]; then forget "$file"; fi
    done
    ;;
  stop)
    file="$1"
    inspect "$file"
    case "$state" in
      dead) exit 0 ;;
      error) echo "$reason" >&2; exit 1 ;;
    esac
    # A hangup first: it's what a shell takes as its cue to exit, passing it on to its jobs.
    # Then TERM, giving each time to work, then KILL, repeated for anything forked meanwhile.
    for signal in HUP TERM KILL; do
      if [ "$signal" = HUP ]; then attempts=5; else attempts=20; fi
      for attempt in $(seq 1 "$attempts"); do
        [ -n "$pids" ] || { forget "$file"; exit 0; }
        if [ "$attempt" = 1 ] || [ "$signal" = KILL ]; then
          for member in $pids; do kill -"$signal" -- "$member" 2>/dev/null || true; done
        fi
        sleep 0.1
        pids=$(members "$pid")
      done
    done
    [ -n "$pids" ] || { forget "$file"; exit 0; }
    echo 'The terminal session could not be stopped' >&2
    exit 1
    ;;
esac
`;

async function recordStates(sandbox: string, args: string[]): Promise<Records> {
  const output = await execText(sandbox, ['bash', '-c', SCRIPT_RECORDS, 'lonca-process', ...args], { timeoutMs: 15000, maxBytes: 256 * 1024 });
  const records: Records = new Map();
  for (const line of output.split('\n')) {
    const [file, state, reason] = line.split('\t');
    if (file && ['leader', 'jobs', 'dead', 'error'].includes(state)) records.set(file, { state: state as RecordState, reason });
  }
  return records;
}

function stopPidFile(sandbox: string, file: string): Promise<string> {
  return execText(sandbox, ['bash', '-c', SCRIPT_RECORDS, 'lonca-process', 'stop', file], { timeoutMs: 10000 });
}

const terminals = new Map<string, Terminal>();

export function listTerminals(): TerminalInfo[] {
  return [...terminals.values()].map((terminal) => terminal.info);
}

export function attachTerminal(id: string, socket: WebSocket, windowId?: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminal.attach(socket, windowId);
  return true;
}

export function closeTerminalWindow(id: string): void {
  terminals.get(id)?.closeWindow();
}

export function createShell(workspace: Workspace): Promise<TerminalInfo> {
  return scriptQueue.run(workspace.id, () => startShell(workspace));
}

async function startShell(workspace: Workspace): Promise<TerminalInfo> {
  const project = getProject(workspace.projectId);
  const sandbox = await runningSandbox(workspace);
  if (workspace.status !== 'ready') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  const existing = [...terminals.values()].filter((terminal) => terminal.info.workspaceId === workspace.id && terminal.info.kind === 'shell');
  const id = newId();
  const terminal = new Terminal({
    id,
    workspaceId: workspace.id,
    kind: 'shell',
    title: existing.length === 0 ? 'Terminal' : `Terminal ${existing.length + 1}`,
    status: 'running',
    exitCode: null,
  });
  terminals.set(id, terminal);
  await terminal.start(sandbox, ['bash', '--login'], { env: execEnv(project), workdir: workspace.path });
  return terminal.info;
}

export function restartShell(workspace: Workspace, id: string): Promise<void> {
  return scriptQueue.run(workspace.id, async () => {
    const terminal = terminals.get(id);
    if (!terminal || terminal.info.workspaceId !== workspace.id) throw new HttpError(404, 'No such terminal');
    if (terminal.info.status === 'running' && !terminal.info.disconnected) return;
    const sandbox = await runningSandbox(workspace);
    if (workspace.status !== 'ready') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
    await terminal.stop();
    await terminal.start(sandbox, ['bash', '--login'], { env: execEnv(getProject(workspace.projectId)), workdir: workspace.path });
  });
}

export async function closeTerminal(id: string): Promise<void> {
  const terminal = terminals.get(id);
  if (!terminal) return;
  await scriptQueue.run(terminal.info.workspaceId, () => removeTerminal(terminal));
}

async function removeTerminal(terminal: Terminal): Promise<void> {
  await terminal.stop();
  forgetTerminal(terminal);
}

function forgetTerminal(terminal: Terminal): void {
  terminal.dispose();
  terminals.delete(terminal.info.id);
  publish({ type: 'terminal.removed', id: terminal.info.id, workspaceId: terminal.info.workspaceId });
}

export function closeWorkspaceTerminals(workspace: Workspace): Promise<void> {
  return scriptQueue.run(workspace.id, async () => {
    const sandbox = workspace.sandboxName;
    // Every record in the runtime, including those of terminals lost in a restart, stops at once.
    // One that can't be trusted to name its processes is dealt with by stopping the runtime, which
    // ends them all, before checkout cleanup can begin.
    try {
      if (await isSandboxRunning(sandbox)) {
        const records = [...await recordStates(sandbox, ['scan', TTY_DIR])];
        const damaged = records.find(([, record]) => record.state === 'error');
        if (damaged) throw new Error(damaged[1].reason);
        await Promise.all(records.filter(([, record]) => record.state !== 'dead').map(([file]) => stopPidFile(sandbox, file)));
      }
    } catch {
      await stopSandbox(sandbox);
    }
    for (const terminal of [...terminals.values()]) {
      if (terminal.info.workspaceId !== workspace.id) continue;
      terminal.retire();
      forgetTerminal(terminal);
    }
  });
}

const scriptQueue = new KeyedQueue();

export function runSetupScript(workspace: Workspace, script: string): Promise<TerminalInfo> {
  // One at a time, so pressing play twice can't start a second copy nothing can then stop.
  return scriptQueue.run(workspace.id, () => startScript(workspace, script));
}

async function startScript(workspace: Workspace, script: string): Promise<TerminalInfo> {
  const sandbox = await runningSandbox(workspace);
  if (workspace.status !== 'ready') throw new HttpError(409, `${workspace.name} is ${workspace.status}`);
  const id = `${workspace.id}-setup`;
  let terminal = terminals.get(id);
  if (terminal) {
    await terminal.stop();
  } else {
    // A copy can still be running from before a restart.
    await stopPidFile(sandbox, `${TTY_DIR}/${id}.pid`);
    terminal = new Terminal({
      id,
      workspaceId: workspace.id,
      kind: 'setup',
      title: 'Setup',
      status: 'running',
      exitCode: null,
    });
    terminals.set(id, terminal);
  }
  const setupStep = workspace.steps.find((step) => step.id === 'setup');
  const updateSetup = (status: 'running' | 'done' | 'error', detail?: string) => {
    if (!setupStep) return;
    setupStep.status = status;
    setupStep.detail = detail;
    publishWorkspace(workspace);
  };
  updateSetup('running');
  // Automatic runs and reruns both survive a restart with an accurate setup status.
  if (setupStep) flushState();
  const banner = script.trim().split('\n').map((line) => `\x1b[2m$ ${line}\x1b[0m\r\n`).join('');
  try {
    await terminal.start(sandbox, ['bash', '-lc', script], {
      env: execEnv(getProject(workspace.projectId)),
      workdir: workspace.path,
      banner,
      onExit: (code) => updateSetup(code === 0 ? 'done' : 'error', code === 0 ? undefined
        : code === null ? 'The setup script was stopped.' : `The setup script exited with code ${code}.`),
    });
  } catch (error) {
    updateSetup('error', errorMessage(error));
    throw error;
  }
  return terminal.info;
}

export function stopSetupScript(workspace: Workspace): Promise<void> {
  return scriptQueue.run(workspace.id, async () => {
    const id = `${workspace.id}-setup`;
    const terminal = terminals.get(id);
    if (terminal) await terminal.stop();
    else if (await isSandboxRunning(workspace.sandboxName)) {
      await stopPidFile(workspace.sandboxName, `${TTY_DIR}/${id}.pid`);
    }
    if (!terminal && workspace.steps.find((step) => step.id === 'setup')?.status === 'running') {
      updateRecoveredSetup(workspace, null);
    }
  });
}

function updateRecoveredSetup(workspace: Workspace, code: number | null): void {
  const setup = workspace.steps.find((step) => step.id === 'setup');
  if (!setup) return;
  setup.status = code === 0 ? 'done' : 'error';
  setup.detail = code === null ? 'The setup script stopped while its output was disconnected. Rerun it to check the result.' : undefined;
  publishWorkspace(workspace);
}

// Only workspaces present at startup can have terminals an earlier server left running.
// New workspaces already have all their handles here; scanning them can race shutdown.
const needsSearch = new Set(state.workspaces.map((workspace) => workspace.id));
const lastFailure = new Map<string, string>();

/** Reconstruct script controls from the runtime, then monitor processes without a live stream. */
let terminalRecovery: Promise<void> | null = null;
export function reconcileTerminals(): Promise<void> {
  terminalRecovery ??= recoverTerminals().finally(() => { terminalRecovery = null; });
  return terminalRecovery;
}

async function recoverTerminals(): Promise<void> {
  await Promise.all(state.workspaces.map(async (workspace) => {
    // A runtime is searched once. After that, only terminals with no stream to say when they end
    // need asking about, so a workspace with none costs nothing.
    const unwatched = [...terminals.values()].some((terminal) => terminal.info.workspaceId === workspace.id && terminal.unwatched);
    if (!needsSearch.has(workspace.id) && !unwatched) return;
    try {
      await scriptQueue.run(workspace.id, () => recoverWorkspace(workspace));
      lastFailure.delete(workspace.id);
    } catch (error) {
      // One runtime that can't be reached mustn't hold up the rest. It's asked again next time.
      const message = errorMessage(error);
      if (lastFailure.get(workspace.id) !== message) console.error(`could not check script processes in ${workspace.name}:`, message);
      lastFailure.set(workspace.id, message);
    }
  }));
}

async function recoverWorkspace(workspace: Workspace): Promise<void> {
  if (!state.workspaces.includes(workspace)) return;
  if (workspace.status !== 'ready' && workspace.status !== 'stopped') return;
  if (system.sandbox.state !== 'ready') return;
  const sandbox = workspace.sandboxName;
  const mine = () => [...terminals.values()].filter((terminal) => terminal.info.workspaceId === workspace.id);
  if (mine().some((terminal) => terminal.settling)) return;
  if (!await isSandboxRunning(sandbox)) {
    for (const terminal of mine()) terminal.settle('stopped');
    needsSearch.delete(workspace.id);
    return;
  }
  // A stream may have closed during the runtime lookup. Do not race shutdown
  // with either the initial record scan or a later status query.
  if (mine().some((terminal) => terminal.settling)) return;
  const search = needsSearch.has(workspace.id);
  const records = search
    ? await recordStates(sandbox, ['scan', TTY_DIR])
    : await recordStates(sandbox, ['status', ...mine().filter((terminal) => terminal.unwatched).map((terminal) => terminal.pidFile)]);
  if (search) {
    for (const [file, record] of records) {
      const id = /^([a-z0-9]{12}(?:-(?:setup|run))?)\.pid$/.exec(path.posix.basename(file))?.[1];
      if (id && !terminals.has(id) && (record.state === 'leader' || record.state === 'jobs')) adopt(workspace, sandbox, id, record.state);
    }
  }
  // A damaged record says nothing, so its terminal stays as it is.
  for (const terminal of mine()) {
    const record = records.get(terminal.pidFile);
    if (record && record.state !== 'error') terminal.settle(record.state);
  }
  needsSearch.delete(workspace.id);
}

/** Gives back the controls of a terminal an earlier server started. */
function adopt(workspace: Workspace, sandbox: string, id: string, found: 'leader' | 'jobs'): void {
  const script = /-(setup|run)$/.exec(id)?.[1];
  if (script && id !== `${workspace.id}-${script}`) return;
  // Run scripts from older versions still own live processes. Give them ordinary terminal
  // controls so closing or restarting one can stop its whole session after an upgrade.
  const kind = script === 'setup' ? 'setup' : 'shell';
  const title = kind === 'setup' ? 'Setup' : script === 'run' ? 'Recovered run script' : 'Recovered terminal';
  const terminal = new Terminal({ id, workspaceId: workspace.id, kind, title, status: 'running', exitCode: null });
  terminals.set(id, terminal);
  if (found === 'jobs') {
    terminal.adoptJobs(sandbox);
    return;
  }
  terminal.recovered(sandbox, kind === 'setup' ? (code) => updateRecoveredSetup(workspace, code) : undefined);
  if (kind === 'setup') {
    const setup = workspace.steps.find((step) => step.id === 'setup');
    if (setup) { setup.status = 'running'; setup.detail = undefined; publishWorkspace(workspace); }
  }
}
