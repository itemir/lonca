import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

// inbox.py with a stand-in for Claude, which behaves as Claude Code 2.1.319 was measured to: it
// echoes each message when it reads it, takes messages sent during its work at the end of that
// work, answers one sent after its result with another turn, and exits once its input closes.
const DRIVER = path.resolve(import.meta.dirname, '..', '..', 'server', 'agents', 'inbox.py');
const CLI = String.raw`
import json, os, signal, sys, threading, time
echoes = os.environ.get("ECHOES") == "1"
work = float(os.environ.get("WORK", "0"))
final = float(os.environ.get("FINAL", "0"))
# Takes nothing up after its first result, and never says it's idle, as a CLI that lost a message might.
drop = os.environ.get("DROP") == "1"
queue, ended = [], threading.Event()
def read():
    for line in sys.stdin:
        queue.append(json.loads(line))
    ended.set()
threading.Thread(target=read, daemon=True).start()
def emit(event):
    print(json.dumps(event), flush=True)
def stop(*args):
    time.sleep(1)
    emit({"type": "late"})
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)
turn = 0
while True:
    while not queue and not ended.is_set():
        time.sleep(0.02)
    if not queue:
        break
    turn += 1
    emit({"type": "system", "subtype": "init", "session_id": "s"})
    first = queue.pop(0)
    if echoes:
        emit({"type": "user", "isReplay": True, "uuid": first["uuid"], "message": first["message"]})
    emit({"type": "assistant", "text": first["message"]["content"]})
    time.sleep(work)
    # Messages sent during its work are read once the work is done, like a tool's result.
    while queue:
        taken = queue.pop(0)
        if echoes:
            emit({"type": "user", "isReplay": True, "uuid": taken["uuid"], "message": taken["message"]})
        emit({"type": "assistant", "text": taken["message"]["content"]})
    # Ones sent while it writes its final reply wait for a turn of their own.
    time.sleep(final)
    emit({"type": "result", "subtype": "success", "turn": turn})
    if drop:
        ended.wait()
        sys.exit(0)
    time.sleep(0.3)
emit({"type": "system", "subtype": "session_state_changed", "state": "idle"})
`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-inbox-'));
  fs.mkdirSync(path.join(dir, 'inbox'));
  fs.writeFileSync(path.join(dir, 'cli.py'), CLI);
  fs.writeFileSync(path.join(dir, 'prompt'), 'FIRST');
});

// Each test's processes, which a failing one could leave waiting forever.
const groups: number[] = [];

afterEach(() => {
  for (const pid of groups.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(env: Record<string, string>) {
  const child = spawn('python3', ['-I', DRIVER, dir, 'first-uuid', 'python3', '-I', path.join(dir, 'cli.py')], {
    stdio: [fs.openSync(path.join(dir, 'prompt'), 'r'), fs.openSync(path.join(dir, 'out.jsonl'), 'a'), fs.openSync(path.join(dir, 'err.log'), 'a')],
    env: { ...process.env, ...env },
    detached: true,
  });
  groups.push(child.pid!);
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited };
}

function send(name: string, uuid: string, text: string): void {
  fs.writeFileSync(path.join(dir, 'inbox', `.${name}.tmp`), JSON.stringify({ uuid, text }));
  fs.renameSync(path.join(dir, 'inbox', `.${name}.tmp`), path.join(dir, 'inbox', name));
}

function output(): Record<string, unknown>[] {
  return fs.readFileSync(path.join(dir, 'out.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const said = () => output().filter((event) => event.type === 'assistant').map((event) => event.text);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('passes messages on in the order of their files, then closes its input once each has been read', async () => {
  const { exited } = start({ ECHOES: '1', WORK: '1.5' });
  await sleep(500);
  send('000000000002.json', 'b', 'SECOND');
  send('000000000003.json', 'c', 'THIRD');
  expect(await exited).toBe(0);
  expect(said()).toEqual(['FIRST', 'SECOND', 'THIRD']);
  expect(output().filter((event) => event.type === 'result')).toHaveLength(1);
  // So that the server knows to keep anything sent from now on for the next turn.
  expect(fs.existsSync(path.join(dir, 'inbox.closed'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'inbox'))).toBe(false);
});

it('waits for a message sent as a turn ends, which the CLI answers in a turn of its own', async () => {
  const { exited } = start({ ECHOES: '1', WORK: '0', FINAL: '1.5' });
  await sleep(500);
  send('000000000002.json', 'b', 'LATE');
  expect(await exited).toBe(0);
  expect(said()).toEqual(['FIRST', 'LATE']);
  expect(output().filter((event) => event.type === 'result')).toHaveLength(2);
});

it('skips anything in the inbox that isn\'t a plain file, rather than wait on it', async () => {
  const { exited } = start({ ECHOES: '1', WORK: '1.5' });
  await sleep(500);
  // Opening a pipe with nothing writing to it would wait forever, and the turn with it.
  execFileSync('mkfifo', [path.join(dir, 'inbox', '000000000002.json')]);
  send('000000000003.json', 'c', 'AFTER THE PIPE');
  expect(await exited).toBe(0);
  expect(said()).toEqual(['FIRST', 'AFTER THE PIPE']);
}, 20000);

it('passes nothing on to a CLI that doesn\'t echo its first message', async () => {
  send('000000000002.json', 'b', 'EARLY');
  const { exited } = start({ ECHOES: '0', WORK: '1' });
  await sleep(300);
  send('000000000003.json', 'c', 'DURING');
  expect(await exited).toBe(0);
  expect(said()).toEqual(['FIRST']);
});

it('closes its inbox once the CLI has answered everything, so that what the server sends next is refused', async () => {
  const { exited } = start({ ECHOES: '1', WORK: '0' });
  expect(await exited).toBe(0);
  expect(said()).toEqual(['FIRST']);
  // The server writes into the inbox, and a missing one tells it to keep the message for the next turn.
  expect(() => send('000000000002.json', 'b', 'TOO LATE')).toThrow(/ENOENT/);
});

it('keeps passing messages on to a later turn that works quietly for a while', async () => {
  const { exited } = start({ ECHOES: '1', WORK: '2.5', FINAL: '1', LONCA_INBOX_QUIET_SECONDS: '1' });
  await until(() => said().length === 1);
  await sleep(2800);
  // While its first turn writes its final reply, so it's answered in a second turn.
  send('000000000002.json', 'b', 'LATE');
  await until(() => said().length === 2);
  await sleep(1500);
  // During the second turn's quiet work, longer than the quiet limit.
  send('000000000003.json', 'c', 'DURING THE SECOND TURN');
  expect(await exited).toBe(0);
  expect(said()).toEqual(['FIRST', 'LATE', 'DURING THE SECOND TURN']);
  expect(output().filter((event) => event.type === 'result')).toHaveLength(2);
}, 30000);

it('gives the CLI the end of its input when it never takes up what it was sent after its result', async () => {
  const { exited } = start({ ECHOES: '1', WORK: '0', FINAL: '1', DROP: '1', LONCA_INBOX_QUIET_SECONDS: '1' });
  await sleep(400);
  send('000000000002.json', 'b', 'NEVER TAKEN');
  const started = Date.now();
  expect(await exited).toBe(0);
  expect(Date.now() - started).toBeLessThan(10000);
  expect(said()).toEqual(['FIRST']);
}, 30000);

it('outlives the CLI when stopped, so its last output is written before the run is over', async () => {
  const { child, exited } = start({ ECHOES: '1', WORK: '30' });
  await until(() => said().length === 1);
  process.kill(-child.pid!, 'SIGTERM');
  // lonca-run reports the run over as soon as inbox.py exits, so the CLI's last words must come first.
  expect(await exited).toBe(143);
  expect(output().at(-1)).toEqual({ type: 'late' });
  expect(fs.existsSync(path.join(dir, 'inbox.closed'))).toBe(true);
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await sleep(25);
  expect(check()).toBe(true);
}
