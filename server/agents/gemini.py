"""Run inside the workspace for Gemini's CLI, sent with each turn like process.py.

`setup` writes a conversation's home for the CLI from what's on stdin, before each turn: its
settings, its instructions, and links to the conversation and the files it names, which are kept
where they outlive the VM, as are copies of the turn's attachments. It also makes sure of the
settings that come before a checkout's own, which boot writes, and says so on stdout if it can't.

`run <command...>` is what lonca-run starts. Without a terminal, the CLI waits out a usage limit
for as long as the service says, which can be most of a day, and then tries again, up to ten
times. So this starts it, leaves its output to go straight to out.jsonl, and reads what it says on
stderr, passing that on. When it says it's going to wait longer than a turn should, this stops it,
ends what it left running, and adds a line to its output saying so, which Lonca reports as the
usage limit. A CLI that fails
before its turn begins, such as when its sign-in is refused, only says why on stderr, so when it
exits with an error this adds the end of that too. However the turn ends, this then puts back the
links setup made in the home, which something in the turn may have put a file in place of.
"""
import ctypes
import datetime
import json
import os
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time

# Waits longer than this are for a usage limit. Shorter ones, for a rate limit, are the CLI's to sit out.
LONGEST_WAIT = float(os.environ.get("LONCA_GEMINI_LONGEST_WAIT_SECONDS", "120"))
# How long the CLI has to stop once asked, before it's killed.
GRACE_SECONDS = float(os.environ.get("LONCA_GEMINI_GRACE_SECONDS", "5"))
# How long, at a usage limit, this goes on ending what the CLI left running, which can start more,
# and of that, how long they're asked to stop before they're killed.
CLEANUP_SECONDS = float(os.environ.get("LONCA_GEMINI_CLEANUP_SECONDS", "5"))
ASK_SECONDS = 0.5
# From linux/prctl.h.
PR_SET_CHILD_SUBREAPER = 36
# The CLI's message can run over several lines, and an attempt that isn't retried has none of its own.
RETRY = re.compile(rb"Attempt \d+ failed: ((?:(?!Attempt \d+ failed)[\s\S])*?)\. Retrying after (\d+)ms\.\.\.")
KEPT = 64 * 1024
MESSAGE_LIMIT = 2000
STDERR_LIMIT = 4000
# What `run` exits with when it stopped the CLI at a usage limit.
LIMITED = 75
# What `setup` exits with when the template this VM was made from has no Gemini.
MISSING = 3
# Where `setup` notes the links it made in the home, for `run` to put back.
LINKS = "lonca-links.json"
# Settings only come before a checkout's own when root owns them and where they are.
SYSTEM_SETTINGS = os.environ.get("LONCA_GEMINI_SYSTEM_SETTINGS", "/etc/gemini-cli/settings.json")
# As boot writes them.
PROTECT = r"""
dir=$(dirname "$0")
tmp="$dir/.$(basename "$0").tmp"
sudo -n install -d -o root -g root -m 755 "$dir" &&
  printf '%s\n' "$1" | sudo -n tee "$tmp" >/dev/null &&
  sudo -n chmod 644 "$tmp" &&
  sudo -n mv -f "$tmp" "$0"
"""


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as stream:
        stream.write(content)
    os.replace(temporary, path)


def link(path, target):
    """Points `path` at `target`, keeping anything the CLI put there before it was a link."""
    os.makedirs(target, exist_ok=True)
    if os.path.islink(path):
        if os.readlink(path) == target:
            return
        os.unlink(path)
    elif os.path.isdir(path):
        for name in os.listdir(path):
            if not os.path.lexists(os.path.join(target, name)):
                shutil.move(os.path.join(path, name), os.path.join(target, name))
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.unlink(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.symlink(target, path)


def link_file(path, target):
    """Points `path` at the file `target`, which may not be there yet. A file written in place of
    the link, as `sed -i` does, is newer than what's kept, so it's kept instead."""
    os.makedirs(os.path.dirname(target), exist_ok=True)
    if os.path.islink(path):
        if os.readlink(path) == target:
            return
        os.unlink(path)
    elif os.path.lexists(path):
        shutil.move(path, target)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.symlink(target, path)


def keep(home, kept):
    """Links what the home keeps to where it outlives the VM, in the order it's given."""
    for name, target in kept["links"].items():
        link(os.path.join(home, name), target)
    for name, target in kept["fileLinks"].items():
        link_file(os.path.join(home, name), target)


def keep_again():
    """Puts back the links setup made in the CLI's home. Something in the turn may have put a file
    in place of one, as `sed -i` does, which until then is only in the VM, and a rebuild or an
    archive can replace that before the next turn. Best effort, as how the turn ended matters
    more."""
    try:
        home = os.environ["GEMINI_CLI_HOME"]
        with open(os.path.join(home, LINKS), encoding="utf-8") as stream:
            kept = json.load(stream)
        keep(home, kept)
    except Exception:
        pass


def trusted(path, directory):
    """Whether the CLI trusts this place on the way to its settings: root's, and nobody else's to
    change, through a link too, which root has to own as well."""
    try:
        target = os.stat(path)
        link = os.lstat(path)
    except OSError:
        return False
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(target.st_mode) or (stat.S_ISLNK(link.st_mode) and link.st_uid != 0):
        return False
    return target.st_uid == 0 and not target.st_mode & 0o022


def above(path):
    """Every directory a path is in, up to the root."""
    found = []
    current = os.path.dirname(path)
    while True:
        found.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            return found
        current = parent


def protected(expected):
    """Whether the settings that come before a checkout's own are these, where the CLI trusts them:
    the file and every directory above it, and where any links lead, as the CLI checks."""
    path = os.path.abspath(SYSTEM_SETTINGS)
    try:
        real = os.path.realpath(path)
        with open(path, encoding="utf-8") as stream:
            content = stream.read()
    except (OSError, ValueError):
        return False
    places = [(place, True) for place in above(path)] + [(path, False)]
    if real != path:
        places += [(real, False)] + [(place, True) for place in above(real)]
    return all(trusted(place, directory) for place, directory in places) and content.rstrip("\n") == expected


def setup():
    spec = json.load(sys.stdin)
    if not shutil.which("gemini"):
        sys.exit(MISSING)
    expected = spec.get("system")
    if expected is not None and not protected(expected):
        # Boot does this too, but it may have failed, or the VM's been changed since.
        subprocess.run(["bash", "-c", PROTECT, SYSTEM_SETTINGS, expected], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not protected(expected):
            print(json.dumps({"unprotected": SYSTEM_SETTINGS}), flush=True)
    home = spec["home"]
    kept = {"links": spec["links"], "fileLinks": spec["fileLinks"]}
    # Before anything's written in them, and noted for when the turn ends.
    keep(home, kept)
    write(os.path.join(home, LINKS), json.dumps(kept))
    for name, content in spec["files"].items():
        write(os.path.join(home, name), content)
    # The CLI won't start without the directory it's told it can read, even on a turn without any.
    os.makedirs(spec["attachments"], exist_ok=True)
    for attachment in spec["copies"]:
        copy = os.path.join(spec["attachments"], attachment["to"])
        os.makedirs(os.path.dirname(copy), exist_ok=True)
        try:
            shutil.copyfile(attachment["from"], copy)
        except OSError as error:
            print(f"Could not copy an attachment: {error}", file=sys.stderr)


def line(**event):
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # The CLI may have stopped partway through a line of its own.
    return ("\n" + json.dumps({**event, "timestamp": timestamp}) + "\n").encode()


def adopt_orphans():
    """Has what the CLI leaves running come here, rather than to init, when what started it ends,
    so that it's still found under this at a usage limit."""
    try:
        ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass


def processes():
    """Every process now, with its parent and its state."""
    found = {}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return found
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "rb") as stream:
                fields = stream.read().rsplit(b") ", 1)[1].split()
            found[int(entry)] = (int(fields[1]), fields[0])
        except (OSError, IndexError, ValueError):
            continue
    return found


def running_under(pid):
    """The processes under pid that are still running, found by their parents."""
    table = processes()
    children = {}
    for child, (parent, _) in table.items():
        children.setdefault(parent, []).append(child)
    found = []
    waiting = [pid]
    while waiting:
        for child in children.get(waiting.pop(), []):
            waiting.append(child)
            if table[child][1] not in (b"Z", b"X"):
                found.append(child)
    return found


def reap():
    """Collects what was left here and has ended. Only once the CLI's own end is known, which this
    could otherwise take from it."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except OSError:
            return
        if pid == 0:
            return


def kill_as_root(pid, deadline):
    """Kills a process with sudo, giving it no longer than there's left. Not with subprocess.run,
    which goes on waiting for a sudo it couldn't stop."""
    left = deadline - time.monotonic()
    if left <= 0:
        return
    try:
        helper = subprocess.Popen(["sudo", "-n", "kill", "-KILL", str(pid)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        return
    try:
        helper.wait(timeout=left)
    except subprocess.TimeoutExpired:
        try:
            helper.kill()
        except OSError:
            pass


def signal_left(number, refused, deadline):
    """Signals everything under this, until the deadline. What it may not signal, such as what was
    started with sudo, sudo kills, once each, in the time there's left."""
    for pid in running_under(os.getpid()):
        if time.monotonic() >= deadline:
            return
        try:
            os.kill(pid, number)
        except PermissionError:
            if pid not in refused:
                refused.add(pid)
                kill_as_root(pid, deadline)
        except OSError:
            pass


def clean_up():
    """Ends what the CLI left running at a usage limit, such as MCP servers that ignored its
    stopping and what they started, some of which may start more as this goes. Asks first, then
    kills, until nothing's left or its time is up."""
    began = time.monotonic()
    deadline = began + CLEANUP_SECONDS
    refused = set()
    while True:
        reap()
        now = time.monotonic()
        if now >= deadline or not running_under(os.getpid()):
            return
        signal_left(signal.SIGTERM if now - began < ASK_SECONDS else signal.SIGKILL, refused, deadline)
        time.sleep(max(0.0, min(0.05, deadline - time.monotonic())))


def kill(child):
    """Kills the CLI, as asking didn't stop it. Not by its process group, which is lonca-run's
    shell's too. What it started comes here once it's gone, for clean_up."""
    try:
        child.kill()
    except OSError:
        pass


def stop(number, frame):
    # The CLI is in this process group, so it has the signal too. This keeps reading what it says
    # until it's gone, so that lonca-run can't report the run over while it's still writing.
    pass


def drain(stream, take):
    """Takes what's already been written to stream, without waiting for more."""
    os.set_blocking(stream, False)
    taken = 0
    while taken < KEPT * 16:
        try:
            data = os.read(stream, 65536)
        except OSError:
            return
        if not data:
            return
        taken += len(data)
        take(data)


def run(command):
    # Whichever way the turn ends: `turn` exits with its code, or fails with an error of its own.
    try:
        turn(command)
    finally:
        keep_again()


def turn(command):
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, stop)
    adopt_orphans()
    child = subprocess.Popen(command, stderr=subprocess.PIPE)
    stream = child.stderr.fileno()
    said = b""
    tail = b""
    limit = None
    kill_at = None

    def take(data):
        nonlocal said, tail, limit, kill_at
        os.write(2, data)
        tail = (tail + data)[-STDERR_LIMIT:]
        if limit is not None:
            return
        said = (said + data)[-KEPT:]
        end = 0
        for match in RETRY.finditer(said):
            end = match.end()
            wait_ms = int(match.group(2))
            if wait_ms > LONGEST_WAIT * 1000:
                limit = (match.group(1).decode("utf-8", errors="replace").strip(), wait_ms)
                try:
                    child.terminate()
                except OSError:
                    pass
                kill_at = time.monotonic() + GRACE_SECONDS
                break
        # Only what comes after the last whole message can still be part of one.
        said = said[end:]

    while True:
        ready, _, _ = select.select([stream], [], [], 0.5)
        if ready:
            data = os.read(stream, 65536)
            if not data:
                break
            take(data)
        if child.poll() is not None:
            # What it said before it went is all there is to read. Something it started can keep
            # its stderr open after it's gone, and go on writing, which mustn't hold up the end.
            drain(stream, take)
            break
        if kill_at is not None and time.monotonic() > kill_at and child.poll() is None:
            kill(child)
            kill_at = None
    # It can close stderr and carry on, and the time it was given to stop still counts then.
    while True:
        try:
            code = child.wait(None if kill_at is None else max(0.0, kill_at - time.monotonic()))
            break
        except subprocess.TimeoutExpired:
            kill(child)
            kill_at = None
    code = 128 - code if code < 0 else code
    if limit:
        # It may stop when asked and leave behind what ignored its stopping. That's ended as far as
        # it can be, and nothing about it keeps the limit from being reported. A turn that ended by
        # itself leaves alone what it left running.
        try:
            clean_up()
        except Exception:
            pass
        message, wait_ms = limit
        os.write(1, line(type="lonca_limit", message=message[:MESSAGE_LIMIT], wait_ms=wait_ms))
        sys.exit(LIMITED)
    if code != 0:
        # A line cut short at the start says nothing.
        if len(tail) == STDERR_LIMIT and b"\n" in tail:
            tail = tail[tail.index(b"\n") + 1:]
        os.write(1, line(type="lonca_exit", code=code, stderr=tail.decode("utf-8", errors="replace")))
    sys.exit(code)


def main():
    action, *args = sys.argv[1:]
    if action == "setup":
        setup()
    elif action == "run":
        run(args)
    else:
        raise ValueError("unknown Gemini operation")


main()
