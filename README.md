# Lonca

Run coding agents side by side from your browser. Every workspace is a real git worktree on its own branch, running in its own virtual machine, with Claude and Codex ready to work in it.

*Lonca* is Turkish for guild: a group of craftspeople working on separate pieces under one roof.

## Get started

You need [Node.js](https://nodejs.org) 22.18 or newer, git, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), which gives each workspace its own virtual machine. It runs on Macs with Apple silicon and on Ubuntu 24.04 or later with KVM, is free for local use, and needs a Docker account. Docker Desktop isn't needed. On a Mac:

```sh
brew trust docker/tap && brew install docker/tap/sbx
```

Then:

```sh
npm install
npm start
```

Lonca opens in your browser. After that:

1. **Sign in to Docker.** Settings does it for you (see [Signing in](#signing-in)), or run `sbx login` in a terminal. Then Lonca builds the workspace template, which takes a few minutes the first time.
2. **Sign in to an agent.** The home page walks you through it (see [Signing in](#signing-in)).
3. **Add a project.** Give it a GitHub repository (`owner/repo` or a URL), or a folder on your computer.
4. **Press + next to the project** to create a workspace, and tell its [Lead](#the-lead) what you want done.

To reopen Lonca later, run `npm start` again. The link it prints contains an access token, and your browser remembers it after the first visit.

## What you get

- **Projects and workspaces.** Add as many repositories as you like, and open as many workspaces in each as you need. Each one gets a city name, a branch such as `you/amman` from `origin/main`, and a virtual machine of its own.
- **A Lead in every workspace.** The first tab is an agent that answers for the outcome. It does the work itself or starts other agents, on any model, in tabs of their own, and compares and cross-checks what they find.
- **Claude and Codex.** Open several conversations in one workspace, each with its own agent, model and effort level. Conversations keep going if you close the browser or restart Lonca, and you can queue follow-ups while an agent works.
- **Changes and checks.** Browse and search files, read a diff of everything on the branch, and follow a pull request's checks. Create PR asks the agent to commit, push and open one.
- **Terminals.** Each workspace has real shells inside it, and a Setup tab if your project has a setup script. A shell's prompt names its project and the last part of its branch, as in `lonca@lonca-malmo` for `itemir/malmo` in the lonca project, and follows the branch if you switch. A shell can move to a separate browser window, which you can place, minimize or make full screen like any other. Closing that window brings the terminal back to the panel, still running. If your browser blocks the window, allow pop-ups for Lonca. Run scripts left running by an older version appear as Recovered run script terminals; closing one stops its processes.

## The Lead

Every new workspace opens on a tab called **Lead**. Tell it the outcome you want. It can do the work itself or start agents in tabs of their own, then read what they report, put one's argument to another, have one fix something and another review it, and try again when one hits a usage limit. You can watch any agent and write to it directly, and the Lead is told.

A workspace has one Lead at a time. Close it and you can start another, which is told about the agents already there. The closed one's conversation stays readable from the workspace's **⋯** menu.

- **Its model.** The default is in Settings. You can change it for a workspace until you send the Lead its first message. After that it stays, including for a new Lead. The one exception is when the model can't run, because it's reached a usage limit, gone away or been signed out: a banner offers to move the Lead, and the move is recorded in the conversation. Moving to another provider starts a new Lead, because the CLIs can't read each other's conversations.
- **Agents.** They share the workspace's files and branch, so everyone sees the same changes. What each one is told and what it reports go only to the Lead and you, and they have no way to reach each other. One at a time may change files. The others are told not to, and if files change during their turn, the Lead and you hear about it. While one is changing files, **Try now** and **Send now** won't start another. A message you type to another goes ahead, with a warning. Settings says how many can work at once. The Lead does the pushing. Agents are told to leave it to the Lead, but nothing stops them.
- **Waiting.** A Lead waiting for agents isn't running, so it uses nothing. It gets a new turn when they've all finished, or as soon as one fails or hits a limit. After 30 turns without a word from you, it pauses until you let it continue.
- **Stopping.** Stop on the Lead stops its turn. **Stop the agents**, or Stop in an agent's tab, stops them until you say otherwise, and the Lead can't restart an agent you stopped.
- **The playbook.** What Leads are told about how to work, in Markdown: when to delegate, who to use, how to treat reviews. Lonca ships a template. Edit it in Settings, which saves `~/.lonca/lead.md`. A project can have its own in place of that, in its settings, saved as `~/.lonca/projects/<project>/lead.md`. Neither is inside a workspace, so agents can't change them. Leads follow a change from their next turn.
- **When it needs you.** A dot appears on the tab, the sidebar and the page's title. If you aren't looking at Lonca, your computer also shows a notification, which you can turn off in Settings. On macOS these come from Script Editor, so it has to be allowed under System Settings > Notifications.

## Project settings

Open a project's settings from the **⋯** menu beside its name.

| Setting | What it does |
| --- | --- |
| Setup script | Runs in the workspace when it's created or restored, for example `npm install`. |
| Files to copy | Patterns for ignored files to copy from your local checkout, such as `.env*`. Off by default, because agents can read whatever is in their workspace. |
| Network access | Internet only (the default), or internet plus this computer and your local network, including other workspaces' published ports. |
| Memory and CPU limits | Limits for each workspace. |
| Custom template | A template saved from a workspace, for extra toolchains (see [Limitations](#limitations)). |
| Environment variables | Available to agents, terminals and scripts in the project's workspaces, which can all read them. |

A repository can also carry its own setup script in a `lonca.json` file at its root. It's used when the project has none set:

```json
{ "scripts": { "setup": "npm install" } }
```

Rebuild a workspace from its **⋯** menu to apply network, template or limit changes to it. Its files and conversations are kept. The virtual machine starts afresh, along with anything installed in it.

To close a workspace, use the trash icon on its row in the sidebar or at the top right of its panel. This archives it: its runtime is shut down and removed along with its checkout, so anything not committed is lost, while its branch and chat are kept. Archived workspaces are listed under **N archived** in the sidebar. Open one to restore it, or use its trash icon to delete it for good, along with any commits that were never pushed.

If an operation fails or Lonca stops partway through it, the workspace remembers what was requested. Its retry button names that operation: retrying an archive finishes archiving, and retrying a delete finishes deleting. A failed cleanup stops the runtime and remains visible until it succeeds. If an archive can't finish, the trash icon offers to delete the workspace instead. Creation and restoration copy only missing files, so retrying after a partial copy preserves edits already made in the workspace. Setup failures have their own status and can be rerun from the Setup tab.

Running agents stay tracked while Docker Sandboxes is unreachable. An accepted Stop is saved and completes when the process can be reached again, including after a Lonca restart. Surviving scripts regain their Stop controls when it reconnects. Shells can also be stopped or restarted, but their old terminal output and input connection cannot be restored; the terminal explains when this happens.

Messages and queue changes are saved before they are accepted. A completed turn keeps its recovery data until all its output has been read and both its transcript and completion state are saved. Interrupted reads and failed writes are retried, and follow-ups wait until completion can be saved. If Ctrl-C cannot save pending conversations or state, Lonca reports the problem and stays running; restore writable storage, then stop it again. If `state.json` or `secrets.json` can't be read at startup, Lonca reports it and doesn't start, so it can't overwrite them. A conversation whose saved file can't be read says so in the chat and keeps its queued messages. Once the file is readable, the chat reloads by itself and any turn being recovered carries on; use Send now for a message that was left waiting. While that file can't be read after a restart, Lonca can't stop that conversation's agent or delete its workspace. Restore access to the file, or stop the runtime with `sbx stop` or `sbx stop`.

Unread agent output survives workspace restarts. If the runtime stops, start the workspace to recover the remaining conversation before follow-ups run. Rebuilding or archiving first recovers any pending output. Explicit workspace deletion can discard that output once its processes are confirmed stopped, including when an occupied port prevents the old runtime from starting. Background reads, automatically opened terminals, terminal recovery and resize checks leave stopped runtimes stopped. The exception is a read that overlaps an `sbx stop` run outside Lonca: `sbx exec` starts a stopped virtual machine, so it can come back, and stopping it again fixes that. Use Start, send a message, or choose Send now to wake a workspace.

Inside a workspace, `LONCA_PORT` is the first of ten ports published on your `localhost`. A server has to listen on `0.0.0.0` for you to reach it, for example `npm run dev -- --host 0.0.0.0 --port $LONCA_PORT` in a terminal. The first port is linked from the top of a conversation and from the menu beside the trash icon. `LONCA_WORKSPACE_NAME`, `LONCA_WORKSPACE_PATH`, `LONCA_DEFAULT_BRANCH`, `LONCA_PROJECT` and `LONCA_PROJECT_SLUG` are set too.

## Signing in

Docker Sandboxes needs a Docker account. **Sign in to Docker** under Settings > Isolation shows a one-time code and a link to Docker's sign-in page, where you approve it. Lonca runs `sbx login` on your computer to do this, so it's the same login `sbx` uses in your terminal, kept by `sbx` itself. Lonca never sees it, and signing in from either one signs in both.

**Sign out of Docker** signs `sbx` out on the whole computer, your terminal included. It also stops every sandbox running on the computer: all of Lonca's workspaces, any agents working in them, and sandboxes that aren't Lonca's. Settings asks before it does. A workspace's files and conversations are kept, and you start it again once you've signed back in, which recovers any agent output left unread.

For the agents, Lonca signs in separately from the CLIs on your computer and leaves those logins alone. Sharing one would break them: both CLIs rotate their refresh tokens, so refreshing a copy would log your computer out.

- **Claude:** open the sign-in page and approve access, and your browser comes back to Lonca by itself. Lonca runs `claude setup-token` out of sight in a small virtual machine of its own and saves the token it creates, which never reaches the page. This needs a Claude subscription; you can use an Anthropic API key instead.
- **Codex:** open the sign-in page and approve access, and your browser comes back to Lonca by itself. Lonca runs `codex login` out of sight in the same place. Signing in this way, Codex also asks OpenAI for an API key. It doesn't use one with this login, so Lonca doesn't keep it. You can use an OpenAI API key instead.
- **GitHub:** agents need a token to fetch private repositories, push and open pull requests. Press **Use my gh login** to copy the one from your `gh` CLI, or paste one. Because anything in a virtual machine can use it, a fine-grained token limited to the repositories you use here is the safer choice.

The sign-in pages send your browser to a port on `localhost`, as they do for the CLIs: 1455 for Codex and one the CLI picks for Claude. Lonca listens there for as long as the sign-in lasts and passes the request to the CLI in its virtual machine, so your browser has to be on the computer running Lonca. If it isn't, or the port is taken, the dialog offers a way that doesn't need it: a code to paste for Claude, and a one-time code to enter on the page for Codex (`codex login --device-auth`). If device code login is off for your account, turn it on in ChatGPT under Settings > Security.

None of these ever enter a workspace. Docker Sandboxes' proxy, on your computer, adds them to requests as they leave a virtual machine, and all that's inside is a placeholder. Claude's goes only to `api.anthropic.com`, Codex's only to `chatgpt.com` and `api.openai.com`, and GitHub's only to GitHub's own hosts. Signing in or out takes effect straight away, in workspaces that are already running, though a terminal opened before you first signed in to Claude needs reopening. In a virtual machine, a connected GitHub account is used for GitHub even if the project sets its own `GH_TOKEN`.

On your computer, the Claude and GitHub tokens are in `~/.lonca/secrets.json`, Codex's login is in `~/.lonca/helper-credentials`, and `~/.lonca/boundary` holds what the proxy reads. All are readable only by you and none is mounted into a virtual machine. Lonca renews Codex's login before it runs out.

A project can use a key of its own by setting `CODEX_API_KEY` or `OPENAI_API_KEY` in its environment variables. That one isn't kept out: it goes into the project's virtual machines as it is, where anything in them can read it. Changing or removing it updates the ones running, though a program that already read it keeps what it read.

## How isolation works

Every workspace gets a virtual machine from [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/). It can see its own worktree, its project's git data and a private home directory, and nothing else on your computer.

| Boundary | How it's enforced |
| --- | --- |
| Kernel | Its own, behind a hypervisor. |
| Filesystem | The worktree, the project's `repo.git` and a directory for its conversations are mounted. The home directory is on the VM's own disk. |
| Credentials | None inside. A proxy on your computer adds them to requests as they leave. |
| Privileges | Agents have `sudo` and a Docker engine of their own, which stop at the VM. |
| Network | Every connection goes through a proxy on your computer. Rules on each sandbox block your computer, your LAN, cloud metadata addresses and other workspaces, leaving the public internet. |
| Resources | Optional memory and CPU limits. |
| The Lonca server | Listens on `127.0.0.1` only and requires a token, with checks against DNS rebinding and cross-site requests. The token is kept in the page's per-origin storage, not a cookie, so servers on published ports never see it. During a sign-in it also listens on the port the sign-in page comes back to, also on `127.0.0.1`, which passes on only a request with that sign-in's random state. |
| Host git | After a repository is first imported, Lonca never runs git on it from your computer. Everything happens inside a workspace, so an agent's git hooks and config can't execute outside it. |
| SSH keys | Agents don't get your SSH agent. Docker Sandboxes 0.50 gives a virtual machine the SSH agent of whoever last ran a command in it, so every command Lonca runs there brings an agent with no keys. On that version, running `sbx exec` on a Lonca virtual machine from a terminal lets it use your keys until Lonca's next command in it. Version 0.51 didn't lend keys this way when tested, but its forwarding setting is still on by default. To rule it out on any version, run `sbx settings set ssh.agentForwardingEnabled false` and `sbx daemon restart`. |

The network rules above apply to **Internet only**, the default. Choosing **Internet and this computer** allows host and local-network services, including ports published by other workspaces through `host.docker.internal`, even across projects. Use it only when you trust the workspace with those services.

Agents run with their own permission prompts turned off, since the workspace is the sandbox. Lonca's helper, which does the signing in, is a small virtual machine of its own. It starts when it's first needed, agents never run in it, and it only holds a sign-in while it's making or renewing one.

### What is shared

- **Within a project,** workspaces share one `repo.git`, because that's how git worktrees work. An agent could change another workspace's branches, or leave config and hooks that affect its neighbours. Treat all the workspaces of a project as one trust level, even in virtual machines.
- **Credentials.** Nothing in a virtual machine can read them, and the proxy won't send them anywhere else, but anything in one can use them while it runs. An agent can act as you on GitHub and spend your Claude and Codex usage, across every project. The login `gh` gives you has the `admin:public_key` scope, which would let an agent add an SSH key to your account, and that would outlive the workspace. Use a fine-grained token if you can.
- **Between a Lead's agents.** Keeping them apart stops them influencing each other by accident. It isn't a security boundary. They run as the same user in the same workspace, so one that goes looking can read another's conversation, push to GitHub, or change files the Lead reads, including ones that instruct it. The Lead is told to treat what agents report as evidence rather than instructions, but that's a request to a model, not a control.
- **Outbound internet.** An agent can send anything it can read to the internet. It could read your code and any variables in the project's settings, but not your sign-ins or your computer's other files.
- **Your browser and clipboard, from a virtual machine.** Docker Sandboxes lets processes in a VM open links in your browser (`sbx settings set browser.enabled false` stops that for every sandbox) and write to your clipboard.
- **Be careful on your computer.** Worktrees live in `~/.lonca/projects/<project>/workspaces/<name>` and work with your local tools, but running `git` in one, or opening it in an editor, reads config an agent could have written. Treat a checkout an agent has touched as untrusted code, as you would any repository you download.

## Limitations

- Codex replies appear when each message is complete, rather than word by word.
- Lonca doesn't yet check that a Lead's changes were reviewed before it opens a pull request. The playbook asks for it, and the Lead's report is its own account.
- Nothing resumes by itself when a usage limit ends. Use **Try now**, or tell the Lead to carry on.
- Agents share one checkout, so two running tests at once can collide over build output or ports. The playbook tells the Lead to stagger them.
- `sudo apt-get install` works in a workspace, but only lasts until the workspace is rebuilt. To keep system packages, install them in a workspace and save its virtual machine as a template, using the name shown when the workspace opened. Then enter the template's tag as the project's custom template, and rebuild workspaces to move them onto it:

  ```sh
  sbx stop <virtual machine>
  sbx template save <virtual machine> my-template:1
  ```

- Sign-in tokens reach the proxy through `sbx secret set-custom`, which Docker marks as experimental, because its built-in Anthropic and OpenAI services can't take one for a single sandbox. A future version of Docker Sandboxes could change it.
- Local repositories with no remote can't be pushed from a workspace. Their commits stay on the branch in `~/.lonca/projects/<project>/repo.git`, and you can fetch them from there.
- Lonca is for one person on one computer. To use it from elsewhere, forward its port over SSH instead of exposing it.

## Disk space

Everything a workspace's agents install or download stays on your computer's disk until the workspace goes. Each virtual machine has two disks, kept as files that start at about 6 MB each and grow as they're used: up to 20 GB for the machine's own files, and up to 10 GB for its Docker engine's images and containers. Workspaces don't share these, so a browser or Docker image that five of them download takes up five times the space. What's deleted inside a virtual machine usually comes back within about a minute. Worktrees are on your computer too, along with anything like `node_modules` in them.

To get space back, archive workspaces you aren't using, which removes the virtual machine and the worktree. Rebuilding one from its **⋯** menu replaces only the virtual machine, which keeps the worktree and conversations but loses everything else on its disks, such as its home directory and Docker images. If several workspaces need the same heavy tools, installing them once in a project's template, as described under [Limitations](#limitations), means they share one copy, though not of Docker images, which a template can't hold.

A template takes up about 1.5 GB beyond what templates share. Lonca removes one when it's replaced, when it starts and finds an older one, and when the last virtual machine made from it goes. Until then a workspace holds on to the template it was made from, which it needs to be saved as a template itself.

When less than 20 GB is left, the status at the foot of the sidebar says **Disk almost full**, and Settings says how much is left. It goes by the disk your home folder is on, where Docker Sandboxes keeps virtual machines' disks, or the one `LONCA_HOME` is on if that has less room.

If your computer's disk does fill up, virtual machines' disks can turn read-only and agents fail in confusing ways, whereas a virtual machine that only fills its own disk just reports that it's out of space. Free up some space, then restart the affected workspaces with `sbx stop <virtual machine>` and **Start** in Lonca. If one's still stuck, rebuild it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4700` | Port for the web app. |
| `LONCA_HOME` | `~/.lonca` | Where projects, worktrees and settings are stored. |
| `LONCA_FIRST_PORT` | `20000` | First port published for workspaces. |
| `LONCA_NO_OPEN` | | Set to `1` to skip opening a browser. |
| `LONCA_NO_NOTIFY` | | Set to `1` to never show notifications, whatever Settings says. |

To remove Lonca completely, delete `~/.lonca` and the virtual machines and templates it created:

```sh
sbx ls -q | grep '^lonca-' | xargs sbx rm --force
sbx template ls --json | jq -r '.[] | select(.repository == "docker.io/library/lonca-sandbox").id' | sort -u | xargs -n1 sbx template rm --force
```

A template that was replaced while a workspace was on it stays with only the name `sandbox-kit-assembled:<hash>`. `sbx template ls` lists those, and `sbx template rm --force <image ID>` removes one.

If you used Lonca when workspaces ran in containers, this removes what's left of that. Do it before starting this version, because agents can still be running in those containers. A workspace from then gets a virtual machine the next time it starts. Its files are kept, and its agents' conversations start afresh.

```sh
docker ps -aq --filter label=dev.lonca.instance=lonca | xargs docker rm -f
docker volume ls -q --filter label=dev.lonca.instance=lonca | xargs docker volume rm
docker network ls -q --filter label=dev.lonca.instance=lonca | xargs docker network rm
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^lonca-(workspace|sandbox):' | xargs docker rmi
```

## Development

```sh
npm run dev         # server with reloads, plus Vite on http://localhost:5173
npm run typecheck
npm test            # unit tests
npm run test:docker # integration tests, with Docker containers standing in for virtual machines
npm run test:e2e    # the whole app in a browser (first: npx playwright install chromium)
npm run test:sandbox # the integration tests again, in real virtual machines (needs Docker Sandboxes, signed in)
```

The Docker and browser suites run the real `claude` and `codex` CLIs. They need Docker, which Lonca itself doesn't, because `tests/support/fake-sbx` stands in for `sbx` with plain containers. What's replaced is the models behind them, by a scripted server in `tests/support/mock-llm.ts`, and for the sign-in tests the services that sign in, by `tests/support/fake-signin.mjs`, so the suites need no credentials and spend no tokens. They use their own throwaway home directories and sandboxes and clean up after themselves, so they're safe to run alongside a real instance.

Tests keep a template of their own, `lonca-instance-sandbox`, as any instance with `LONCA_INSTANCE` set does, so a run can't touch the one your server uses. That exercises everything of Lonca's on the way to a virtual machine, without a Docker account, but it can't stand in for the VM itself, its proxy, its network rules or its file sharing. Only `test:sandbox` covers those.

| Directory | Contents |
| --- | --- |
| `server/` | HTTP and WebSocket API, workspace lifecycle, agent runs. Runs directly with Node's TypeScript support. |
| `server/agents/` | One adapter per CLI: the command to run and a parser for its JSONL output. Also the Lead: its tools (`team.ts`, `lonca-tools.py`) and the playbook template (`lead-template.md`). |
| `web/` | The React app. |
| `shared/` | Types used by both. |
| `template/` | What the workspace template is made from: the script that builds it and the files it installs. |

An agent runs detached inside its workspace, writing its output to a file the server follows. That's why a turn survives the server restarting: the new server finds the run and reads its output again from the start. A Lead's tools work the same way, with no network path to the server: an MCP server inside the workspace appends each call to a file the server is following, and waits for the server to write the reply.

Recovery tests cover operations and their failure boundaries together:

| Cases | Coverage |
| --- | --- |
| Interrupted create, restore, start, stop, rebuild, archive, delete; failure to save intent; setup launch failure; duplicate deletion | `tests/unit/workspace-recovery.test.ts` |
| Partial create/restore file copies; archive/delete/stop failures before cleanup; failures and server crashes during cleanup | `tests/docker/operation-recovery.test.ts` |
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
| Recovered script controls, and when the Setup tab appears, in the browser | `tests/e2e/setup.spec.ts` |
| Moving a terminal to its own window and back, through reloads, exits and a blocked pop-up, in the browser | `tests/e2e/terminal-window.spec.ts` |
| A conversation that can't be read on opening or after a reconnect, and recovering from it, in the browser | `tests/e2e/hydration.spec.ts` |
| Archiving out of a failed operation, restoring from it, and deleting after a failed archive or delete, in the browser | `tests/e2e/workspace-close.spec.ts` |
| A Lead's tool calls made while the server was down or repeated after a crash, agents that finish while it's down, usage limits, stopped agents and Leads, closing a Lead with agents running | `tests/docker/lead.test.ts`, `tests/e2e/lead.spec.ts` |
| Signing Docker Sandboxes in and out: reading what `sbx login` prints, cancelling, time limits, the warning before signing out, and workspaces stopped by it | `tests/unit/docker-login.test.ts`, `tests/e2e/docker-signin.spec.ts`, `tests/docker/lonca.test.ts` |
| Credentials staying out of every process and file in a workspace; what the proxy is told, per sandbox; renewing Codex's sign-in; moving the login from where older workspaces can see it | `tests/docker/boundary.test.ts`, `tests/unit/boundary.test.ts` |

The outage tests cut their own server off from the stand-in for `sbx`, leaving its sandboxes running. They need that stand-in, so they're skipped in `test:sandbox`.

## License

[MIT](LICENSE)
