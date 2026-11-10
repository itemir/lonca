# Lonca

Run a team of Claude and Codex coding agents from your browser. Each workspace is a virtual machine of its own, so agents work without stopping to ask permission.

Lonca is new: version 0.1, from one author, and so far only run on Macs with Apple silicon.

![A Lead has Claude build a change and Codex review it, each in a tab of its own, then the workspace's terminal shows that its credentials are only placeholders](docs/demo.gif)

*Lonca* is Turkish for guild: craftspeople working on separate pieces under one roof.

## Why Lonca

Lonca is for developers who already use Claude Code or Codex, and want several agents at work at once without handing them the computer. Each task gets a workspace, with a branch and a checkout of its own, and you review the changes and merge a pull request at the end. Lonca is influenced by [Conductor](https://conductor.build), a Mac app that works this way, with agents in git worktrees on your Mac. It differs in three ways that mattered enough for us to build it.

**Every workspace is a virtual machine, so agents work without asking.** Claude runs with `--permission-mode bypassPermissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`, because the VM is the boundary. Each workspace is a Linux virtual machine from [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), with its own kernel, and sees its own checkout and nothing else on your computer. Agents get `sudo` and a Docker engine of their own, and neither reaches past the VM. Your Claude, Codex and GitHub credentials stay outside too: Docker Sandboxes' proxy adds them to requests as they leave, so agents can use them but never see them. [How isolation works](docs/isolation.md) has the details.

**A Lead that can run a team, if you want one.** Every workspace starts with a Lead, an agent you hand the whole task to. It can do the work itself, or bring in agents on any Claude or Codex model, each in a tab of its own: Claude to build and Codex to review, say. It reads what they report, sends work back, and tells you when it's done. You can watch any agent and talk to it directly, and a playbook you can edit tells Leads how you like work done. If you'd rather direct agents yourself, open conversations of your own, or close the Lead.

**It runs in a browser.** Lonca is a small server with a web page to work from, so it needn't run on the computer in front of you. Run it on an always-on machine and reach it over SSH, and agents keep working while your laptop sleeps. They work inside their VMs, not in the page, so they also carry on when you close the tab, and through a restart of Lonca.

## What you get

- **Workspaces** from GitHub repositories or folders on your computer, as many as you need, each with a branch and a virtual machine. Archive one when you're done, and its branch and conversations are kept.
- **Claude and Codex side by side**, in several conversations per workspace, each on its own model and effort level.
- **Review and merge.** Read the branch's diff, follow its checks, have an agent open the pull request, and merge it from the side panel.
- **Previews.** Each workspace publishes ten ports on your `localhost`, and the Lead can forward any other.
- **Terminals** in every workspace.
- **Several sign-ins**, such as a work and a personal account. When one reaches its usage limit, carry on with another.
- **Open source, with no account of ours.** Lonca uses your own Claude, Codex, Docker and GitHub accounts.

## Get started

You need a Mac with Apple silicon and macOS 14 or later, [Node.js](https://nodejs.org) 22.18 or newer, git, and [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/), which is free and needs a Docker account but not Docker Desktop. Docker Sandboxes also runs on Ubuntu 24.04 or later with KVM, so Lonca should too, but nobody has tried it yet. Windows isn't supported.

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

- **Anything in a workspace can use your sign-ins, though not read them.** It can push wherever your GitHub token can, spend your Claude and Codex usage, and send your code anywhere on the internet. It can also read the project's own variables. Give GitHub a fine-grained token without Administration or Workflows permission.
- **A workspace's checkout is a folder on your computer.** Running git or an editor there runs config an agent could have written, so treat it like a repository from a stranger.
- **Workspaces start with nothing from your computer.** Your own Claude and Codex settings, skills and MCP servers stay behind, and a project that only builds on macOS, such as an iOS app, can't build in one.
- **They take room.** Each can grow to about 30 GB of disk and, unless the project sets limits, use up to half your computer's memory. A team of agents also reaches your plans' usage limits sooner.
- **Lonca is for one person.** It only listens on `127.0.0.1`. To use it from another computer, start it there with `LONCA_NO_OPEN=1 npm start`, and connect with `ssh -L 4700:127.0.0.1:4700 <that computer>`, keeping the same port at both ends.

## Learn more

- [Using Lonca](docs/guide.md): the Lead, sign-ins, project settings, ports, archiving, disk space, configuration and removing Lonca.
- [How isolation works](docs/isolation.md): what keeps workspaces apart, and what they share.
- [Development](docs/development.md): running from source, the tests, and how Lonca is put together.

## License

[MIT](LICENSE)
