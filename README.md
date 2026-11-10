# Lonca

Lonca lets you run a team of Claude and Codex coding agents from your browser. Each workspace gets its own virtual machine, so agents don't have to stop and ask for permission.

Lonca is still early (version 0.1, one author), and so far it has only run on Macs with Apple silicon.

![A Lead has Claude build a change and Codex review it, each in its own tab, then the workspace's terminal shows that its credentials are only placeholders](docs/demo.gif)

*Lonca* (pronounced lon-jaah) means guild in Turkish, as in craftspeople working on separate pieces under one roof.

## Why Lonca

Lonca is for developers who already use Claude Code or Codex (or potentially others) and want several agents at work at once, with or without a lead, each workspace in its own VM based on Docker Sandboxes. You can have a lead agent spin up others and assign tasks, review their work, approve or push back, but using a lead agent is optional and you can assign all tasks yourself. If you let the lead agent work through others, you can review and watch the interaction.

Lonca is influenced by [Conductor](https://conductor.build), a Mac app that works this way, with agents in git worktrees on your Mac. It differs in three ways that mattered enough for us to build it.

### Every workspace is a VM

Each workspace is a Linux VM from [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), with its own kernel. It sees its own checkout and nothing else on your computer, and all the agents in the workspace share that VM. Because the VM is the boundary, Claude runs with `--permission-mode bypassPermissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`. Agents also get `sudo` and a Docker engine, but only inside the VM.

Your Claude, Codex and GitHub credentials never go into the VM, only placeholders do, as you can see at the end of the GIF. Docker Sandboxes' proxy on your computer swaps in the real ones as requests go out. See [How isolation works](docs/isolation.md) for the details.

### A Lead that can run a team, but that is optional

Every workspace starts with a Lead, and you can delegate the entire task to it. It can do the work itself if it's small, or bring in agents on any Claude or Codex model, each in a separate tab. You could have Claude build and Codex review, for example. The Lead reads their reports and sends work back if needed. When everything is done, it tells you. You can watch any agent and talk to it directly, and if you'd rather direct the agents yourself, open your own conversations or close the Lead.

You can customize the playbook that tells the Lead how you like work done, and a project can have its own.

### Controlled from a browser

Lonca is just a small server with a web UI, so it doesn't have to run on the computer you're typing on. Put it on an always-on machine, reach it over SSH, and agents keep working while your laptop sleeps. Since the agents run in their VMs, closing the tab doesn't stop them. Neither does restarting Lonca.

## What else it does

- Several Claude and Codex conversations in one workspace, each with the model and effort level you pick.
- You can read the branch's diff and follow its checks. When it's ready, have an agent open the pull request, then merge it yourself from the side panel.
- Ten ports per workspace are published on your `localhost` for previews, and the Lead can forward any other port.
- Terminals in every workspace.
- Several sign-ins, like a work and a personal account. When one hits its usage limit, you can carry on with another.
- It's open source and there's no Lonca account. It uses your own Claude, Codex, Docker and GitHub accounts.

## Get started

You need a Mac with Apple silicon and macOS 14 or later, [Node.js](https://nodejs.org) 22.18 or newer, git, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), which is free and needs a Docker account but not Docker Desktop. Docker Sandboxes also runs on Ubuntu 24.04 or later with KVM, so Lonca should too, but nobody has tried it yet. If you do, let us know how it goes. Windows isn't supported.

```sh
brew trust docker/tap && brew install docker/tap/sbx
git clone https://github.com/itemir/lonca.git
cd lonca
npm install
npm start
```

Lonca opens in your browser. After that:

1. **Sign in to Docker** in Settings, or run `sbx login`. Lonca then builds the workspace template, which takes a few minutes the first time.
2. **Sign in to Claude, Codex or both**, with a subscription or an API key. The home page walks you through it. To let agents push and open pull requests, connect GitHub in Settings, ideally with a fine-grained token for just the repositories you'll use.
3. **Add a project:** a GitHub repository (`owner/repo` or a URL), or a folder on your computer. If it needs installing, give it a setup script in its settings, such as `npm install`.
4. **Press + next to the project** to create a workspace, and tell its Lead what you want done.

To reopen Lonca later, run `npm start` again. The link it prints contains an access token, and your browser remembers it after the first visit. To update, run `git pull` and `npm install`, then restart it.

## Good to know

- Your sign-ins stay out of the VM, but anything in a workspace can still use them. It can push wherever your GitHub token can and spend your Claude and Codex usage. It can also send your code anywhere on the internet, and read the variables in the project's settings. So give GitHub a fine-grained token without Administration or Workflows permission.
- A workspace's checkout is a folder on your computer. Running git or an editor there runs config an agent could have written, so treat it like a repository from a stranger.
- Workspaces start with nothing from your computer. Your own Claude and Codex settings, skills and MCP servers aren't there, and a project that only builds on macOS, like an iOS app, can't build in one.
- Each workspace can grow to about 30 GB of disk, and it can use up to half your computer's memory unless the project sets limits. A team of agents also burns through your plans' usage faster.
- Lonca is for one person and only listens on `127.0.0.1`. To run it on one computer and use it from another, start it there with `LONCA_NO_OPEN=1 npm start`, then connect with `ssh -L 4700:127.0.0.1:4700 <that computer>`, keeping the same port at both ends.

## Learn more

- [Using Lonca](docs/guide.md): the Lead, sign-ins, project settings, ports, archiving, disk space, configuration and removing Lonca.
- [How isolation works](docs/isolation.md): what keeps workspaces apart, and what they share.
- [Development](docs/development.md): running from source, the tests, and how Lonca is put together.

## License

[MIT](LICENSE)
