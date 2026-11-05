"""Run inside the workspace by the Lead's CLI, as its Lonca tools.

An MCP server on stdio, which passes each call on through files: it appends the call
to calls.jsonl, which the server is already following, and waits for the server to
write replies/<id>.json. So the Lead needs no network path to Lonca and holds no token.
"""
import json
import os
import sys
import threading
import time
import uuid

directory = sys.argv[1]
LIMIT = 512 * 1024
PATIENCE = 600
output = threading.Lock()


def send(message):
    with output:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def answer(request, text, failed=False):
    send({"jsonrpc": "2.0", "id": request, "result": {"content": [{"type": "text", "text": text}], "isError": failed}})


def wait_for_reply(path):
    deadline = time.time() + PATIENCE
    while time.time() < deadline:
        try:
            with open(path, encoding="utf-8") as stream:
                return json.load(stream)
        except FileNotFoundError:
            time.sleep(0.05)
    return None


def relay(request, name, arguments):
    call = uuid.uuid4().hex
    try:
        line = json.dumps({"id": call, "tool": name, "args": arguments}) + "\n"
        if len(line) > LIMIT:
            answer(request, "That's too long to send to an agent. Write it to a file in this checkout and refer to it.", True)
            return
        fd = os.open(f"{directory}/calls.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line.encode())
        finally:
            os.close(fd)
        reply = wait_for_reply(f"{directory}/replies/{call}.json")
    except (OSError, ValueError) as error:
        answer(request, f"Lonca couldn't take that request: {error}", True)
        return
    if reply is None:
        answer(request, "Lonca didn't answer in time, and may be restarting. Check team_status before trying this again.", True)
    else:
        answer(request, str(reply.get("text", "")), bool(reply.get("failed")))


def handle(message):
    method = message.get("method")
    request = message.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request, "result": {
            "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "lonca", "version": "1"},
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": request, "result": {"tools": json.loads(TOOLS)}})
    elif method == "tools/call":
        params = message.get("params", {})
        threading.Thread(target=relay, args=(request, params.get("name"), params.get("arguments") or {}), daemon=True).start()
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": request, "result": {}})
    elif request is not None:
        send({"jsonrpc": "2.0", "id": request, "error": {"code": -32601, "message": "Method not found"}})


for raw in sys.stdin:
    if raw.strip():
        handle(json.loads(raw))
