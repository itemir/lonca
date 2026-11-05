"""Run inside the workspace.

The detached lonca-run shell is the session leader. Its PID alone is not an
identity: VM disks outlive boots and Linux reuses PIDs within a boot too. Its
argv holds the unique run directory, so a process reusing that PID cannot qualify.
"""
import json
import os
import re
import signal
import stat
import sys
import time


def read_record(file, limit):
    # A damaged record must not block on a FIFO or read an unbounded device.
    fd = os.open(file, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular process record")
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise ValueError("oversized process record")
        return data
    finally:
        os.close(fd)


def owner(directory):
    try:
        pid = int(read_record(f"{directory}/pid", 16))
        if pid <= 1:
            return None
        fields = read_record(f"/proc/{pid}/stat", 8192).rsplit(b") ", 1)[1].split()
        # Fields 5 and 6 are the process group and session.
        if fields[0] in (b"Z", b"X") or int(fields[2]) != pid or int(fields[3]) != pid:
            return None
        # Only the prefix matters; agent arguments may exceed this bounded read.
        with open(f"/proc/{pid}/cmdline", "rb") as stream:
            args = stream.read(8192).split(b"\0")
        if (len(args) >= 5 and os.path.basename(args[0]) == b"bash"
                and args[1] == b"-c" and args[3:5] == [b"lonca-run", os.fsencode(directory)]):
            return pid
    except (FileNotFoundError, ProcessLookupError, ValueError):
        pass
    return None


def output_receipt(directory, **fields):
    try:
        code = int(read_record(f"{directory}/exit", 16).strip())
    except (FileNotFoundError, ValueError):
        code = None
    stderr = ""
    try:
        fd = os.open(f"{directory}/err.log", os.O_RDONLY | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if stat.S_ISREG(info.st_mode):
                os.lseek(fd, max(0, info.st_size - 2000), os.SEEK_SET)
                stderr = os.read(fd, 2000).decode("utf-8", errors="replace").strip()
        finally:
            os.close(fd)
    except FileNotFoundError:
        pass
    # Only this helper writes stderr. The agent's own stdout/stderr are files,
    # so JSON in its output cannot masquerade as confirmation of a complete read.
    sys.stdout.buffer.flush()
    print("\nLONCA_OUTPUT " + json.dumps({**fields, "code": code, "stderr": stderr}), file=sys.stderr, flush=True)


CALL_ID = re.compile(r"[a-f0-9]{32}")
CALL_LIMIT = 512 * 1024


class ToolCalls:
    """Hands on a Lead's tool calls. A call with a reply has been dealt with, and any
    other is handed on again after a reconnect, so the server needs no saved position."""

    def __init__(self, directory):
        self.directory = directory
        self.position = 0
        self.partial = b""

    def forward(self):
        try:
            fd = os.open(f"{self.directory}/calls.jsonl", os.O_RDONLY | os.O_NONBLOCK)
        except FileNotFoundError:
            return
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return
            os.lseek(fd, self.position, os.SEEK_SET)
            data = os.read(fd, CALL_LIMIT)
        finally:
            os.close(fd)
        self.position += len(data)
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()
        if len(self.partial) > CALL_LIMIT:
            self.partial = b""
        for line in lines:
            self.hand_on(line)

    def hand_on(self, line):
        try:
            call = json.loads(line)
            identifier = call["id"]
        except (ValueError, KeyError, TypeError):
            return
        if not isinstance(identifier, str) or not CALL_ID.fullmatch(identifier):
            return
        if not os.path.lexists(f"{self.directory}/replies/{identifier}.json"):
            # json.dumps keeps it to one line of ASCII, so it can't be split across a multibyte character.
            print("LONCA_CALL " + json.dumps(call), file=sys.stderr, flush=True)


def follow(directory, offset, calls=None):
    try:
        fd = os.open(f"{directory}/out.jsonl", os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError:
        if owner(directory) is None:
            output_receipt(directory, unavailable="The agent output file is missing.")
            return
        raise
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        output_receipt(directory, unavailable="The agent output is not a regular file.")
        return
    with os.fdopen(fd, "rb") as stream:
        if offset > os.fstat(stream.fileno()).st_size:
            output_receipt(directory, unavailable="The agent output file was truncated.")
            return
        stream.seek(offset)
        alive = True
        while True:
            # Revalidate throughout the stream, not only when attaching it. A
            # tail --pid would wait forever if that PID acquired another owner.
            alive = alive and owner(directory) is not None
            if calls:
                calls.forward()
            data = stream.read(64 * 1024)
            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            elif not alive:
                output_receipt(directory, end=stream.tell())
                return
            else:
                time.sleep(0.1)


def main():
    action, directory, *args = sys.argv[1:]
    if action == "follow":
        follow(directory, int(args[0]), ToolCalls(directory) if "calls" in args[1:] else None)
    elif action == "status":
        print("alive" if owner(directory) else "dead")
    elif action == "signal":
        pid = owner(directory)
        if pid:
            try:
                os.killpg(pid, {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL}[args[0]])
            except ProcessLookupError:
                pass
    else:
        raise ValueError("unknown agent process operation")


try:
    main()
except (OSError, ValueError) as error:
    print(f"Could not {sys.argv[1]} the agent process: {error}", file=sys.stderr)
    sys.exit(2)
