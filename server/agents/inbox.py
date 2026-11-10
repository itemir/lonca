"""Run inside the workspace, as the command lonca-run starts for a CLI that can read messages
while it works.

It starts the CLI with a pipe for its input, sends it the run's first message, which lonca-run
gives this on stdin, and then each message the server puts in <dir>/inbox, in name order. The CLI
writes its own output to out.jsonl, as it would without this, so none of it passes through here.
Lonca knows a message reached the CLI when the CLI echoes it there, not from anything this does.

Input is closed once the CLI has nothing left to answer, which is what lets it exit. From then on
nothing more is passed on, and the inbox is renamed, so the server knows to keep what it sends
for the next turn.
"""
import json
import os
import signal
import stat
import subprocess
import sys
import time

POLL_SECONDS = 0.2
# A CLI that hasn't taken up what it was sent after its last result, and says nothing more, is
# given its input's end anyway, so that it can't wait for more forever.
QUIET_SECONDS = float(os.environ.get("LONCA_INBOX_QUIET_SECONDS", "60"))
READ_LIMIT = 1024 * 1024
LINE_LIMIT = 8 * 1024 * 1024
# Only these lines matter here, so others aren't parsed.
TOKENS = (b"isReplay", b'"result"', b"session_state_changed")


class Output:
    """Reads the CLI's output file as it grows."""

    def __init__(self, path):
        self.stream = open(path, "rb")
        self.partial = b""
        self.skipping = False
        self.changed = time.monotonic()

    def events(self):
        data = self.stream.read(READ_LIMIT)
        if not data:
            return []
        self.changed = time.monotonic()
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()
        if len(self.partial) > LINE_LIMIT:
            self.partial = b""
            self.skipping = True
        events = []
        for line in lines:
            if self.skipping:
                self.skipping = False
                continue
            if not any(token in line for token in TOKENS):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                events.append(event)
        return events


def read_file(path):
    # Anything in the VM can put a FIFO or a device here, which mustn't block or flood this.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular file")
        return os.read(fd, LINE_LIMIT)
    finally:
        os.close(fd)


def message(text, uuid):
    return (json.dumps({"type": "user", "message": {"role": "user", "content": text}, "uuid": uuid}) + "\n").encode()


class Feed:
    def __init__(self, directory, first, child):
        self.inbox = f"{directory}/inbox"
        self.first = first
        self.child = child
        self.capable = False
        self.results = 0
        # Sent something after its last result, which it hasn't taken up yet.
        self.waiting = False
        self.closed = False
        self.seen = set()
        self.forwarded = set()
        self.replayed = set()

    def send(self, data):
        try:
            self.child.stdin.write(data)
            self.child.stdin.flush()
            return True
        except (BrokenPipeError, OSError, ValueError):
            self.close()
            return False

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.child.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            os.rename(self.inbox, f"{self.inbox}.closed")
        except OSError:
            pass

    def notice(self, event):
        kind = event.get("type")
        if kind == "user" and event.get("isReplay") and isinstance(event.get("uuid"), str):
            self.replayed.add(event["uuid"])
            self.waiting = False
            # Until it echoes the first message, there's no telling that it would echo others.
            if event["uuid"] == self.first:
                self.capable = True
        elif kind == "result":
            self.results += 1
            # Anything sent but not yet echoed starts another turn of the same process.
            if not self.capable or self.forwarded <= self.replayed:
                self.close()
            else:
                self.waiting = True
        elif kind == "system" and event.get("subtype") == "session_state_changed" and event.get("state") == "idle" and self.results:
            self.close()

    def forward(self):
        try:
            names = sorted(name for name in os.listdir(self.inbox) if not name.startswith(".") and name not in self.seen)
        except OSError:
            return
        for name in names:
            self.seen.add(name)
            try:
                entry = json.loads(read_file(f"{self.inbox}/{name}"))
                uuid, text = entry["uuid"], entry["text"]
            except (OSError, ValueError, KeyError, TypeError):
                continue
            if not isinstance(uuid, str) or not isinstance(text, str) or uuid == self.first or uuid in self.forwarded:
                continue
            if not self.send(message(text, uuid)):
                return
            self.forwarded.add(uuid)


stopping = False


def stop(number, frame):
    # The CLI is in this process group, so it has the signal too. This only stops passing messages
    # on, and keeps waiting for the CLI, so that lonca-run can't report the run over while the CLI
    # is still writing its last output.
    global stopping
    stopping = True


def main():
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, stop)
    directory, first, *command = sys.argv[1:]
    text = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    child = subprocess.Popen(command, stdin=subprocess.PIPE)
    feed = Feed(directory, first, child)
    try:
        output = Output(f"{directory}/out.jsonl")
        feed.send(message(text, first))
        while child.poll() is None:
            for event in output.events():
                feed.notice(event)
            if stopping:
                feed.close()
            elif feed.waiting and time.monotonic() - output.changed > QUIET_SECONDS:
                feed.close()
            if not feed.closed and feed.capable:
                feed.forward()
            time.sleep(POLL_SECONDS)
    except Exception as error:
        # Whatever went wrong here, the CLI still has to be waited for.
        print(f"lonca inbox: {error!r}", file=sys.stderr, flush=True)
        feed.close()
    feed.close()
    code = child.wait()
    sys.exit(128 - code if code < 0 else code)


main()
