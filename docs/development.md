# Development

```sh
npm run dev         # server with reloads, plus Vite on http://localhost:5173
npm run typecheck
npm test            # unit tests
npm run test:docker # integration tests, with Docker containers standing in for virtual machines
npm run test:e2e    # the whole app in a browser (first: npx playwright install chromium)
npm run test:sandbox # the integration tests again, in real virtual machines (needs Docker Sandboxes, signed in)
```

The Docker and browser suites run the real `claude` and `codex` CLIs. They need Docker, which Lonca itself doesn't, because `tests/support/fake-sbx` stands in for `sbx` with plain containers. What's replaced is the models behind them, by a scripted server in `tests/support/mock-llm.ts`, for the sign-in tests the services that sign in, by `tests/support/fake-signin.mjs`, and for the pull request tests `gh`, by `tests/support/fake-gh`, so the suites need no credentials, spend no tokens and never change anything on GitHub. They use their own throwaway home directories and sandboxes and clean up after themselves, so they're safe to run alongside a real instance.

Tests keep a template of their own, `lonca-instance-sandbox`, as any instance with `LONCA_INSTANCE` set does, so a run can't touch the one your server uses. That exercises everything of Lonca's on the way to a virtual machine, without a Docker account, but it can't stand in for the VM itself, its proxy, its network rules or its file sharing. Only `test:sandbox` covers those.

| Directory | Contents |
| --- | --- |
| `server/` | HTTP and WebSocket API, workspace lifecycle, agent runs, and the ports a Lead forwards (`ports.ts`). Runs directly with Node's TypeScript support. |
| `server/agents/` | One adapter per CLI: the command to run and a parser for its JSONL output. Also the Lead: its tools (`team.ts`, `lonca-tools.py`) and the playbook template (`lead-template.md`). |
| `web/` | The React app. |
| `shared/` | Types used by both. |
| `template/` | What the workspace template is made from: the script that builds it and the files it installs. |
| `scripts/` | What `npm start` and `npm run dev` run, and in `demo/`, what records the README's GIF. |

An agent runs detached inside its workspace, writing its output to a file the server follows. That's why a turn survives the server restarting: the new server finds the run and reads its output again from the start. A Lead's tools work the same way, with no network path to the server: an MCP server inside the workspace appends each call to a file the server is following, and waits for the server to write the reply. A message to a Claude agent that's working goes the other way: the server writes it into its turn's inbox, a small script started with the CLI (`inbox.py`) passes it on, and the CLI echoes it in its output when it reads it, which is how the server knows.

Recovery tests cover operations and their failure boundaries together:

| Cases | Coverage |
| --- | --- |
| Interrupted create, restore, start, stop, rebuild, archive, delete; failure to save intent; setup launch failure; duplicate deletion | `tests/unit/workspace-recovery.test.ts` |
| Partial create/restore file copies; archive/delete/stop failures before cleanup; deleting an archived workspace with Docker Sandboxes unreachable | `tests/docker/operation-recovery.test.ts` |
| Rebuild retries and interrupted rebuilds; concurrent wake requests; queued work; agents reconnecting before Stop; session and project removal | `tests/docker/recovery.test.ts` |
| Surviving setup scripts and shells, including job groups whose shell exited; concurrent script restart/Stop; a 70-second outage of Docker Sandboxes; Stop surviving a server crash; failed state writes before direct/queued agent launches | `tests/docker/process-recovery.test.ts` |
| Failed Stop persistence during agent recovery and uncertain startup; shutdown grace, held queues, and lifecycle retries after writes recover | `tests/docker/agent-persistence.test.ts` |
| Completed and recovered transcripts across immediate crashes; failed transcript/state writes; durable message acceptance, queue changes, and lost-conversation retries; queued work and running agents through unreadable transcripts; shutdown with unwritable storage | `tests/docker/transcript-persistence.test.ts` |
| Failed launch acknowledgments and output reads; missing or inconsistent completion receipts; partial records; queued work during replay; missing or damaged raw output; runtime restarts, and recovery before rebuild/archive | `tests/docker/agent-output.test.ts` |
| Deletion with unread output and occupied ports, project deletion and crash retries, unreachable runtimes, history preservation during archive/rebuild, stopped shells and scripts | `tests/docker/runtime-stop.test.ts` |
| Passive access after external stops or runtime removal; explicit starts and messages; queued messages after a failed wake; browser polling and automatic terminals | `tests/docker/runtime-access.test.ts`, `tests/e2e/runtime-stop.spec.ts` |
| Pending terminal resizes while a sandbox is stopped, missing or unreachable; resizing after recovery; stale resizes after terminal exit | `tests/unit/sandbox-terminal.test.ts` |
| Terminal recovery during runtime shutdown, preserved script exit codes, and scans limited to workspaces present at server startup | `tests/unit/terminal-recovery.test.ts` |
| Partial transcript appends, interrupted queue promotion, retained writes and automatic retries, flushing multiple conversations, deletion with pending writes | `tests/unit/transcript-persistence.test.ts` |
| Messages read while an agent works: their order, one sent as a turn ends, Stop before one is read, a restart or a failed save as one is read, Cancel while a restart is still recovering, one whose file may not have been written, something other than a file in the inbox, and the Lead's messages to a working agent | `tests/unit/inbox.test.ts`, `tests/docker/mid-turn.test.ts`, `tests/e2e/composer.spec.ts` |
| Recovered script controls, and when the Setup tab appears, in the browser | `tests/e2e/setup.spec.ts` |
| Moving a terminal to its own window and back, through reloads, exits and a blocked pop-up, in the browser | `tests/e2e/terminal-window.spec.ts` |
| A conversation that can't be read on opening or after a reconnect, and recovering from it, in the browser | `tests/e2e/hydration.spec.ts` |
| Archiving out of a failed operation, restoring from it, and deleting after a failed archive or delete, in the browser | `tests/e2e/workspace-close.spec.ts` |
| A Lead's tool calls made while the server was down or repeated after a crash, agents that finish while it's down, usage limits, stopped agents and Leads, closing a Lead with agents running | `tests/docker/lead.test.ts`, `tests/e2e/lead.spec.ts` |
| Forwarded ports: choosing and refusing ports on `localhost`, what's listening, forward and close calls repeated after a crash, closing forwards before a stop even when `sbx` fails, and what a stop outside Lonca leaves for the next start, including a port taken since | `tests/unit/ports.test.ts`, `tests/docker/ports.test.ts` |
| Signing Docker Sandboxes in and out: reading what `sbx login` prints, cancelling, time limits, the warning before signing out, and workspaces stopped by it | `tests/unit/docker-login.test.ts`, `tests/e2e/docker-signin.spec.ts`, `tests/docker/lonca.test.ts` |
| Credentials staying out of every process and file in a workspace; what the proxy is told, per sandbox; renewing Codex's sign-in; moving the login from where older workspaces can see it | `tests/docker/boundary.test.ts`, `tests/unit/boundary.test.ts` |
| Several sign-ins: each one's placeholder, file and environment, one added while workspaces run, which one a turn runs on, moving a conversation by hand and by itself at a limit, Stop and failed saves around that, removing two at once, and what a Lead may choose | `tests/unit/profiles.test.ts`, `tests/unit/sandbox-runtime.test.ts`, `tests/docker/boundary.test.ts`, `tests/e2e/profiles.spec.ts` |
| A pull request's state, its last known state while the workspace is stopped or GitHub can't be reached, reads that overlap or meet a Stop, changes a checkout's config would hide, and pull requests left by an earlier workspace of the same name; merging, with a stale head, a changed base, two at once, Stop waiting for it, a stopped workspace and every outcome; the merge dialog, focus, Archive with and without asking, reading only while the page is visible, narrow panels and phones, in the browser | `tests/unit/pr-status.test.ts`, `tests/unit/merge.test.ts`, `tests/unit/pr-reads.test.ts`, `tests/docker/pull-request.test.ts`, `tests/e2e/pull-request.spec.ts` |

The outage tests cut their own server off from the stand-in for `sbx`, leaving its sandboxes running. They need that stand-in, so they're skipped in `test:sandbox`.

## The README's GIF

`docs/demo.gif` is recorded from the real app: a throwaway Lonca on real virtual machines, running the real `claude` and `codex` CLIs. Only the model is scripted, by `scripts/demo/director.ts`, so recording spends no usage. It needs Docker Sandboxes, signed in, and Python for Pillow:

```sh
npm run build
LONCA_TEST_RUNTIME=sandbox node scripts/demo/record.ts
python3 -m venv dist/demo/venv && dist/demo/venv/bin/pip install pillow
dist/demo/venv/bin/python scripts/demo/make-gif.py
```

`record.ts` saves frames to `dist/demo`, which takes about three minutes once the test template is built, and removes the virtual machines it made. `make-gif.py` turns the frames into `docs/demo.gif`. The captions are in `make-gif.py`, so changing one only needs that last step.
