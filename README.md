# Lonca

Run coding agents side by side from your browser. Every workspace is a real git worktree on its own branch, running in its own virtual machine or Docker container, with Claude and Codex ready to work in it.

*Lonca* is Turkish for guild: a group of craftspeople working on separate pieces under one roof.

## Get started

You need macOS or Linux, [Node.js](https://nodejs.org) 22.18 or newer, git, and Docker: Docker Desktop on macOS, or Docker Engine on Linux.

```sh
npm install
npm start
```

Lonca opens in your browser. The first start builds the workspace image, which takes a few minutes. After that:

1. **Sign in to an agent.** The home page walks you through it (see [Signing in](#signing-in)).
2. **Add a project.** Give it a GitHub repository (`owner/repo` or a URL), or a folder on your computer.
3. **Press + next to the project** to create a workspace, and start typing.

To reopen Lonca later, run `npm start` again. The link it prints contains an access token, and your browser remembers it after the first visit.

For a virtual machine per workspace, which is what you want if you can have it, also install [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/). It runs on Macs with Apple silicon and on Ubuntu 24.04 or later with KVM, is free for local use, and needs a Docker account. On a Mac:

```sh
brew trust docker/tap && brew install docker/tap/sbx && sbx login
```

Without it, workspaces run in hardened containers. Lonca picks it up by itself, and **Settings** shows which you're getting (see [How isolation works](#how-isolation-works)).

## What you get

- **Projects and workspaces.** Add as many repositories as you like, and open as many workspaces in each as you need. Each one gets a city name, a branch such as `you/amman` from `origin/main`, and a virtual machine or container of its own.
- **Claude and Codex.** Open several conversations in one workspace, each with its own agent, model and effort level. Conversations keep going if you close the browser or restart Lonca, and you can queue follow-ups while an agent works.
- **Changes and checks.** Browse and search files, read a diff of everything on the branch, and follow a pull request's checks. Create PR asks the agent to commit, push and open one.
- **Terminals.** Each workspace has real shells inside it, and a Setup tab if your project has a setup script. A shell can move to a separate browser window, which you can place, minimize or make full screen like any other. Closing that window brings the terminal back to the panel, still running. If your browser blocks the window, allow pop-ups for Lonca. Run scripts left running by an older version appear as Recovered run script terminals; closing one stops its processes.

## Project settings

Open a project's settings from the **⋯** menu beside its name.

| Setting | What it does |
| --- | --- |
| Setup script | Runs in the workspace when it's created or restored, for example `npm install`. |
| Files to copy | Patterns for ignored files to copy from your local checkout, such as `.env*`. Off by default, because agents can read whatever is in their workspace. |
| Network access | Internet only (the default), or internet plus this computer and your local network, including other workspaces' published ports. |
| Memory and CPU limits | Limits for each workspace. |
| Custom image | An image built `FROM` the Lonca image, for extra toolchains. |
| Environment variables | Available to agents, terminals and scripts in the project's workspaces. |

A repository can also carry its own setup script in a `lonca.json` file at its root. It's used when the project has none set:

```json
{ "scripts": { "setup": "npm install" } }
```

Rebuild a workspace from its **⋯** menu to apply network, image or limit changes to it. Its files and conversations are kept. A container keeps its home directory too, but a virtual machine starts afresh, along with anything installed in it.

To close a workspace, use the trash icon on its row in the sidebar or at the top right of its panel. This archives it: its runtime is shut down and removed along with its checkout, so anything not committed is lost, while its branch and chat are kept. Archived workspaces are listed under **N archived** in the sidebar. Open one to restore it, or use its trash icon to delete it for good, along with any commits that were never pushed.

If an operation fails or Lonca stops partway through it, the workspace remembers what was requested. Its retry button names that operation: retrying an archive finishes archiving, and retrying a delete finishes deleting. A failed cleanup stops the runtime and remains visible until it succeeds. If an archive can't finish, the trash icon offers to delete the workspace instead. Creation and restoration copy only missing files, so retrying after a partial copy preserves edits already made in the workspace. Setup failures have their own status and can be rerun from the Setup tab.

Running agents stay tracked while Docker is unreachable. An accepted Stop is saved and completes when the process can be reached again, including after a Lonca restart. Surviving scripts regain their Stop controls when Docker reconnects. Shells can also be stopped or restarted, but their old terminal output and input connection cannot be restored; the terminal explains when this happens.

Messages and queue changes are saved before they are accepted. A completed turn keeps its recovery data until all its output has been read and both its transcript and completion state are saved. Interrupted reads and failed writes are retried, and follow-ups wait until completion can be saved. If Ctrl-C cannot save pending conversations or state, Lonca reports the problem and stays running; restore writable storage, then stop it again. If `state.json` or `secrets.json` can't be read at startup, Lonca reports it and doesn't start, so it can't overwrite them. A conversation whose saved file can't be read says so in the chat and keeps its queued messages. Once the file is readable, the chat reloads by itself and any turn being recovered carries on; use Send now for a message that was left waiting. While that file can't be read after a restart, Lonca can't stop that conversation's agent or delete its workspace. Restore access to the file, or stop the runtime with `docker stop` or `sbx stop`.

Unread agent output survives workspace restarts. If the runtime stops, start the workspace to recover the remaining conversation before follow-ups run. Rebuilding or archiving first recovers any pending output. Explicit workspace deletion can discard that output once its processes are confirmed stopped, including when an occupied port prevents the old runtime from starting. Background reads, automatically opened terminals, terminal recovery and resize checks leave stopped runtimes stopped. The exception is a read that overlaps an `sbx stop` run outside Lonca: `sbx exec` starts a stopped virtual machine, so it can come back, and stopping it again fixes that. Use Start, send a message, or choose Send now to wake a workspace.

Inside a workspace, `LONCA_PORT` is the first of ten ports published on your `localhost`. A server has to listen on `0.0.0.0` for you to reach it, for example `npm run dev -- --host 0.0.0.0 --port $LONCA_PORT` in a terminal. The first port is linked from the top of a conversation and from the menu beside the trash icon. `LONCA_WORKSPACE_NAME`, `LONCA_WORKSPACE_PATH`, `LONCA_DEFAULT_BRANCH` and `LONCA_PROJECT` are set too.

## Signing in

Lonca signs in separately from the CLIs on your computer and leaves those logins alone. Sharing one would break them: both CLIs rotate their refresh tokens, so a container refreshing a copy would log your computer out.

- **Claude:** open the sign-in page and approve access, and your browser comes back to Lonca by itself. Lonca runs `claude setup-token` out of sight in a container and saves the token it creates, which never reaches the page. This needs a Claude subscription; you can use an Anthropic API key instead.
- **Codex:** open the sign-in page and approve access, and your browser comes back to Lonca by itself. Lonca runs `codex login` out of sight in a container. Signing in this way, Codex also asks OpenAI for an API key. It doesn't use one with this login, so Lonca doesn't keep it. You can use an OpenAI API key instead.
- **GitHub:** agents need a token to fetch private repositories, push and open pull requests. Press **Use my gh login** to copy the one from your `gh` CLI, or paste one. Because every workspace can read it, a fine-grained token limited to the repositories you use here is the safer choice.

The sign-in pages send your browser to a port on `localhost`, as they do for the CLIs: 1455 for Codex and one the CLI picks for Claude. Lonca listens there for as long as the sign-in lasts and passes the request to the CLI in its container, so your browser has to be on the computer running Lonca. If it isn't, or the port is taken, the dialog offers a way that doesn't need it: a code to paste for Claude, and a one-time code to enter on the page for Codex (`codex login --device-auth`). If device code login is off for your account, turn it on in ChatGPT under Settings > Security.

The Claude and GitHub tokens are stored in `~/.lonca/secrets.json`, readable only by you, and handed to each process in a workspace as it starts, so they never become part of its definition. Codex's login lives in `~/.lonca/credentials`, a directory all workspaces share and Lonca itself never reads.

## How isolation works

A new workspace gets a virtual machine wherever [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) can run one, and a hardened Docker container everywhere else. A workspace stays what it started as, so workspaces made before you installed Docker Sandboxes remain containers. Either way, it can see its own worktree, its project's git data and a private home directory, and nothing else on your computer.

| Boundary | Virtual machine | Container |
| --- | --- | --- |
| Kernel | Its own, behind a hypervisor. | Shared with Docker. On macOS, Docker Desktop runs that kernel inside one virtual machine for all containers. |
| Filesystem | The worktree, the project's `repo.git`, the shared Codex login and a directory for its conversations are mounted. The home directory is on the VM's own disk. | The worktree, the project's `repo.git` and the shared Codex login are mounted. The home directory is a Docker volume private to the workspace. |
| Privileges | Agents have `sudo` and a Docker engine of their own, which stop at the VM. | Runs as an unprivileged user with no capabilities and `no-new-privileges`, so `sudo` and setuid programs do nothing. |
| Network | Every connection goes through a proxy on your computer. Rules on each sandbox block your computer, your LAN, cloud metadata addresses and other workspaces, leaving the public internet. | A firewall set up before privileges are dropped blocks the same things. If it can't be installed, the container refuses to start. |
| Resources | Optional memory and CPU limits. | Process count is capped, with optional memory and CPU limits. |

The network boundaries above apply to **Internet only**, the default. Choosing **Internet and this computer** allows host and local-network services, including ports published by other workspaces through `host.docker.internal`, even across projects. Use it only when you trust the workspace with those services.

The rest is the same for both.

| Boundary | How it's enforced |
| --- | --- |
| The Lonca server | Listens on `127.0.0.1` only and requires a token, with checks against DNS rebinding and cross-site requests. The token is kept in the page's per-origin storage, not a cookie, so servers on published ports never see it. During a sign-in it also listens on the port the sign-in page comes back to, also on `127.0.0.1`, which passes on only a request with that sign-in's random state. |
| Host git | After a repository is first imported, Lonca never runs git on it from your computer. Everything happens inside a workspace, so an agent's git hooks and config can't execute outside it. |
| SSH keys | Agents don't get your SSH agent. A container never has it. Docker Sandboxes 0.50 gives a virtual machine the SSH agent of whoever last ran a command in it, so every command Lonca runs there brings an agent with no keys. On that version, running `sbx exec` on a Lonca virtual machine from a terminal lets it use your keys until Lonca's next command in it. Version 0.51 didn't lend keys this way when tested, but its forwarding setting is still on by default. To rule it out on any version, run `sbx settings set ssh.agentForwardingEnabled false` and `sbx daemon restart`. |

Agents run with their own permission prompts turned off, since the workspace is the sandbox. Lonca's helper, which does the signing in and status checks, is a hardened container in both cases. Agents never run in it.

### What is shared

- **Within a project,** workspaces share one `repo.git`, because that's how git worktrees work. An agent could change another workspace's branches, or leave config and hooks that affect its neighbours. Treat all the workspaces of a project as one trust level, even in virtual machines.
- **Credentials.** Every workspace can read the agent and GitHub tokens it needs to work, so an agent could misuse them, and the shared Codex login can be overwritten from any workspace. These credentials are shared across projects. A virtual machine doesn't change this: Lonca hands out credentials the same way for both. Use scoped tokens where you can.
- **Outbound internet.** An agent can send anything it can read to the internet. It could read your code and your tokens, but not your computer's other files.
- **Your browser and clipboard, from a virtual machine.** Docker Sandboxes lets processes in a VM open links in your browser (`sbx settings set browser.enabled false` stops that for every sandbox) and write to your clipboard.
- **Be careful on your computer.** Worktrees live in `~/.lonca/projects/<project>/workspaces/<name>` and work with your local tools, but running `git` in one, or opening it in an editor, reads config an agent could have written. Treat a checkout an agent has touched as untrusted code, as you would any repository you download.

## Limitations

- Codex replies appear when each message is complete, rather than word by word.
- In a container, Docker isn't available, so projects that need `docker compose` for tests won't be able to run them there. In a virtual machine, it is.
- In a container, `apt-get install` doesn't work because it can't gain root. In a virtual machine, `sudo apt-get install` works, but only lasts until the workspace is rebuilt. To keep system packages in either, use a custom image. Settings shows the tag to start from, which begins `lonca-sandbox:` for a virtual machine or `lonca-workspace:` for a container:

  ```dockerfile
  FROM lonca-workspace:<tag from Settings>
  USER root
  RUN apt-get update && apt-get install -y postgresql-client
  ```

  Leave container images as `USER root`: the entrypoint installs the firewall, then switches to `lonca`. For a virtual machine, use `FROM lonca-sandbox:<tag from Settings>` and add `USER agent` at the end.

- Local repositories with no remote can't be pushed from a workspace. Their commits stay on the branch in `~/.lonca/projects/<project>/repo.git`, and you can fetch them from there.
- Lonca is for one person on one computer. To use it from elsewhere, forward its port over SSH instead of exposing it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4700` | Port for the web app. |
| `LONCA_HOME` | `~/.lonca` | Where projects, worktrees and settings are stored. |
| `LONCA_FIRST_PORT` | `20000` | First port published for workspaces. |
| `LONCA_RUNTIME` | `auto` | `auto` gives new workspaces a virtual machine if it can. `container` always uses containers. `sandbox` refuses to create a workspace without a virtual machine. |
| `LONCA_NO_OPEN` | | Set to `1` to skip opening a browser. |

To remove Lonca completely, delete `~/.lonca` and every Docker resource it created:

```sh
docker ps -aq --filter label=dev.lonca.instance=lonca | xargs docker rm -f
docker volume ls -q --filter label=dev.lonca.instance=lonca | xargs docker volume rm
docker network ls -q --filter label=dev.lonca.instance=lonca | xargs docker network rm
sbx ls -q | grep '^lonca-' | xargs sbx rm --force
```

## Development

```sh
npm run dev         # server with reloads, plus Vite on http://localhost:5173
npm run typecheck
npm test            # unit tests
npm run test:docker # integration tests against real Docker
npm run test:e2e    # the whole app in a browser (first: npx playwright install chromium)
npm run test:sandbox # the integration tests again, in real virtual machines (needs Docker Sandboxes, signed in)
npm run test:fake-sandbox # the same, with tests/support/fake-sbx in place of Docker Sandboxes
```

The Docker and browser suites run the real `claude` and `codex` CLIs in real containers. Only the models behind them are replaced, by a scripted server in `tests/support/mock-llm.ts`, so the suites need no credentials and spend no tokens. They use their own throwaway home directories and Docker resources and clean up after themselves, so they're safe to run alongside a real instance.

`tests/support/fake-sbx` accepts the same commands as `sbx`, but its "sandboxes" are plain containers. That exercises everything of Lonca's on the way to a virtual machine, without a Docker account, but it can't stand in for the VM itself, its network rules or its file sharing. Only `test:sandbox` covers those.

| Directory | Contents |
| --- | --- |
| `server/` | HTTP and WebSocket API, workspace lifecycle, agent runs. Runs directly with Node's TypeScript support. |
| `server/agents/` | One adapter per CLI: the command to run and a parser for its JSONL output. |
| `web/` | The React app. |
| `shared/` | Types used by both. |
| `docker/workspace/` | The workspace images, for containers and virtual machines, and the scripts inside them. |

An agent runs detached inside its workspace, writing its output to a file the server follows. That's why a turn survives the server restarting: the new server finds the run and reads its output again from the start.

Recovery tests cover operations and their failure boundaries together:

| Cases | Coverage |
| --- | --- |
| Interrupted create, restore, start, stop, rebuild, archive, delete; failure to save intent; setup launch failure; duplicate deletion | `tests/unit/workspace-recovery.test.ts` |
| Partial create/restore file copies; archive/delete/stop failures before cleanup; failures and server crashes during cleanup | `tests/docker/operation-recovery.test.ts` |
| Rebuild retries and interrupted rebuilds; concurrent wake requests; queued work; agents reconnecting before Stop; session and project removal | `tests/docker/recovery.test.ts` |
| Surviving setup scripts and shells, including job groups whose shell exited; concurrent script restart/Stop; a 70-second Docker outage; Stop surviving a server crash; failed state writes before direct/queued agent launches | `tests/docker/process-recovery.test.ts` |
| Failed Stop persistence during agent recovery and uncertain startup; shutdown grace, held queues, and lifecycle retries after writes recover | `tests/docker/agent-persistence.test.ts` |
| Completed and recovered transcripts across immediate crashes; failed transcript/state writes; durable message acceptance, queue changes, and lost-conversation retries; queued work and running agents through unreadable transcripts; shutdown with unwritable storage | `tests/docker/transcript-persistence.test.ts` |
| Failed launch acknowledgments and output reads; missing or inconsistent completion receipts; partial records; queued work during replay; missing or damaged raw output; runtime restarts, and recovery before rebuild/archive | `tests/docker/agent-output.test.ts` |
| Deletion with unread output and occupied ports, project deletion and crash retries, unreachable runtimes, history preservation during archive/rebuild, stopped shells and scripts | `tests/docker/runtime-stop.test.ts` |
| Passive access after external stops or runtime removal; explicit starts and messages; queued messages after a failed wake; browser polling and automatic terminals | `tests/docker/runtime-access.test.ts`, `tests/e2e/runtime-stop.spec.ts` |
| Pending terminal resizes while a sandbox is stopped, missing or unreachable; resizing after recovery; stale resizes after terminal exit | `tests/unit/sandbox-terminal.test.ts` |
| Terminal recovery during runtime shutdown, preserved script exit codes, and scans limited to workspaces present at server startup | `tests/unit/terminal-recovery.test.ts` |
| Partial transcript appends, interrupted queue promotion, retained writes and automatic retries, flushing multiple conversations, deletion with pending writes | `tests/unit/transcript-persistence.test.ts` |
| Recovered script controls, and when the Setup tab appears, in the browser | `tests/e2e/setup.spec.ts` |
| Moving a terminal to its own window and back, through reloads, exits and a blocked pop-up, in the browser | `tests/e2e/terminal-window.spec.ts` |
| A conversation that can't be read on opening or after a reconnect, and recovering from it, in the browser | `tests/e2e/hydration.spec.ts` |
| Archiving out of a failed operation, restoring from it, and deleting after a failed archive or delete, in the browser | `tests/e2e/workspace-close.spec.ts` |

The outage tests use a connection proxy for their own server. They leave the actual Docker daemon and unrelated workspaces running. Tests requiring real Docker fault injection are skipped in the sandbox suite; the partial-copy and terminal-control cases also run through the fake sandbox adapter.

## License

[MIT](LICENSE)
