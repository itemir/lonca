# Using Lonca

The details behind the [README](../README.md). How workspaces are kept apart, and what they share, is in [How isolation works](isolation.md).

## Conversations

Open several conversations in one workspace, each with its own agent, model and effort level, and sign-in if you have several. Conversations keep going if you close the browser or restart Lonca, and you can write to an agent while it works: Claude reads your message at its next step, and Codex once its turn ends.

### Writing while it works

With Claude, a message you send to a conversation that's working, or that the Lead sends to a working agent, reaches the agent while it works. Claude reads it at its next step, usually when a command or tool it's running finishes, and carries on with it in mind. If it was writing its final reply, it answers your message straight afterwards. Until it's read, the message waits under the turn, saying so, and can't be cancelled, because the agent may be reading it. Once read, it moves into the conversation where the agent read it.

Codex can't take a message while `codex exec` runs, so a message to a working Codex conversation waits for its turn to end, and you can cancel it until then. So do Lonca's own updates to a Lead, which are meant to start a turn of their own.

If a turn is stopped before the agent has read a message, the message stays queued, and is held like anything else queued after a Stop. If a virtual machine stops dead within a moment of Claude reading a message, Claude's own copy of the conversation can be missing it although Lonca shows it as read. If the agent seems not to have seen it, send it again.

## The Lead

Every new workspace opens on a tab called **Lead**. Tell it the outcome you want. It can do the work itself or start agents in tabs of their own, then read what they report, put one's argument to another, have one fix something and another review it, and try again when one hits a usage limit. You can watch any agent and write to it directly, and the Lead is told.

A workspace has one Lead at a time. Close it and you can start another, which is told about the agents already there. The closed one's conversation stays readable from the workspace's **⋯** menu.

- **Its model.** The default is in Settings. You can change it for a workspace until you send the Lead its first message. After that it stays, including for a new Lead. The one exception is when the model can't run, because it's reached a usage limit, gone away or been signed out: a banner offers to move the Lead, and the move is recorded in the conversation. Moving to another provider starts a new Lead, because the CLIs can't read each other's conversations.
- **Its sign-in.** Where a provider has [several sign-ins](#several-sign-ins), the Lead's can change at any time, from its model's lock or the limit banner, because the conversation goes with it. Its agents start on its own sign-in, or for another provider on that one's default, and stay on the one they started on until they're moved, even if the Lead moves. Its tools only let it choose others where you've allowed conversations to move there by themselves, and `team_status` tells it which those are and which are at their limit. Nothing else stops it: every virtual machine has every sign-in's placeholder, so anything running in one could use any of them.
- **Agents.** They share the workspace's files and branch, so everyone sees the same changes. What each one is told and what it reports go only to the Lead and you, and they have no way to reach each other. One at a time may change files. The others are told not to, and if files change during their turn, the Lead and you hear about it. While one is changing files, **Try now** and **Send now** won't start another. A message you type to another goes ahead, with a warning. Settings says how many can work at once. The Lead does the pushing. Agents are told to leave it to the Lead, but nothing stops them.
- **Waiting.** A Lead waiting for agents isn't running, so it uses nothing. It gets a new turn when they've all finished, or as soon as one fails or hits a limit. After 30 turns without a word from you, it pauses until you let it continue.
- **Ports.** Besides a workspace's ten [published ports](#ports), the Lead can forward a port on your `localhost` to any port in its virtual machine, so that you can open a server it's running there. Ask it to, and it gives you the link. It's told what's listening there, and to restart a server that only listens on `localhost` inside the VM, which you couldn't reach. Forwards are listed at the top of its conversation and in the menu beside the trash icon, each with a button to close it. They all close when the workspace stops.
- **Stopping.** Stop on the Lead stops its turn. **Stop the agents**, or Stop in an agent's tab, stops them until you say otherwise, and the Lead can't restart an agent you stopped.
- **The playbook.** What Leads are told about how to work, in Markdown: when to delegate, who to use, how to treat reviews. Lonca ships a template. Edit it in Settings, which saves `~/.lonca/lead.md`. A project can have its own in place of that, in its settings, saved as `~/.lonca/projects/<project>/lead.md`. Neither is inside a workspace, so agents can't change them. Leads follow a change from their next turn.
- **When it needs you.** A dot appears on the tab, the sidebar and the page's title. If you aren't looking at Lonca, your computer also shows a notification, which you can turn off in Settings. On macOS these come from Script Editor, so it has to be allowed under System Settings > Notifications.

## Changes and pull requests

Browse and search files, read a diff of everything on the branch, and follow a pull request's checks. Create PR asks the agent to commit, push and open one. The top of the side panel says what the pull request is waiting for, including work in the workspace that isn't in it yet, and offers Merge once GitHub would merge it. Merge asks first, and Lonca checks again just before merging, so nothing pushed after you looked is merged. It never deletes the branch. Once the pull request is merged, the panel offers Archive. While the workspace is stopped, it shows the pull request as it was when last checked.

## Terminals

Each workspace has real shells inside it, and a Setup tab if your project has a setup script. A shell's prompt names its project and the last part of its branch, as in `lonca@lonca-malmo` for `itemir/malmo` in the lonca project, and follows the branch if you switch. A shell can move to a separate browser window, which you can place, minimize or make full screen like any other. Closing that window brings the terminal back to the panel, still running. If your browser blocks the window, allow pop-ups for Lonca. Run scripts left running by an older version appear as Recovered run script terminals; closing one stops its processes.

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

## Ports

Inside a workspace, `LONCA_PORT` is the first of ten ports published on your `localhost`. A server has to listen on `0.0.0.0` for you to reach it, for example `npm run dev -- --host 0.0.0.0 --port $LONCA_PORT` in a terminal. The first port is linked from the top of a conversation and from the menu beside the trash icon. `LONCA_WORKSPACE_NAME`, `LONCA_WORKSPACE_PATH`, `LONCA_DEFAULT_BRANCH`, `LONCA_PROJECT` and `LONCA_PROJECT_SLUG` are set too.

For a server on any other port, ask the Lead to forward it. Its tools `forward_port`, `close_port` and `list_ports` forward a port on your `localhost` to one in the virtual machine, using the same number when that's free and another when it isn't, and say what's listening there. A forward never takes Lonca's own port, one it has run on before, 4700 or 5173. A page served there could read the token your browser keeps for Lonca, or install a service worker that takes over Lonca's pages whenever Lonca is back on that port. Nor does a forward take port 1455, where Codex's sign-in comes back, a port of any workspace's ten, one that browsers won't open, such as 6000, or one that something on your computer is already listening on, on any address. Forwards are linked below the first port at the top of a conversation, and in the menu beside the trash icon, where you can close them. They close when the workspace stops, including for a rebuild, archive or delete. `sbx` publishes a sandbox's ports again whenever it starts, and won't start it if one of them has been taken meanwhile, so if one stopped some other way, as with `sbx stop`, Lonca closes its forwards before it next starts it.

## Archiving and deleting

To close a workspace, use the trash icon on its row in the sidebar or at the top right of its panel. This archives it: its runtime is shut down and removed, and so are its checkout's files, so anything not committed is lost. Its git history, with the branch, and its chat are kept. Once its pull request is merged, the side panel offers Archive too. It asks first and shows what's lost, including whether the pull request was merged or closed, and commits on the branch that aren't in it. Once you tick **Don't ask again**, it asks only when an agent is working there or there are uncommitted changes, and when the workspace isn't running, since then they can't be counted. **Ask before archiving** in Settings turns the question back on. Lonca never archives a workspace by itself. Archived workspaces are listed under **N archived** in the sidebar. Open one to restore it, or use its trash icon to delete it for good, along with any commits that were never pushed. Deleting always asks.

## When something goes wrong

If an operation fails or Lonca stops partway through it, the workspace remembers what was requested. Its retry button names that operation: retrying an archive finishes archiving, and retrying a delete finishes deleting. A failed cleanup remains visible until it succeeds. If an archive can't finish, the trash icon offers to delete the workspace instead. Creation and restoration copy only missing files, so retrying after a partial copy preserves edits already made in the workspace. Setup failures have their own status and can be rerun from the Setup tab.

Running agents stay tracked while Docker Sandboxes is unreachable. An accepted Stop is saved and completes when the process can be reached again, including after a Lonca restart. Surviving scripts regain their Stop controls when it reconnects. Shells can also be stopped or restarted, but their old terminal output and input connection cannot be restored; the terminal explains when this happens.

Messages and queue changes are saved before they are accepted. A completed turn keeps its recovery data until all its output has been read and both its transcript and completion state are saved. Interrupted reads and failed writes are retried, and follow-ups wait until completion can be saved. If Ctrl-C cannot save pending conversations or state, Lonca reports the problem and stays running; restore writable storage, then stop it again. If `state.json` or `secrets.json` can't be read at startup, Lonca reports it and doesn't start, so it can't overwrite them. A conversation whose saved file can't be read says so in the chat and keeps its queued messages. Once the file is readable, the chat reloads by itself and any turn being recovered carries on; use Send now for a message that was left waiting. While that file can't be read after a restart, Lonca can't stop that conversation's agent or delete its workspace. Restore access to the file, or stop the runtime with `sbx stop`.

Unread agent output survives workspace restarts. If the runtime stops, start the workspace to recover the remaining conversation before follow-ups run. Rebuilding or archiving first recovers any pending output. Explicit workspace deletion can discard that output once its processes are confirmed stopped, including when an occupied port prevents the old runtime from starting. Background reads, automatically opened terminals, terminal recovery and resize checks leave stopped runtimes stopped. The exception is a read that overlaps an `sbx stop` run outside Lonca: `sbx exec` starts a stopped virtual machine, so it can come back, and stopping it again fixes that. Use Start, send a message, or choose Send now to wake a workspace.

## Signing in

Docker Sandboxes needs a Docker account. **Sign in to Docker** under Settings > Isolation shows a one-time code and a link to Docker's sign-in page, where you approve it. Lonca runs `sbx login` on your computer to do this, so it's the same login `sbx` uses in your terminal, kept by `sbx` itself. Lonca never sees it, and signing in from either one signs in both.

**Sign out of Docker** signs `sbx` out on the whole computer, your terminal included. It also stops every sandbox running on the computer: all of Lonca's workspaces, any agents working in them, and sandboxes that aren't Lonca's. Settings asks before it does. A workspace's files and conversations are kept, and you start it again once you've signed back in, which recovers any agent output left unread.

For the agents, Lonca signs in separately from the CLIs on your computer and leaves those logins alone. Sharing one would break them: both CLIs rotate their refresh tokens, so refreshing a copy would log your computer out.

- **Claude:** open the sign-in page and approve access, and your browser comes back to Lonca by itself. Lonca runs `claude setup-token` out of sight in a small virtual machine of its own and saves the token it creates, which never reaches the page. This needs a Claude subscription; you can use an Anthropic API key instead.
- **Codex:** open the sign-in page and approve access, and your browser comes back to Lonca by itself. Lonca runs `codex login` out of sight in the same place. Signing in this way, Codex also asks OpenAI for an API key. It doesn't use one with this login, so Lonca doesn't keep it. You can use an OpenAI API key instead.
- **GitHub:** agents need a token to fetch private repositories, push and open pull requests. Lonca fetches with it too, also for a repository added by its SSH address, so your own SSH keys aren't involved. Press **Use my gh login** to copy the one from your `gh` CLI, or paste one. Because anything in a virtual machine can use it, a fine-grained token limited to the repositories you use here is the safer choice.

The sign-in pages send your browser to a port on `localhost`, as they do for the CLIs: 1455 for Codex and one the CLI picks for Claude. Lonca listens there for as long as the sign-in lasts and passes the request to the CLI in its virtual machine, so your browser has to be on the computer running Lonca. If it isn't, or the port is taken, the dialog offers a way that doesn't need it: a code to paste for Claude, and a one-time code to enter on the page for Codex (`codex login --device-auth`). If device code login is off for your account, turn it on in ChatGPT under Settings > Security.

None of these ever enter a workspace. Docker Sandboxes' proxy, on your computer, adds them to requests as they leave a virtual machine, and all that's inside is a placeholder. Claude's goes only to `api.anthropic.com`, Codex's only to `chatgpt.com` and `api.openai.com`, and GitHub's only to GitHub's own hosts. Signing in or out takes effect straight away, in workspaces that are already running, though a terminal opened before you first signed in to Claude needs reopening. In a virtual machine, a connected GitHub account is used for GitHub even if the project sets its own `GH_TOKEN`.

On your computer, the Claude and GitHub tokens are in `~/.lonca/secrets.json`, each Codex login is in `~/.lonca/helper-credentials`, and `~/.lonca/boundary` holds what the proxy reads. All are readable only by you and none is mounted into a virtual machine. Lonca renews Codex's logins before they run out.

On a phone, signing in starts with a code to paste for Claude and a one-time code for Codex, since a phone is rarely the computer the sign-in page comes back to.

A project can use a key of its own by setting `CODEX_API_KEY` or `OPENAI_API_KEY` in its environment variables. That one isn't kept out: it goes into the project's virtual machines as it is, where anything in them can read it. Changing or removing it updates the ones running, though a program that already read it keeps what it read. It's used in place of any sign-in, so its limits are its own, and moving a conversation to another sign-in doesn't change what it runs on.

### Several sign-ins

A provider can have more than one sign-in, such as a work and a personal Claude account, each a subscription or an API key. Add one in Settings with **Add another Claude sign-in**, which asks you to name both, so you can tell them apart. With one per provider, nothing else about signing in changes.

A conversation runs on one sign-in at a time, shown beside its model. It can move to another of the same provider at any time, from the model picker, and keep its conversation, because it's the same CLI with another credential. A turn that's running finishes on the sign-in it started on. Moving to another provider still means a new conversation, because the CLIs can't read each other's.

The first sign-in of each provider is its default, for terminals and for anything that doesn't choose. **Make default** in a sign-in's **⋯** menu changes it. Removing a sign-in deletes its credentials and moves conversations on it to the default, which each says. It can't be removed while one is running on it.

When a conversation reaches a usage limit, its banner says which sign-in's it was and offers to **Continue on** another that's signed in, with the conversation so far. The move is recorded in the conversation. One that reached its limit isn't offered again until the limit ends, or for an hour if the service didn't say when. To have Lonca do this without you, turn on **Move conversations here by themselves** for the sign-ins it may move to. It's off for every sign-in until you turn it on, since an API key is billed per token. Turning it off stops conversations moving there, and those already on it stay until you move them. It only happens at a usage limit, never because a service refused a sign-in or after you've pressed Stop, and it's recorded in the conversation as well. You're only told about a limit when there's nowhere left to move.

Every sign-in has a placeholder and a file of its own, and every virtual machine has them all, so which one a process uses depends only on the placeholder it's given. A sign-in you add reaches workspaces that are already running.

Claude signs in with whichever account your browser is using on claude.ai. To add a different account, switch accounts there first, or open the sign-in page in a private window. Each provider's terms decide how its accounts may be used, including limits. Lonca doesn't check them for you.

## Disk space

Everything a workspace's agents install or download stays on your computer's disk until the workspace goes. Each virtual machine has two disks, kept as files that start at about 6 MB each and grow as they're used: up to 20 GB for the machine's own files, and up to 10 GB for its Docker engine's images and containers. Workspaces don't share these, so a browser or Docker image that five of them download takes up five times the space. What's deleted inside a virtual machine usually comes back within about a minute. Checkouts are on your computer too, along with anything like `node_modules` in them. Each has its own copy of the repository's history, though on APFS these copies share disk space until they change.

To get space back, archive workspaces you aren't using, which removes the virtual machine and all of the checkout but its history. Rebuilding one from its **⋯** menu replaces only the virtual machine, which keeps the checkout and conversations but loses everything else on its disks, such as its home directory and Docker images. If several workspaces need the same heavy tools, installing them once in a project's template, as described under [Limitations](#limitations), means they share one copy, though not of Docker images, which a template can't hold.

A template takes up about 1.5 GB beyond what templates share. Lonca removes one when it's replaced, when it starts and finds an older one, and when the last virtual machine made from it goes. Until then a workspace holds on to the template it was made from, which it needs to be saved as a template itself.

When less than 20 GB is left, the status at the foot of the sidebar says **Disk almost full**, and Settings says how much is left. It goes by the disk your home folder is on, where Docker Sandboxes keeps virtual machines' disks, or the one `LONCA_HOME` is on if that has less room.

If your computer's disk does fill up, virtual machines' disks can turn read-only and agents fail in confusing ways, whereas a virtual machine that only fills its own disk just reports that it's out of space. Free up some space, then restart the affected workspaces with `sbx stop <virtual machine>` and **Start** in Lonca. If one's still stuck, rebuild it.

## Limitations

- Codex replies appear when each message is complete, rather than word by word.
- Lonca doesn't yet check that a Lead's changes were reviewed before it opens a pull request. The playbook asks for it, and the Lead's report is its own account.
- Nothing resumes by itself when a usage limit ends. Use **Try now**, **Continue on** another sign-in, or tell the Lead to carry on.
- Agents share one checkout, so two running tests at once can collide over build output or ports. The playbook tells the Lead to stagger them.
- `sudo apt-get install` works in a workspace, but only lasts until the workspace is rebuilt. To keep system packages, install them in a workspace and save its virtual machine as a template, using the name shown when the workspace opened. Then enter the template's tag as the project's custom template, and rebuild workspaces to move them onto it:

  ```sh
  sbx stop <virtual machine>
  sbx template save <virtual machine> my-template:1
  ```

- Sign-in tokens reach the proxy through `sbx secret set-custom`, which Docker marks as experimental, because its built-in Anthropic and OpenAI services can't take one for a single sandbox. A future version of Docker Sandboxes could change it. A removed sign-in's placeholder stays registered on virtual machines until they're rebuilt, with nothing behind it.
- Local repositories with no remote can't be pushed from a workspace. Their commits stay on the branch in the workspace's checkout, `~/.lonca/projects/<project>/workspaces/<name>`, even once it's archived, and you can fetch them from there.
- Lonca is for one person on one computer. To use it from elsewhere, forward its port over SSH instead of exposing it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4700` | Port for the web app. |
| `LONCA_HOME` | `~/.lonca` | Where projects, checkouts and settings are stored. |
| `LONCA_FIRST_PORT` | `20000` | First port published for workspaces. |
| `LONCA_NO_OPEN` | | Set to `1` to skip opening a browser. |
| `LONCA_NO_NOTIFY` | | Set to `1` to never show notifications, whatever Settings says. |

## Removing Lonca

To remove Lonca completely, delete `~/.lonca` and the virtual machines and templates it created:

```sh
sbx ls -q | grep '^lonca-' | xargs sbx rm --force
sbx template ls --json | jq -r '.[] | select(.repository == "docker.io/library/lonca-sandbox").id' | sort -u | xargs -n1 sbx template rm --force
```

A template that was replaced while a workspace was on it stays with only the name `sandbox-kit-assembled:<hash>`. `sbx template ls` lists those, and `sbx template rm --force <image ID>` removes one.
