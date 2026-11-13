import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Session, Workspace } from '../../shared/types.ts';

// Gemini's CLI as Lonca runs it: gemini.py, which sets up a conversation's home and stops a turn
// that would wait out a usage limit, and the sign-ins on this computer that it runs on.

const HELPER = path.resolve(import.meta.dirname, '..', '..', 'server', 'agents', 'gemini.py');

// Stands in for the CLI as 0.68.0 was measured to behave: its output on stdout, what it's waiting
// for on stderr, and on TERM, a result saying it was cancelled and exit code 130.
const CLI = String.raw`
import json, os, signal, sys, time
prompt = sys.stdin.read()
mode = os.environ.get("MODE", "ok")
def emit(event):
    print(json.dumps(event), flush=True)
late = None
def cancelled(*args):
    if late:
        # Its ending closes an MCP server's input, which can start more as it goes.
        late.stdin.close()
        time.sleep(0.3)
    emit({"type": "result", "status": "error", "error": {"type": "FatalCancellationError", "message": "Operation cancelled."}})
    sys.exit(130)
def deaf(*args):
    # Stops saying anything, and carries on.
    os.close(2)
signal.signal(signal.SIGTERM, {"stubborn": signal.SIG_IGN, "spawns": signal.SIG_IGN, "deaf": deaf}.get(mode, cancelled))
if os.environ.get("PIDS"):
    with open(os.path.join(os.environ["PIDS"], "cli.pid"), "w") as f:
        f.write(str(os.getpid()))
if mode in ("orphans", "leaves"):
    # A server it starts, which starts another, neither of which stops when asked.
    import subprocess
    pids = os.environ["PIDS"]
    subprocess.Popen([sys.executable, os.path.join(pids, "server.py"), os.path.join(pids, "server.pid"), os.path.join(pids, "helper.pid")])
    while not os.path.exists(os.path.join(pids, "helper.pid")):
        time.sleep(0.02)
if mode in ("chatty", "chatty-limit"):
    # Something it starts that has its stderr, and goes on writing to it after it's gone.
    import subprocess
    pids = os.environ["PIDS"]
    subprocess.Popen([sys.executable, os.path.join(pids, "writer.py"), os.path.join(pids, "writer.pid")])
    while not os.path.exists(os.path.join(pids, "writer.pid")):
        time.sleep(0.02)
    time.sleep(0.1)
if mode == "many":
    # Several that the helper may not signal, as the harness says by these names.
    import subprocess
    pids = os.environ["PIDS"]
    for n in range(4):
        subprocess.Popen([sys.executable, os.path.join(pids, "server.py"), os.path.join(pids, f"refuse-me-{n}.pid")])
    while not all(os.path.exists(os.path.join(pids, f"refuse-me-{n}.pid")) for n in range(4)):
        time.sleep(0.02)
if mode == "late":
    import subprocess
    pids = os.environ["PIDS"]
    late = subprocess.Popen([sys.executable, os.path.join(pids, "late.py"), os.path.join(pids, "server.pid"), os.path.join(pids, "worker.pid")], stdin=subprocess.PIPE)
    while not os.path.exists(os.path.join(pids, "server.pid")):
        time.sleep(0.02)
if mode == "spawns":
    # As an MCP server it started might, which doesn't stop when asked either.
    import subprocess
    subprocess.Popen([sys.executable, "-c", "import os, signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(60)", os.path.join(os.environ["PIDS"], "server.pid")])
    while not os.path.exists(os.path.join(os.environ["PIDS"], "server.pid")):
        time.sleep(0.02)
emit({"type": "init", "session_id": "s", "model": "m"})
emit({"type": "message", "role": "user", "content": prompt})
if os.environ.get("REPLACE"):
    # A file in place of a link, as sed -i leaves one it edits.
    os.remove(os.environ["REPLACE"])
    with open(os.environ["REPLACE"], "w") as f:
        f.write("a newer note")
if mode == "short":
    print("Attempt 1 failed: Resource has been exhausted (e.g. check quota).. Retrying after 1500ms...", file=sys.stderr, flush=True)
    time.sleep(0.3)
elif mode in ("long", "stubborn", "deaf", "spawns", "orphans", "late", "chatty-limit", "many"):
    print("YOLO mode is enabled. All tool calls will be automatically approved.", file=sys.stderr, flush=True)
    print("Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 19h14m47s.. Retrying after 69287000ms...", file=sys.stderr, flush=True)
    time.sleep(60)
elif mode == "split":
    sys.stderr.write("Attempt 1 failed: You have exhausted your capacity on this model.\nSuggested ")
    sys.stderr.flush()
    time.sleep(0.3)
    sys.stderr.write("retry after 600s.. Retrying after 600000ms...\n")
    sys.stderr.flush()
    time.sleep(60)
elif mode == "fail":
    sys.stderr.write("x" * 5000 + "\nAn unexpected critical error occurred:Error: Request had invalid authentication credentials.\n    at Gaxios._request (file:///gaxios.js:1:1)\n")
    sys.exit(1)
elif mode == "wait":
    time.sleep(60)
emit({"type": "message", "role": "assistant", "content": "done", "delta": True})
emit({"type": "result", "status": "success", "stats": {}})
`;

// Stands in for an MCP server: it ignores TERM, says its pid, and starts another like it if asked.
const SERVER = String.raw`
import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], "w") as f:
    f.write(str(os.getpid()))
if len(sys.argv) > 2:
    subprocess.Popen([sys.executable, __file__, sys.argv[2]])
time.sleep(60)
`;

// An MCP server that, when its input closes, starts a worker, and neither stops when asked.
const LATE = String.raw`
import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], "w") as f:
    f.write(str(os.getpid()))
sys.stdin.read()
subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py"), sys.argv[2]])
time.sleep(60)
`;

// Goes on writing to the stderr it was given, ignoring TERM, for longer than any test.
const WRITER = String.raw`
import os, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], "w") as f:
    f.write(str(os.getpid()))
end = time.monotonic() + 20
while time.monotonic() < end:
    try:
        os.write(2, b".")
    except OSError:
        break
    time.sleep(0.01)
`;

// Runs gemini.py with os.kill refusing the pid in UNSIGNALLABLE, and any started with
// UNSIGNALLABLE_MARK in their arguments, as it would for a process this user may not signal,
// such as one started with sudo.
const HARNESS = String.raw`
import os, runpy, sys
real = os.kill
def refused(pid):
    try:
        with open(os.environ.get("UNSIGNALLABLE", "/nonexistent")) as f:
            if pid == int(f.read() or 0):
                return True
    except (OSError, ValueError):
        pass
    mark = os.environ.get("UNSIGNALLABLE_MARK")
    if mark:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                return mark.encode() in f.read()
        except OSError:
            pass
    return False
def kill(pid, number):
    if refused(pid):
        raise PermissionError(1, "Operation not permitted")
    return real(pid, number)
os.kill = kill
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;

// sudo, as far as these tests go, noting what it's asked: one that runs it, as this user, or one that can't.
const SUDO = String.raw`#!/bin/sh
echo "$*" >> "$(dirname "$0")/../sudo.log"
[ -z "$SUDO_DELAY" ] || sleep "$SUDO_DELAY"
[ "$SUDO_WORKS" = 1 ] || exit 1
shift
exec "$@"
`;

let dir: string;
const groups: number[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-gemini-'));
  fs.writeFileSync(path.join(dir, 'cli.py'), CLI);
  fs.writeFileSync(path.join(dir, 'server.py'), SERVER);
  fs.writeFileSync(path.join(dir, 'late.py'), LATE);
  fs.writeFileSync(path.join(dir, 'writer.py'), WRITER);
  fs.writeFileSync(path.join(dir, 'prompt'), 'FIRST');
});

afterEach(() => {
  for (const pid of groups.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the helper as lonca-run does: the prompt on stdin, output appended to files. */
function start(env: Record<string, string> = {}) {
  const output = fs.openSync(path.join(dir, 'out.jsonl'), 'a');
  const errors = fs.openSync(path.join(dir, 'err.log'), 'a');
  const child = spawn('python3', ['-I', HELPER, 'run', 'python3', '-I', path.join(dir, 'cli.py')], {
    stdio: [fs.openSync(path.join(dir, 'prompt'), 'r'), output, errors],
    env: { ...process.env, ...env },
    detached: true,
  });
  groups.push(child.pid!);
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited };
}

const events = () => fs.readFileSync(path.join(dir, 'out.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const stderr = () => fs.readFileSync(path.join(dir, 'err.log'), 'utf8');

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('gemini.py run', () => {
  it('leaves a turn alone, with its output and stderr as they were, and its exit code', async () => {
    const { exited } = start({ MODE: 'short' });
    expect(await exited).toBe(0);
    expect(events().map((event) => event.type)).toEqual(['init', 'message', 'message', 'result']);
    expect(events()[1].content).toBe('FIRST');
    expect(stderr()).toContain('Retrying after 1500ms...');
  });

  it('stops a turn that would wait out a usage limit, and says so in its output', async () => {
    const started = Date.now();
    const { exited } = start({ MODE: 'long' });
    expect(await exited).toBe(75);
    expect(Date.now() - started).toBeLessThan(5000);
    const [init, prompt, cancelled, limit] = events();
    expect([init.type, prompt.type, cancelled.type]).toEqual(['init', 'message', 'result']);
    expect(limit).toMatchObject({
      type: 'lonca_limit',
      message: 'You have exhausted your capacity on this model. Your quota will reset after 19h14m47s.',
      wait_ms: 69287000,
    });
    expect(Date.parse(limit.timestamp)).toBeGreaterThanOrEqual(started - 1000);
    expect(stderr()).toContain('exhausted your capacity');
  });

  it('waits only as long as it’s told to', async () => {
    const { exited } = start({ MODE: 'short', LONCA_GEMINI_LONGEST_WAIT_SECONDS: '1' });
    expect(await exited).toBe(75);
    expect(events().at(-1)).toMatchObject({ type: 'lonca_limit', wait_ms: 1500 });
  });

  it('reads a wait said over several lines and in pieces', async () => {
    const { exited } = start({ MODE: 'split' });
    expect(await exited).toBe(75);
    expect(events().at(-1)).toMatchObject({
      type: 'lonca_limit', message: 'You have exhausted your capacity on this model.\nSuggested retry after 600s.', wait_ms: 600000,
    });
  });

  it('kills a CLI that doesn’t stop when asked', async () => {
    const { exited } = start({ MODE: 'stubborn' });
    expect(await exited).toBe(75);
    expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
  }, 15000);

  /** Whether a process is still there, which a zombie waiting to be reaped isn't, in effect. */
  const alive = (pid: number) => {
    try {
      return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return false;
    }
  };
  const pid = (name: string) => Number(fs.readFileSync(path.join(dir, name), 'utf8'));

  describe.runIf(process.platform === 'linux')('what the CLI started', () => {
    /** Whether a process that's still running was started with this in its arguments. */
    const running = (marker: string) => fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).some((entry) => {
      try {
        return alive(Number(entry)) && fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(marker);
      } catch {
        return false;
      }
    });
    /** Runs the helper with a process it may not signal, and a sudo that works or doesn't. */
    const unsignallable = (sudoWorks: boolean) => throughHarness({ MODE: 'orphans', UNSIGNALLABLE: path.join(dir, 'server.pid'), SUDO_WORKS: sudoWorks ? '1' : '0' });
    const throughHarness = (env: Record<string, string>) => {
      fs.writeFileSync(path.join(dir, 'harness.py'), HARNESS);
      fs.mkdirSync(path.join(dir, 'sudo-bin'));
      fs.writeFileSync(path.join(dir, 'sudo-bin', 'sudo'), SUDO, { mode: 0o755 });
      const output = fs.openSync(path.join(dir, 'out.jsonl'), 'a');
      const errors = fs.openSync(path.join(dir, 'err.log'), 'a');
      const child = spawn('python3', ['-I', path.join(dir, 'harness.py'), HELPER, 'run', 'python3', '-I', path.join(dir, 'cli.py')], {
        stdio: [fs.openSync(path.join(dir, 'prompt'), 'r'), output, errors],
        env: { ...process.env, PIDS: dir, PATH: `${path.join(dir, 'sudo-bin')}:${process.env.PATH}`, LONCA_GEMINI_CLEANUP_SECONDS: '1', ...env },
        detached: true,
      });
      groups.push(child.pid!);
      return new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    };

    it('is ended when the CLI stopped at a usage limit, though the CLI itself stopped when asked', async () => {
      const { exited } = start({ MODE: 'orphans', PIDS: dir });
      expect(await exited).toBe(75);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      await until(() => !alive(pid('server.pid')) && !alive(pid('helper.pid')), 2000);
    });

    it('is ended when something it started starts more as the CLI ends', async () => {
      const { exited } = start({ MODE: 'late', PIDS: dir });
      expect(await exited).toBe(75);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      // Started after the CLI was asked to stop, and before it ended.
      expect(fs.existsSync(path.join(dir, 'worker.pid'))).toBe(true);
      await until(() => !running(path.join(dir, 'worker.pid')) && !running(path.join(dir, 'server.pid')), 3000);
    });

    it('is ended with sudo where it may not be signalled, and the limit is reported', async () => {
      expect(await unsignallable(true)).toBe(75);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      expect(fs.readFileSync(path.join(dir, 'sudo.log'), 'utf8')).toContain(`-n kill -KILL ${pid('server.pid')}`);
      await until(() => !alive(pid('server.pid')) && !alive(pid('helper.pid')), 3000);
    });

    it('doesn’t stop the limit being reported when it can’t be ended at all', async () => {
      expect(await unsignallable(false)).toBe(75);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      // What it could signal is gone. The rest is the process group's, and goes with the test.
      await until(() => !alive(pid('helper.pid')), 3000);
      expect(alive(pid('server.pid'))).toBe(true);
    });

    it('is ended at a limit, which is reported, though it goes on writing to the CLI’s stderr', async () => {
      const started = Date.now();
      const { exited } = start({ MODE: 'chatty-limit', PIDS: dir, LONCA_GEMINI_CLEANUP_SECONDS: '1' });
      expect(await exited).toBe(75);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      await until(() => !alive(pid('writer.pid')), 2000);
    });

    it('takes no longer than its time for ending them to report the limit, however many need a slow sudo', async () => {
      const started = Date.now();
      expect(await throughHarness({ MODE: 'many', UNSIGNALLABLE_MARK: 'refuse-me', SUDO_WORKS: '0', SUDO_DELAY: '2' })).toBe(75);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      // A second for ending them, and some to start everything and stop the CLI.
      expect(Date.now() - started).toBeLessThan(1000 + 2000);
    });

    it('is left running when the CLI ended by itself', async () => {
      const { exited } = start({ MODE: 'leaves', PIDS: dir });
      expect(await exited).toBe(0);
      expect(alive(pid('server.pid'))).toBe(true);
      expect(alive(pid('helper.pid'))).toBe(true);
    });
  });

  describe.runIf(process.platform === 'linux')('a CLI that has to be killed', () => {
    it('is killed in time when it stops saying anything but carries on', async () => {
      const started = Date.now();
      const { exited } = start({ MODE: 'deaf', PIDS: dir, LONCA_GEMINI_GRACE_SECONDS: '0.5' });
      expect(await exited).toBe(75);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      expect(alive(pid('cli.pid'))).toBe(false);
    });

    it('takes what it started with it, but nothing else in its process group', async () => {
      // As lonca-run's shell is: in the same group, the helper's parent rather than under it, which
      // it would be if bash ran the helper as its last command, in its own place.
      const output = fs.openSync(path.join(dir, 'out.jsonl'), 'a');
      const errors = fs.openSync(path.join(dir, 'err.log'), 'a');
      const child = spawn('bash', ['-c', `sleep 30 & echo $! > "$0/sibling.pid"; python3 -I "$1" run python3 -I "$0/cli.py"; exit $?`, dir, HELPER], {
        stdio: [fs.openSync(path.join(dir, 'prompt'), 'r'), output, errors],
        env: { ...process.env, MODE: 'spawns', PIDS: dir, LONCA_GEMINI_GRACE_SECONDS: '0.5' },
        detached: true,
      });
      groups.push(child.pid!);
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      expect(await exited).toBe(75);
      await until(() => !alive(pid('server.pid')), 2000);
      expect(alive(pid('cli.pid'))).toBe(false);
      expect(alive(pid('sibling.pid'))).toBe(true);
    });
  });

  it('adds what a CLI that failed said on stderr, from the start of a line', async () => {
    const { exited } = start({ MODE: 'fail' });
    expect(await exited).toBe(1);
    const last = events().at(-1);
    expect(last).toMatchObject({ type: 'lonca_exit', code: 1 });
    expect(last.stderr.length).toBeLessThanOrEqual(4000);
    expect(last.stderr).toMatch(/^An unexpected critical error occurred:Error: Request had invalid authentication credentials\.\n/);
  });

  it('ends with the CLI, though something it started goes on writing to its stderr', async () => {
    const started = Date.now();
    const { exited } = start({ MODE: 'chatty', PIDS: dir });
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(events().at(-1)).toMatchObject({ type: 'result', status: 'success' });
  });

  it('waits for a CLI that’s stopping before it ends, so that its last output is there', async () => {
    const { exited } = start({ MODE: 'wait' });
    await until(() => fs.readFileSync(path.join(dir, 'out.jsonl'), 'utf8').includes('"init"'));
    process.kill(-groups.at(-1)!, 'SIGTERM');
    expect(await exited).toBe(130);
    const types = events().map((event) => event.type);
    expect(types.slice(-2)).toEqual(['result', 'lonca_exit']);
    expect(events().at(-2).error.type).toBe('FatalCancellationError');
  });
});

describe('gemini.py setup', () => {
  const home = () => path.join(dir, 'home');
  const state = (name: string) => path.join(dir, 'state', name);
  const original = () => path.join(dir, 'checkout', '.context', 'attachments', 'a1', 'notes.txt');
  /** As geminiSetup says it, for conversation s1, with the workspace's state in the test's directory. */
  const spec = (fields: object = {}) => JSON.stringify({
    home: home(),
    files: {},
    links: { '.gemini/tmp/workspace': state('gemini-tmp/s1'), '.gemini/tmp/workspace/chats': state('gemini-chats') },
    fileLinks: { '.gemini/GEMINI.md': state('gemini-notes/s1.md') },
    attachments: state('gemini-attachments/s1'),
    copies: [],
    ...fields,
  });
  const setUp = (fields: object = {}, bin = path.join(dir, 'bin')) => spawnSync('python3', ['-I', HELPER, 'setup'], {
    input: spec(fields),
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });

  beforeEach(() => {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.dirname(original()), { recursive: true });
    fs.writeFileSync(original(), 'words');
  });

  it('writes the home, keeps what the conversation names where it outlives the VM, and copies attachments there', () => {
    const result = setUp({
      files: { '.gemini/settings.json': '{"a":1}', '.gemini/LONCA.md': 'Lonca says', '.gemini/tmp/workspace/.project_root': '/ws' },
      copies: [{ from: original(), to: 'a1/notes.txt' }],
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(home(), '.gemini', 'settings.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.readFileSync(path.join(home(), '.gemini', 'LONCA.md'), 'utf8')).toBe('Lonca says');
    expect(fs.readlinkSync(path.join(home(), '.gemini', 'tmp', 'workspace'))).toBe(state('gemini-tmp/s1'));
    expect(fs.readFileSync(state('gemini-tmp/s1/.project_root'), 'utf8')).toBe('/ws');
    expect(fs.readlinkSync(path.join(home(), '.gemini', 'tmp', 'workspace', 'chats'))).toBe(state('gemini-chats'));
    expect(fs.statSync(state('gemini-chats')).isDirectory()).toBe(true);
    // The CLI writes its notes through the link, and hasn't yet.
    expect(fs.readlinkSync(path.join(home(), '.gemini', 'GEMINI.md'))).toBe(state('gemini-notes/s1.md'));
    expect(fs.existsSync(state('gemini-notes/s1.md'))).toBe(false);
    expect(fs.readFileSync(state('gemini-attachments/s1/a1/notes.txt'), 'utf8')).toBe('words');
    // Again before the next turn, which rewrites what it says.
    expect(setUp({ files: { '.gemini/LONCA.md': 'Lonca says more' } }).status).toBe(0);
    expect(fs.readFileSync(path.join(home(), '.gemini', 'LONCA.md'), 'utf8')).toBe('Lonca says more');
    expect(fs.readFileSync(state('gemini-attachments/s1/a1/notes.txt'), 'utf8')).toBe('words');
  });

  it('has what the CLI wrote in the home there again after a rebuild, which loses the home', () => {
    expect(setUp({ copies: [{ from: original(), to: 'a1/notes.txt' }] }).status).toBe(0);
    const projectNotes = path.join(home(), '.gemini', 'tmp', 'workspace', 'memory', 'MEMORY.md');
    fs.mkdirSync(path.dirname(projectNotes), { recursive: true });
    fs.writeFileSync(projectNotes, 'a note on the project');
    const notes = path.join(home(), '.gemini', 'GEMINI.md');
    fs.writeFileSync(notes, 'a note');
    fs.rmSync(home(), { recursive: true });
    expect(setUp().status).toBe(0);
    expect(fs.readFileSync(projectNotes, 'utf8')).toBe('a note on the project');
    expect(fs.readFileSync(notes, 'utf8')).toBe('a note');
    expect(fs.readFileSync(state('gemini-attachments/s1/a1/notes.txt'), 'utf8')).toBe('words');
  });

  it('makes the directory the CLI is told it can read attachments in, which it won’t start without, on a turn without any', () => {
    expect(setUp().status).toBe(0);
    expect(fs.readdirSync(state('gemini-attachments/s1'))).toEqual([]);
  });

  it('keeps a note written in place of its link at the next turn too, for a turn that couldn’t put it back', () => {
    expect(setUp().status).toBe(0);
    const notes = path.join(home(), '.gemini', 'GEMINI.md');
    fs.writeFileSync(notes, 'a note');
    // As `sed -i` does.
    fs.rmSync(notes);
    fs.writeFileSync(notes, 'a newer note');
    expect(setUp().status).toBe(0);
    expect(fs.readlinkSync(notes)).toBe(state('gemini-notes/s1.md'));
    expect(fs.readFileSync(state('gemini-notes/s1.md'), 'utf8')).toBe('a newer note');
  });

  describe('as a turn ends', () => {
    const notes = () => path.join(home(), '.gemini', 'GEMINI.md');
    const kept = () => fs.readFileSync(state('gemini-notes/s1.md'), 'utf8');
    /** A turn of the CLI's in this home, which puts a file in place of the link to its notes. */
    const turn = (env: Record<string, string> = {}) => start({ GEMINI_CLI_HOME: home(), REPLACE: notes(), ...env });

    beforeEach(() => {
      expect(setUp().status).toBe(0);
      fs.writeFileSync(notes(), 'a note');
    });

    it('keeps a note written in place of its link, before a rebuild can lose it', async () => {
      expect(await turn().exited).toBe(0);
      fs.rmSync(home(), { recursive: true });
      expect(setUp().status).toBe(0);
      expect(fs.readFileSync(notes(), 'utf8')).toBe('a newer note');
    });

    it('does so however the turn ends, and leaves how it ended as it was', async () => {
      expect(await turn({ MODE: 'fail' }).exited).toBe(1);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_exit', code: 1 });
      expect(fs.readlinkSync(notes())).toBe(state('gemini-notes/s1.md'));
      expect(kept()).toBe('a newer note');

      fs.writeFileSync(notes(), 'a note');
      expect(await turn({ MODE: 'long' }).exited).toBe(75);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit', wait_ms: 69287000 });
      expect(kept()).toBe('a newer note');

      // Stopped.
      fs.writeFileSync(notes(), 'a note');
      const { exited } = turn({ MODE: 'wait' });
      await until(() => fs.lstatSync(notes(), { throwIfNoEntry: false })?.isFile() ?? false);
      process.kill(-groups.at(-1)!, 'SIGTERM');
      expect(await exited).toBe(130);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_exit', code: 130 });
      expect(kept()).toBe('a newer note');
    });

    it('leaves how the turn ended as it was when it can’t put them back', async () => {
      // Where the notes are kept can't be written.
      fs.rmSync(state('gemini-notes'), { recursive: true });
      fs.writeFileSync(state('gemini-notes'), '');
      expect(await turn({ MODE: 'long' }).exited).toBe(75);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_limit' });
      expect(await turn({ MODE: 'fail' }).exited).toBe(1);
      expect(events().at(-1)).toMatchObject({ type: 'lonca_exit', code: 1 });
    });
  });

  it('keeps conversations the CLI saved before its directory was a link', () => {
    const chats = path.join(home(), '.gemini', 'tmp', 'workspace', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, 'session-1.jsonl'), 'saved');
    expect(setUp().status).toBe(0);
    expect(fs.readlinkSync(chats)).toBe(state('gemini-chats'));
    expect(fs.readFileSync(state('gemini-chats/session-1.jsonl'), 'utf8')).toBe('saved');
  });

  it('says so when the VM has no Gemini', () => {
    const result = setUp({}, path.join(dir, 'nothing'));
    expect(result.status).toBe(3);
    expect(fs.existsSync(home())).toBe(false);
  });

  describe('the settings a checkout can’t change', () => {
    const settings = () => path.join(dir, 'etc', 'gemini-cli', 'settings.json');
    const SYSTEM = '{"mcp":{"excluded":["lonca"]}}';
    /** With a sudo that can't, which notes what it was asked to do. */
    const checked = (fields: object = { system: SYSTEM }) => {
      fs.writeFileSync(path.join(dir, 'bin', 'sudo'), `#!/bin/sh\necho "$*" >> "${dir}/sudo.log"\nexit 1\n`, { mode: 0o755 });
      return spawnSync('python3', ['-I', HELPER, 'setup'], {
        input: spec(fields),
        env: { ...process.env, PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, LONCA_GEMINI_SYSTEM_SETTINGS: settings() },
      });
    };
    const said = (result: ReturnType<typeof spawnSync>) => result.stdout.toString().split('\n').filter(Boolean).map((line) => JSON.parse(line));

    it('tries to put them where only root can change them, as boot does, and says so if it can’t, carrying on', () => {
      const result = checked();
      expect(result.status).toBe(0);
      expect(said(result)).toEqual([{ unprotected: settings() }]);
      expect(fs.readFileSync(path.join(dir, 'sudo.log'), 'utf8').split('\n')[0]).toBe(`-n install -d -o root -g root -m 755 ${path.dirname(settings())}`);
      // The conversation's home is still written.
      expect(fs.statSync(state('gemini-chats')).isDirectory()).toBe(true);
    });

    it('doesn’t take ones anybody can change, or other ones, for them', () => {
      fs.mkdirSync(path.dirname(settings()), { recursive: true });
      fs.writeFileSync(settings(), `${SYSTEM}\n`);
      expect(said(checked())).toEqual([{ unprotected: settings() }]);
      fs.writeFileSync(settings(), '{}');
      expect(said(checked())).toEqual([{ unprotected: settings() }]);
    });

    it('leaves them be when it isn’t asked about them', () => {
      expect(said(checked({}))).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'sudo.log'))).toBe(false);
    });

    it('is reported from what setup says, and nothing else', async () => {
      const { geminiSettingsUnprotected } = await import('../../server/agents/gemini.ts');
      expect(geminiSettingsUnprotected('{"unprotected":"/etc/gemini-cli/settings.json"}\n')).toBe(true);
      expect(geminiSettingsUnprotected('')).toBe(false);
      expect(geminiSettingsUnprotected('unprotected\n{"other":1}')).toBe(false);
    });
  });
});

describe('Gemini’s sign-ins on this computer', () => {
  let home: string;
  let store: typeof import('../../server/store.ts');
  let boundary: typeof import('../../server/boundary.ts');
  let system: typeof import('../../server/system.ts');
  let login: typeof import('../../server/gemini-login.ts');
  let runner: typeof import('../../server/agents/runner.ts');

  const boundaryFile = (name: string) => path.join(home, 'boundary', name);
  const loginFile = (id = 'gemini') => path.join(home, 'helper-credentials', id, 'login.json');
  const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  // Made up, as the CLI's own client isn't kept in Lonca.
  const CLIENT = { client_id: 'made-up-client.apps.googleusercontent.com', client_secret: 'made-up-client-secret' };
  const google = (fields: object = {}) => ({
    kind: 'google', access_token: 'ya29.current', refresh_token: '1//refresh', expiry_date: Date.now() + 3600e3,
    id_token: idToken({ email: 'someone@example.com' }), scope: 'https://www.googleapis.com/auth/cloud-platform', token_type: 'Bearer', ...CLIENT, ...fields,
  });
  const seed = (content: object, id = 'gemini') => {
    fs.mkdirSync(path.dirname(loginFile(id)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(loginFile(id), JSON.stringify(content), { mode: 0o600 });
    login.shareGeminiCredentialWithProxy(id);
  };
  const project = (env: Record<string, string> = {}) => ({ id: 'project', settings: { env } }) as unknown as Project;
  const answer = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(async () => {
    vi.resetModules();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-gemini-home-')));
    vi.stubEnv('LONCA_HOME', home);
    store = await import('../../server/store.ts');
    boundary = await import('../../server/boundary.ts');
    system = await import('../../server/system.ts');
    login = await import('../../server/gemini-login.ts');
    runner = await import('../../server/agents/runner.ts');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    store.flushState();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('gives every state from before Gemini a first Gemini sign-in, and its models', async () => {
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
      version: 1, projects: [], workspaces: [], sessions: [], settings: {},
      profiles: [{ id: 'claude', agent: 'claude', name: '' }, { id: 'claude-0123456789ab', agent: 'claude', name: 'work' }, { id: 'codex', agent: 'codex', name: '' }],
      catalog: { claude: { label: 'Claude', models: [] }, codex: { label: 'Codex', models: [{ id: 'gpt-x', label: 'GPT-X', efforts: ['low'], defaultEffort: 'low' }] } },
    }));
    vi.resetModules();
    const loaded = await import('../../server/store.ts');
    expect(loaded.state.profiles.map((profile) => profile.id)).toEqual(['claude', 'claude-0123456789ab', 'codex', 'gemini']);
    expect(loaded.state.catalog.gemini.models.map((model) => model.id)).toEqual(['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite']);
    expect(loaded.state.catalog.codex.models.map((model) => model.id)).toEqual(['gpt-x']);
  });

  it('keeps a login readable only by you, out of anything a VM mounts, and gives the proxy what it sends, in a file for each kind', () => {
    login.saveGeminiApiKey('AIzaKEY', 'gemini');
    expect(fs.statSync(loginFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(loginFile())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(boundaryFile('gemini.key')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8'))).toEqual({ kind: 'key', apiKey: 'AIzaKEY' });
    expect(fs.readFileSync(boundaryFile('gemini.key'), 'utf8')).toBe('AIzaKEY');
    expect(fs.existsSync(boundaryFile('gemini'))).toBe(false);
    seed(google());
    expect(fs.readFileSync(boundaryFile('gemini'), 'utf8')).toBe('ya29.current');
    expect(fs.existsSync(boundaryFile('gemini.key'))).toBe(false);
    expect(() => login.saveGeminiApiKey('AIzaKEY', 'codex')).toThrow();
    expect(() => login.saveGeminiApiKey('AIzaKEY', '../gemini')).toThrow();
  });

  it('says how it’s signed in, and takes nothing that isn’t a whole login for one', () => {
    seed(google());
    system.describeProfiles();
    expect(system.system.profiles.gemini).toMatchObject({ signedIn: true, usesKey: false, summary: 'Signed in with Google as someone@example.com' });
    seed({ kind: 'key', apiKey: 'AIzaSyEndingIn1234' });
    system.describeProfiles();
    expect(system.system.profiles.gemini).toMatchObject({ signedIn: true, usesKey: true, summary: 'Using an API key ending in 1234' });
    for (const partial of [{ kind: 'google', access_token: 'ya29.x', expiry_date: 1 }, { access_token: 'ya29.x', refresh_token: 'r', expiry_date: 1 }, { kind: 'key' }]) {
      seed(partial);
      expect(fs.existsSync(boundaryFile('gemini'))).toBe(false);
      system.describeProfiles();
      expect(system.system.profiles.gemini.signedIn).toBe(false);
    }
  });

  it('signs out, and forgets a removed sign-in, leaving the proxy nothing', () => {
    seed(google());
    login.signOutGemini('gemini');
    expect(fs.existsSync(loginFile())).toBe(false);
    expect(fs.existsSync(boundaryFile('gemini'))).toBe(false);
    seed({ kind: 'key', apiKey: 'AIzaKEY' });
    login.signOutGemini('gemini');
    expect(fs.existsSync(boundaryFile('gemini.key'))).toBe(false);
    seed({ kind: 'key', apiKey: 'AIzaKEY' }, 'gemini-0123456789ab');
    login.forgetGeminiLogin('gemini-0123456789ab');
    expect(fs.existsSync(path.dirname(loginFile('gemini-0123456789ab')))).toBe(false);
    expect(fs.existsSync(boundaryFile('gemini-0123456789ab'))).toBe(false);
    expect(fs.existsSync(boundaryFile('gemini-0123456789ab.key'))).toBe(false);
  });

  describe('renewing a Google account’s access token', () => {
    it('leaves one with time left alone', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      seed(google());
      expect(await login.renewGeminiLogin('gemini')).toBe('not-due');
      seed({ kind: 'key', apiKey: 'AIzaKEY' });
      expect(await login.renewGeminiLogin('gemini')).toBe('not-due');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('renews one about to run out, on this computer, with the client it came from', async () => {
      const fetch = vi.fn(async () => answer(200, { access_token: 'ya29.renewed', expires_in: 3599, token_type: 'Bearer', scope: 'renewed-scope' }));
      vi.stubGlobal('fetch', fetch);
      seed(google({ expiry_date: Date.now() + 5 * 60e3 }));
      expect(await login.renewGeminiLogin('gemini')).toBe('renewed');
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(String(init.body));
      expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', refresh_token: '1//refresh', ...CLIENT });
      const saved = JSON.parse(fs.readFileSync(loginFile(), 'utf8'));
      expect(saved).toMatchObject({ kind: 'google', access_token: 'ya29.renewed', refresh_token: '1//refresh', scope: 'renewed-scope', ...CLIENT });
      expect(saved.expiry_date).toBeGreaterThan(Date.now() + 3500e3);
      expect(fs.readFileSync(boundaryFile('gemini'), 'utf8')).toBe('ya29.renewed');
      expect(fs.statSync(loginFile()).mode & 0o777).toBe(0o600);
    });

    it('can’t renew a login that doesn’t say which client it came from, and says so once', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      seed(google({ expiry_date: Date.now() - 1000, client_id: undefined, client_secret: undefined }));
      system.describeProfiles();
      await system.renewGemini('gemini');
      expect(await login.renewGeminiLogin('gemini')).toBe('failed');
      expect(fetch).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0])).toMatch(/doesn’t say which client it came from/);
      // It still works for as long as its token does, and isn't taken for one Google refused.
      expect(system.system.profiles.gemini).toMatchObject({ signedIn: true });
      expect(system.system.profiles.gemini.rejected).toBeFalsy();
      expect(fs.readFileSync(boundaryFile('gemini'), 'utf8')).toBe('ya29.current');
    });

    it('keeps a new refresh token when Google sends one', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => answer(200, { access_token: 'ya29.renewed', refresh_token: '1//rotated', expires_in: 3599 })));
      seed(google({ expiry_date: Date.now() - 1000 }));
      expect(await login.renewGeminiLogin('gemini')).toBe('renewed');
      expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8')).refresh_token).toBe('1//rotated');
    });

    it('marks one Google won’t renew as needing a new sign-in, and doesn’t ask again', async () => {
      const fetch = vi.fn(async () => answer(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
      vi.stubGlobal('fetch', fetch);
      seed(google({ expiry_date: Date.now() - 1000 }));
      system.describeProfiles();
      await system.renewGemini('gemini');
      expect(system.system.profiles.gemini).toMatchObject({ signedIn: true, rejected: true });
      expect(fs.readFileSync(boundaryFile('gemini'), 'utf8')).toBe('ya29.current');
      expect(await login.renewGeminiLogin('gemini')).toBe('refused');
      expect(fetch).toHaveBeenCalledTimes(1);
      // A status worked out afresh says so too.
      system.describeProfiles();
      expect(system.system.profiles.gemini.rejected).toBe(true);
      // Signing in again is a login that can be renewed.
      seed(google({ refresh_token: '1//new', expiry_date: Date.now() - 1000 }));
      fetch.mockImplementation(async () => answer(200, { access_token: 'ya29.again', expires_in: 3599 }));
      expect(await login.renewGeminiLogin('gemini')).toBe('renewed');
    });

    it('doesn’t count a refusal against a key saved after Google refused, before that was applied', async () => {
      // Anything between the renewal's answer and its being applied, which a saved key and its cleared flag can be.
      let between = async () => {};
      vi.resetModules();
      vi.doMock('../../server/gemini-login.ts', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../server/gemini-login.ts')>();
        return {
          ...actual,
          renewGeminiLogin: async (profileId: string) => {
            const outcome = await actual.renewGeminiLogin(profileId);
            await between();
            return outcome;
          },
        };
      });
      try {
        const late = await import('../../server/system.ts');
        const lateLogin = await import('../../server/gemini-login.ts');
        vi.stubGlobal('fetch', vi.fn(async () => answer(400, { error: 'invalid_grant' })));
        seed(google({ expiry_date: Date.now() - 1000 }));
        late.describeProfiles();
        between = async () => {
          lateLogin.saveGeminiApiKey('AIzaSAVED-IN-BETWEEN', 'gemini');
          late.describeProfiles();
          late.clearAgentRejected('gemini');
        };
        await late.renewGemini('gemini');
        expect(late.system.profiles.gemini).toMatchObject({ signedIn: true, usesKey: true });
        expect(late.system.profiles.gemini.rejected).toBeFalsy();
      } finally {
        vi.doUnmock('../../server/gemini-login.ts');
      }
    });

    it('tries again later when Google can’t be reached', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      seed(google({ expiry_date: Date.now() - 1000 }));
      system.describeProfiles();
      await system.renewGemini('gemini');
      expect(system.system.profiles.gemini.rejected).toBeFalsy();
      vi.stubGlobal('fetch', vi.fn(async () => answer(500, { error: 'internal' })));
      expect(await login.renewGeminiLogin('gemini')).toBe('failed');
      vi.stubGlobal('fetch', vi.fn(async () => answer(200, { access_token: 'ya29.later', expires_in: 3599 })));
      expect(await login.renewGeminiLogin('gemini')).toBe('renewed');
    });

    it('doesn’t let a renewal under way undo signing out, signing in again or removing it, whatever Google says', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const google_says of [
        answer(200, { access_token: 'ya29.renewed', expires_in: 3599 }),
        answer(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
        answer(500, { error: 'internal' }),
      ]) {
        for (const meanwhile of [
          () => login.signOutGemini('gemini'),
          () => seed(google({ access_token: 'ya29.signed-in-again', refresh_token: '1//other' })),
          () => seed({ kind: 'key', apiKey: 'AIzaSAVED-MEANWHILE' }),
          () => login.forgetGeminiLogin('gemini'),
        ]) {
          let respond: (response: Response) => void = () => {};
          const fetch = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
          vi.stubGlobal('fetch', fetch);
          seed(google({ expiry_date: Date.now() - 1000 }));
          system.describeProfiles();
          const renewing = system.renewGemini('gemini');
          await until(() => fetch.mock.calls.length > 0);
          meanwhile();
          const after = fs.existsSync(loginFile()) ? fs.readFileSync(loginFile(), 'utf8') : null;
          const proxy = fs.existsSync(boundaryFile('gemini')) ? fs.readFileSync(boundaryFile('gemini'), 'utf8') : undefined;
          respond(google_says.clone());
          await renewing;
          expect(fs.existsSync(loginFile()) ? fs.readFileSync(loginFile(), 'utf8') : null).toBe(after);
          expect(fs.existsSync(boundaryFile('gemini')) ? fs.readFileSync(boundaryFile('gemini'), 'utf8') : undefined).toBe(proxy);
          // What Google said was about the login that was there before.
          system.describeProfiles();
          expect(system.system.profiles.gemini?.rejected).toBeFalsy();
          expect(login.geminiRenewalRefused('gemini')).toBe(false);
        }
      }
      expect(logged).not.toHaveBeenCalled();
    });
  });

  describe('a turn its service refused', () => {
    const started = () => Date.now() - 1000;

    beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));

    it('counts against an API key at once', async () => {
      const turn = started();
      seed({ kind: 'key', apiKey: 'AIzaKEY' });
      fs.utimesSync(loginFile(), new Date(turn - 60e3), new Date(turn - 60e3));
      system.describeProfiles();
      await system.signInRefused('gemini', turn);
      expect(system.system.profiles.gemini.rejected).toBe(true);
    });

    it('says nothing about a key saved since the turn began, which may have replaced what it ran on', async () => {
      const turn = Date.now() - 60e3;
      seed({ kind: 'key', apiKey: 'AIzaSAVED-SINCE' });
      system.describeProfiles();
      await system.signInRefused('gemini', turn);
      expect(system.system.profiles.gemini.rejected).toBeFalsy();
    });

    it('counts against a Google account whose token should still have worked', async () => {
      const turn = started();
      seed(google());
      fs.utimesSync(loginFile(), new Date(turn - 60e3), new Date(turn - 60e3));
      system.describeProfiles();
      await system.signInRefused('gemini', turn);
      expect(system.system.profiles.gemini.rejected).toBe(true);
    });

    it('renews a token that ran out, perhaps while Lonca wasn’t running, rather than count it', async () => {
      const fetch = vi.fn(async () => answer(200, { access_token: 'ya29.renewed', expires_in: 3599 }));
      vi.stubGlobal('fetch', fetch);
      seed(google({ expiry_date: Date.now() - 60e3 }));
      fs.utimesSync(loginFile(), new Date(Date.now() - 7200e3), new Date(Date.now() - 7200e3));
      system.describeProfiles();
      await system.signInRefused('gemini', started());
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(system.system.profiles.gemini.rejected).toBeFalsy();
      expect(fs.readFileSync(boundaryFile('gemini'), 'utf8')).toBe('ya29.renewed');
      // Google refusing to renew it is what counts.
      seed(google({ expiry_date: Date.now() - 60e3, refresh_token: '1//dead' }));
      fs.utimesSync(loginFile(), new Date(Date.now() - 7200e3), new Date(Date.now() - 7200e3));
      fetch.mockImplementation(async () => answer(400, { error: 'invalid_grant' }));
      await system.signInRefused('gemini', started());
      expect(system.system.profiles.gemini.rejected).toBe(true);
    });

    it('says nothing about a token saved since the turn began, which it may never have had', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const turn = Date.now() - 60e3;
      seed(google());
      system.describeProfiles();
      await system.signInRefused('gemini', turn);
      expect(system.system.profiles.gemini.rejected).toBeFalsy();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('tries a key with Google, and only counts it refused when Google says so', async () => {
    vi.stubEnv('LONCA_SKIP_CREDENTIAL_CHECK', '');
    vi.resetModules();
    const fresh = await import('../../server/system.ts');
    const cases: [Response | Error, string][] = [
      [answer(200, { models: [] }), 'accepted'],
      [answer(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), 'refused'],
      [answer(400, { error: { code: 400, message: 'Something else' } }), 'unknown'],
      [answer(503, {}), 'unknown'],
      [new TypeError('fetch failed'), 'unknown'],
    ];
    for (const [response, outcome] of cases) {
      const fetch = vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
      });
      vi.stubGlobal('fetch', fetch);
      expect(await fresh.checkGeminiKey('AIzaKEY')).toBe(outcome);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIzaKEY');
      expect(url).not.toContain('AIzaKEY');
    }
  });

  describe('what a process in a VM is given', () => {
    it('is a placeholder in the variables for the kind of sign-in, with the other kind’s emptied', () => {
      expect(boundary.placeholderEnv()).toEqual([]);
      seed(google());
      expect(boundary.placeholderEnv()).toEqual(['GOOGLE_GENAI_USE_GCA=true', 'GOOGLE_CLOUD_ACCESS_TOKEN=goog-lonca-placeholder', 'GEMINI_API_KEY=', 'LONCA_GEMINI_AUTH=oauth-personal']);
      seed({ kind: 'key', apiKey: 'AIzaKEY' });
      expect(boundary.placeholderEnv()).toEqual(['GEMINI_API_KEY=goog-key-lonca-placeholder', 'GOOGLE_GENAI_USE_GCA=', 'GOOGLE_CLOUD_ACCESS_TOKEN=', 'LONCA_GEMINI_AUTH=gemini-api-key']);
    });

    it('is the turn’s own sign-in for its provider, and the defaults for the others', () => {
      store.updateSecrets({ claudeToken: 'sk-ant-oat01-real' });
      seed(google());
      const other = { id: 'gemini-0123456789ab', agent: 'gemini' as const };
      store.state.profiles.push({ ...other, name: 'other' });
      seed({ kind: 'key', apiKey: 'AIzaOTHER' }, other.id);
      const env = boundary.placeholderEnv(project(), other);
      expect(env).toContain('GEMINI_API_KEY=goog-key-lonca-profile-0123456789ab-placeholder');
      expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-lonca-placeholder');
      expect(env.join('\n')).not.toMatch(/AIza|ya29/);
    });

    it('is a project’s own key instead of any sign-in, where the CLI reads one', () => {
      seed(google());
      expect(boundary.placeholderEnv(project({ GEMINI_API_KEY: 'AIzaOWN' }))).toEqual(['GEMINI_API_KEY=AIzaOWN', 'LONCA_GEMINI_AUTH=gemini-api-key']);
      expect(boundary.placeholderEnv(project({ GOOGLE_API_KEY: 'AIzaGOOGLE' }))).toEqual(['GEMINI_API_KEY=AIzaGOOGLE', 'LONCA_GEMINI_AUTH=gemini-api-key']);
      // Vertex AI reads it from where it is, and the CLI chooses from the project's own variables.
      expect(boundary.placeholderEnv(project({ GOOGLE_API_KEY: 'AIzaVERTEX', GOOGLE_GENAI_USE_VERTEXAI: 'true' }))).toEqual([]);
    });

    it('lets a project’s own variables say where Gemini is, after Lonca’s', async () => {
      seed({ kind: 'key', apiKey: 'AIzaKEY' });
      const session = { id: 'conversation', agent: 'gemini', role: 'agent', work: { job: 'analyze' } } as unknown as Session;
      const env = runner.turnEnv(session, project({ GOOGLE_GEMINI_BASE_URL: 'http://mock', GEMINI_CLI_TRUST_WORKSPACE: 'false' }), 'gemini');
      expect(env).toEqual(expect.arrayContaining([
        'GEMINI_CLI_HOME=/var/tmp/lonca/gemini/conversation', 'NO_BROWSER=true', 'GEMINI_CLI_NO_RELAUNCH=true', 'GOOGLE_GEMINI_BASE_URL=http://mock',
        'LONCA_GEMINI_AUTH=gemini-api-key', 'GEMINI_API_KEY=goog-key-lonca-placeholder', 'LONCA_SCRATCH=/var/tmp/lonca/agent-scratch/conversation',
      ]));
      expect(env.indexOf('GEMINI_CLI_TRUST_WORKSPACE=false')).toBeGreaterThan(env.indexOf('GEMINI_CLI_TRUST_WORKSPACE=true'));
      // Where the settings root owns are, which a checkout's .gemini/.env can't say.
      expect(env).toContain('GEMINI_CLI_SYSTEM_SETTINGS_PATH=/etc/gemini-cli/settings.json');
      // The VM is the sandbox, unless the project's own variables say otherwise.
      expect(env).toContain('GEMINI_SANDBOX=false');
      const own = runner.turnEnv(session, project({ GEMINI_SANDBOX: 'docker' }), 'gemini');
      expect(own.indexOf('GEMINI_SANDBOX=docker')).toBeGreaterThan(own.indexOf('GEMINI_SANDBOX=false'));
      expect(env.some((entry) => entry.startsWith('LONCA_RUN_DIR='))).toBe(false);
    });

    it('gives a Lead’s turn its directory last, where neither the project nor its checkout can move it', async () => {
      seed(google());
      const lead = { id: 'lead', agent: 'gemini', role: 'lead' } as unknown as Session;
      const env = runner.turnEnv(lead, project({ LONCA_RUN_DIR: '/tmp/elsewhere' }), 'gemini', '/var/tmp/lonca/agent-runs/run1');
      expect(env.at(-1)).toBe('LONCA_RUN_DIR=/var/tmp/lonca/agent-runs/run1');
      expect(env.indexOf('LONCA_RUN_DIR=/tmp/elsewhere')).toBeLessThan(env.length - 1);
      // Claude's Lead isn't given it.
      const claude = { id: 'lead', agent: 'claude', role: 'lead' } as unknown as Session;
      expect(runner.turnEnv(claude, project(), 'claude', '/var/tmp/lonca/agent-runs/run1').some((entry) => entry.startsWith('LONCA_RUN_DIR='))).toBe(false);
    });
  });
});

describe('a conversation’s home', () => {
  it('has its instructions, its thinking level and, for a Lead, no sub-agents of its own', async () => {
    const { geminiSetup } = await import('../../server/agents/gemini.ts');
    const { paths } = await import('../../server/config.ts');
    const session = { id: 'lead', model: 'gemini-3.5-flash', effort: 'medium' } as Session;
    const workspace = { id: 'w', path: '/Users/me/.lonca/projects/p/workspaces/oslo' } as Workspace;
    const tools = { command: 'python3', args: ['-I', '/run/lonca-tools.py', '/run'] };
    const spec = JSON.parse(geminiSetup({ session, workspace, systemPrompt: 'You are the Lead.', attachments: [], tools }).stdin!);
    const settings = JSON.parse(spec.files['.gemini/settings.json']);
    expect(settings.modelConfigs.customAliases['chat-base-3']).toEqual({
      extends: 'chat-base', modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: 'MEDIUM' } } },
    });
    // Its tools are in the settings root owns, which a checkout can't replace.
    expect(settings.mcpServers).toBeUndefined();
    expect(settings.experimental).toEqual({ enableAgents: false });
    expect(settings.security.auth.selectedType).toBe('${LONCA_GEMINI_AUTH:-}');
    expect(settings.context.fileName).toEqual(['GEMINI.md', 'LONCA.md']);
    expect(settings.general).toMatchObject({ topicUpdateNarration: false, sessionRetention: { enabled: false }, enableAutoUpdate: false });
    expect(spec.files['.gemini/LONCA.md']).toBe('You are the Lead.');
    expect(JSON.parse(spec.files['.gemini/projects.json'])).toEqual({ projects: { [workspace.path]: 'workspace' } });
    expect(spec.files['.gemini/tmp/workspace/.project_root']).toBe(workspace.path);
    expect(spec.files['lonca-policy.toml']).toContain('toolName = "invoke_agent"\ndecision = "deny"');
    // What the settings root owns leave out everywhere else.
    expect(spec.files['lonca-policy.toml']).toContain('mcpName = "lonca"\ntoolName = "*"\ndecision = "allow"');
    // Where a rebuild keeps them: the CLI's files for the workspace, then its conversation in
    // there, and the notes it keeps for every project.
    expect(Object.entries(spec.links)).toEqual([
      ['.gemini/tmp/workspace', `${paths.agentState('w')}/gemini-tmp/lead`],
      ['.gemini/tmp/workspace/chats', `${paths.agentState('w')}/gemini-chats`],
    ]);
    expect(spec.fileLinks).toEqual({ '.gemini/GEMINI.md': `${paths.agentState('w')}/gemini-notes/lead.md` });
    // Anything else keeps the CLI's own sub-agents.
    const plain = JSON.parse(JSON.parse(geminiSetup({ session: { ...session, id: 'plain', effort: 'xhigh' }, workspace, systemPrompt: '', attachments: [] }).stdin!).files['.gemini/settings.json']);
    expect(plain.experimental).toBeUndefined();
    expect(plain.modelConfigs.customAliases['chat-base-3'].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel).toBe('HIGH');
  });

  it('copies attachments where the CLI is told it may read, kept with the conversation, and the prompt lists the copies', async () => {
    const { geminiAdapter, geminiAttachments, geminiSetup } = await import('../../server/agents/gemini.ts');
    const { paths } = await import('../../server/config.ts');
    const session = { id: 's1', model: 'gemini-3.5-flash', effort: 'high', resumeId: 'previous' } as Session;
    const workspace = { id: 'w', path: '/ws' } as Workspace;
    // In the workspace's state, which outlives the VM and has the same path in it.
    const kept = `${paths.agentState('w')}/gemini-attachments/s1`;
    const attachments = [{ name: 'a.png', path: '.context/attachments/abc/a.png', size: 1, mime: 'image/png' }];
    expect(geminiAttachments(workspace, session.id, attachments)).toEqual([{ ...attachments[0], path: `${kept}/abc/a.png` }]);
    const spec = JSON.parse(geminiSetup({ session, workspace, systemPrompt: '', attachments }).stdin!);
    expect(spec.attachments).toBe(kept);
    expect(spec.copies).toEqual([{ from: '/ws/.context/attachments/abc/a.png', to: 'abc/a.png' }]);
    const command = geminiAdapter.command({ session, workspace, project: {} as Project, systemPrompt: '', attachments });
    expect(command.slice(command.indexOf('gemini'))).toEqual([
      'gemini', '--output-format', 'stream-json', '--approval-mode', 'yolo', '-m', 'gemini-3.5-flash',
      '--include-directories', kept, '--resume', 'previous',
    ]);
    const lead = geminiAdapter.command({ session: { ...session, resumeId: null }, workspace, project: {} as Project, systemPrompt: '', attachments: [], tools: { command: 'python3', args: [] } });
    expect(lead).toEqual(expect.arrayContaining(['--allowed-mcp-server-names', 'lonca', '--admin-policy', '/var/tmp/lonca/gemini/s1/lonca-policy.toml']));
    expect(lead).not.toContain('--resume');
  });

  it('has the Lead’s tools in the settings root owns, from its turn’s directory, and left out of every other conversation', async () => {
    const { GEMINI_SYSTEM_SETTINGS } = await import('../../server/agents/gemini.ts');
    const system = JSON.parse(GEMINI_SYSTEM_SETTINGS);
    expect(system.mcpServers).toEqual({
      lonca: { command: 'python3', args: ['-I', '${LONCA_RUN_DIR}/lonca-tools.py', '${LONCA_RUN_DIR}'], timeout: 660000, trust: true },
    });
    // A Lead's CLI is told to start these by name, which overrides this. Nothing else starts them.
    expect(system.mcp).toEqual({ excluded: ['lonca'] });
    // Boot puts it in single quotes.
    expect(GEMINI_SYSTEM_SETTINGS).not.toContain("'");
  });
});

// The CLI's own client secret, which signing in reads from the CLI that made the login.
const BUNDLE = '/tmp/gemini-probe/node_modules/@google/gemini-cli/bundle';

describe('the client a Google login came from', () => {
  // Made up, in pieces, so that this file doesn't look like it holds a secret.
  const secret = (tail: string) => ['G', 'O', 'C', 'S', 'P', 'X', '-', tail].join('');
  /** Runs the search Lonca runs in the helper, with this PATH. */
  const search = async (bin: string) => {
    const { CLIENT_SECRET_SEARCH } = await import('../../server/gemini-login.ts');
    const [command, ...args] = CLIENT_SECRET_SEARCH;
    return spawnSync(command, args, { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' }).stdout;
  };

  it.skipIf(!fs.existsSync(BUNDLE))('is the one secret in the bundle of the CLI on PATH, which repeats it', async () => {
    const { clientSecretIn } = await import('../../server/gemini-login.ts');
    const found = await search('/tmp/gemini-probe/node_modules/.bin');
    expect(found.trim().split('\n')).toHaveLength(1);
    expect(clientSecretIn(found)).toMatch(/^G[O]CSPX-[A-Za-z0-9_-]+$/);
  });

  it('follows the command to its bundle, and is nothing it can tell where there isn’t exactly one', async () => {
    const { clientSecretIn } = await import('../../server/gemini-login.ts');
    const bundle = path.join(dir, 'lib', 'bundle');
    fs.mkdirSync(bundle, { recursive: true });
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(bundle, 'gemini.js'), '');
    fs.symlinkSync(path.join(bundle, 'gemini.js'), path.join(dir, 'bin', 'gemini'));
    fs.writeFileSync(path.join(bundle, 'a.js'), `const s = "${secret('one')}";`);
    fs.writeFileSync(path.join(bundle, 'b.js'), `const t = "${secret('one')}";`);
    fs.writeFileSync(path.join(bundle, 'notes.txt'), secret('elsewhere'));
    expect(clientSecretIn(await search(path.join(dir, 'bin')))).toBe(secret('one'));
    fs.writeFileSync(path.join(bundle, 'c.js'), `const u = "${secret('two')}";`);
    expect(clientSecretIn(await search(path.join(dir, 'bin')))).toBeNull();
    expect(clientSecretIn('')).toBeNull();
  });
});

describe('a login Gemini’s CLI saved on signing in', () => {
  let home: string;
  let login: typeof import('../../server/gemini-login.ts');
  const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  // What the CLI saves, with a client of its own that's made up.
  const saved = (fields: object = {}) => JSON.stringify({
    access_token: 'ya29.from-the-cli', refresh_token: '1//from-the-cli', scope: 'https://www.googleapis.com/auth/cloud-platform', token_type: 'Bearer',
    id_token: idToken({ email: 'someone@example.com', aud: 'made-up-client.apps.googleusercontent.com' }), expiry_date: Date.now() + 3599e3, ...fields,
  });
  const answer = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const loginFile = () => path.join(home, 'helper-credentials', 'gemini', 'login.json');

  beforeEach(async () => {
    vi.resetModules();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-gemini-adopt-')));
    vi.stubEnv('LONCA_HOME', home);
    login = await import('../../server/gemini-login.ts');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const LINK_CLIENT = 'made-up-client-from-the-link.apps.googleusercontent.com';
  const adopt = (content: string, fields: Partial<import('../../server/gemini-login.ts').GeminiAdoption> = {}) => login.adoptGeminiLogin(content, {
    profileId: 'gemini', clientSecret: async () => 'made-up-client-secret', current: () => true, ...fields,
  });
  const bodyOf = (fetch: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries(new URLSearchParams(String((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body)));
  const proxyHas = (name: string) => fs.existsSync(path.join(home, 'boundary', name)) ? fs.readFileSync(path.join(home, 'boundary', name), 'utf8') : undefined;
  const boundaryValue = () => proxyHas('gemini') ?? proxyHas('gemini.key');

  it('is kept with the client it came from, once Google has renewed it with that client', async () => {
    const fetch = vi.fn(async () => answer(200, { access_token: 'ya29.renewed-at-once', expires_in: 3599 }));
    vi.stubGlobal('fetch', fetch);
    expect(await adopt(saved())).toBe(true);
    expect(bodyOf(fetch)).toEqual({ grant_type: 'refresh_token', refresh_token: '1//from-the-cli', client_id: 'made-up-client.apps.googleusercontent.com', client_secret: 'made-up-client-secret' });
    expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8'))).toMatchObject({
      kind: 'google', access_token: 'ya29.renewed-at-once', refresh_token: '1//from-the-cli',
      client_id: 'made-up-client.apps.googleusercontent.com', client_secret: 'made-up-client-secret',
    });
    expect(fs.statSync(loginFile()).mode & 0o777).toBe(0o600);
    expect(boundaryValue()).toBe('ya29.renewed-at-once');
  });

  it('takes the client from the link the CLI printed, and needs no ID token, which Google may not send', async () => {
    const fetch = vi.fn(async () => answer(200, { access_token: 'ya29.renewed-at-once', expires_in: 3599 }));
    vi.stubGlobal('fetch', fetch);
    expect(await adopt(saved(), { clientId: LINK_CLIENT })).toBe(true);
    expect(bodyOf(fetch).client_id).toBe(LINK_CLIENT);
    expect(await adopt(saved({ id_token: undefined }), { clientId: LINK_CLIENT })).toBe(true);
    expect(bodyOf(fetch, 1).client_id).toBe(LINK_CLIENT);
    const kept = login.readGeminiLogin('gemini');
    expect(kept).toMatchObject({ kind: 'google', client_id: LINK_CLIENT, id_token: undefined });
    expect(login.describeGeminiSignIn(kept)).toEqual({ summary: 'Signed in with Google', usesKey: false });
  });

  it('keeps that its account’s turns need a Google Cloud project, through renewals, to say so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { access_token: 'ya29.renewed', expires_in: 3599 })));
    expect(await adopt(saved(), { needsProject: true })).toBe(true);
    expect(JSON.parse(fs.readFileSync(loginFile(), 'utf8')).needs_project).toBe(true);
    expect(login.describeGeminiSignIn(login.readGeminiLogin('gemini'))).toMatchObject({ summary: 'Signed in with Google as someone@example.com', needsProject: true });
    const kept = JSON.parse(fs.readFileSync(loginFile(), 'utf8'));
    fs.writeFileSync(loginFile(), JSON.stringify({ ...kept, expiry_date: Date.now() - 1000 }));
    expect(await login.renewGeminiLogin('gemini')).toBe('renewed');
    expect(login.readGeminiLogin('gemini')).toMatchObject({ access_token: 'ya29.renewed', needs_project: true });
    // Signing in to another account is another login.
    expect(await adopt(saved({ refresh_token: '1//another' }))).toBe(true);
    expect(login.describeGeminiSignIn(login.readGeminiLogin('gemini')).needsProject).toBeUndefined();
  });

  it('isn’t a login without an access token, which needs no client', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const clientSecret = vi.fn(async () => 'made-up-client-secret');
    for (const partial of ['', 'not json', 'null', '[]', saved({ access_token: '' })]) {
      expect(await adopt(partial, { clientSecret })).toBe(false);
    }
    expect(clientSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(loginFile())).toBe(false);
  });

  it('isn’t kept without a refresh token, saying Google gave no way to renew it', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(adopt(saved({ refresh_token: undefined }))).rejects.toThrow(/Google didn’t give Lonca a way to renew this sign-in/);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(loginFile())).toBe(false);
  });

  it('isn’t kept when it couldn’t be renewed, saying why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' })));
    await expect(adopt(saved())).rejects.toThrow(/Google wouldn’t renew the sign-in \(invalid_client\)/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(adopt(saved())).rejects.toThrow(/couldn’t reach Google/);
    await expect(adopt(saved(), { clientSecret: async () => null })).rejects.toThrow(/which client/);
    await expect(adopt(saved({ id_token: undefined }))).rejects.toThrow(/which client/);
    expect(fs.existsSync(loginFile())).toBe(false);
    expect(boundaryValue()).toBeUndefined();
  });

  describe('when the sign-in ends or changes while Google renews it', () => {
    let respond: (response: Response) => void;
    let current: boolean;
    /** Starts adopting, and waits for it to be asking Google. In an object, as awaiting the promise would wait for all of it. */
    async function adopting(): Promise<{ adoption: Promise<boolean> }> {
      current = true;
      const fetch = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
      vi.stubGlobal('fetch', fetch);
      const adoption = adopt(saved(), { current: () => current });
      for (let tries = 0; fetch.mock.calls.length === 0; tries += 1) {
        if (tries > 200) throw new Error('never asked Google');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { adoption };
    }
    const renewed = () => respond(answer(200, { access_token: 'ya29.renewed-late', expires_in: 3599 }));

    it('keeps nothing after it was cancelled and the sign-in signed out', async () => {
      login.saveGeminiApiKey(`AIza${'old'.padEnd(35, 'x')}`, 'gemini');
      const { adoption } = await adopting();
      current = false;
      login.signOutGemini('gemini');
      renewed();
      expect(await adoption).toBe(false);
      expect(fs.existsSync(loginFile())).toBe(false);
      expect(boundaryValue()).toBeUndefined();
    });

    it('keeps a key saved meanwhile, which ends the sign-in, or which changed it without ending it', async () => {
      const key = `AIza${'saved-meanwhile'.padEnd(35, 'x')}`;
      let { adoption } = await adopting();
      current = false;
      login.saveGeminiApiKey(key, 'gemini');
      renewed();
      expect(await adoption).toBe(false);
      expect(login.readGeminiLogin('gemini')).toEqual({ kind: 'key', apiKey: key });
      expect(boundaryValue()).toBe(key);

      login.signOutGemini('gemini');
      ({ adoption } = await adopting());
      login.saveGeminiApiKey(key, 'gemini');
      renewed();
      await expect(adoption).rejects.toThrow(/changed while Lonca was finishing/);
      expect(login.readGeminiLogin('gemini')).toEqual({ kind: 'key', apiKey: key });
      expect(boundaryValue()).toBe(key);
    });

    it('leaves nothing of a sign-in removed meanwhile', async () => {
      const { adoption } = await adopting();
      current = false;
      login.forgetGeminiLogin('gemini');
      renewed();
      expect(await adoption).toBe(false);
      expect(fs.existsSync(path.dirname(loginFile()))).toBe(false);
      expect(boundaryValue()).toBeUndefined();
    });

    it('is kept over a renewal of the login it replaces, which is the same login', async () => {
      const fetch = vi.fn(async () => answer(200, { access_token: 'ya29.renewed', expires_in: 3599 }));
      vi.stubGlobal('fetch', fetch);
      expect(await adopt(saved({ refresh_token: '1//first' }))).toBe(true);
      const { adoption } = await adopting();
      // The hourly renewal of the first login saving as this one finishes.
      const first = login.readGeminiLogin('gemini') as import('../../server/gemini-login.ts').GoogleLogin;
      fs.writeFileSync(loginFile(), JSON.stringify({ ...first, access_token: 'ya29.first-renewed' }));
      renewed();
      expect(await adoption).toBe(true);
      expect(login.readGeminiLogin('gemini')).toMatchObject({ refresh_token: '1//from-the-cli', access_token: 'ya29.renewed-late' });
    });
  });
});

it('shows the CLI is pinned in the template', () => {
  const build = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'template', 'build.sh'), 'utf8');
  expect(build).toMatch(/@google\/gemini-cli@\d+\.\d+\.\d+\b/);
  expect(execFileSync('bash', ['-n', path.resolve(import.meta.dirname, '..', '..', 'template', 'build.sh')]).toString()).toBe('');
});
