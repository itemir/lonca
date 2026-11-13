# How isolation works

Every workspace gets a virtual machine from [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/). It can see its own checkout and a private home directory, and nothing else on your computer.

| Boundary | How it's enforced |
| --- | --- |
| Kernel | Its own, behind a hypervisor. |
| Filesystem | Its checkout and a directory for its conversations are mounted. The home directory is on the VM's own disk. |
| Credentials | None inside. A proxy on your computer adds them to requests as they leave. |
| Privileges | Agents have `sudo` and a Docker engine of their own, which stop at the VM. |
| Network | Every connection goes through a proxy on your computer. Rules on each sandbox block your computer, your LAN, cloud metadata addresses and other workspaces, leaving the public internet. |
| Published ports | On `127.0.0.1` only: a workspace's ten, and any its Lead forwards. A forward can't take Lonca's own ports, Codex's sign-in port, another workspace's or one in use, and closes when the workspace stops. |
| Resources | Optional memory and CPU limits. |
| The Lonca server | Listens on `127.0.0.1` only and requires a token, with checks against DNS rebinding and cross-site requests. The token is kept in the page's per-origin storage, not a cookie, so servers on published ports never see it. During a sign-in it also listens on the port the sign-in page comes back to, also on `127.0.0.1`, which passes on only a request with that sign-in's random state. |
| Host git | On your computer, Lonca runs git only on its own copy of each repository, which no virtual machine mounts, on a local repository you add, and on a new workspace's checkout before its virtual machine has seen it. After that, git runs on a checkout only inside its virtual machine, so an agent's git hooks and config can't execute outside it. |
| SSH keys | Agents don't get your SSH agent. Docker Sandboxes 0.50 gives a virtual machine the SSH agent of whoever last ran a command in it, so every command Lonca runs there brings an agent with no keys. On that version, running `sbx exec` on a Lonca virtual machine from a terminal lets it use your keys until Lonca's next command in it. Version 0.51 didn't lend keys this way when tested, but its forwarding setting is still on by default. To rule it out on any version, run `sbx settings set ssh.agentForwardingEnabled false` and `sbx daemon restart`. |

The network rules above apply to **Internet only**, the default. Choosing **Internet and this computer** allows host and local-network services, including ports published by other workspaces through `host.docker.internal`, even across projects. Use it only when you trust the workspace with those services.

Agents run with their own permission prompts turned off, since the workspace is the sandbox. Lonca's helper, which does the signing in, is a small virtual machine of its own. It starts when it's first needed, agents never run in it, and it only holds a sign-in while it's making or renewing one.

## What is shared

- **Within a project,** workspaces share no git data. Each has its own copy of the repository, so an agent can't change another workspace's settings, hooks, stashes or branches. They do share the remote: with your GitHub access, as below, an agent could push over another workspace's branch there.
- **Credentials.** Nothing in a virtual machine can read them, and the proxy won't send them anywhere else, but anything in one can use them while it runs. An agent can act as you on GitHub and spend your Claude, Codex and Gemini usage, across every project. A Google account's access token is good for more than Gemini, such as Google Cloud projects you can reach, so the proxy adds it only to requests to `cloudcode-pa.googleapis.com`, where Gemini sends it, and a Gemini key only to `generativelanguage.googleapis.com`. The refresh token stays on your computer. The client ID and secret it's renewed with are the Gemini CLI's own, which Google publishes in every copy of the CLI, so they're in every workspace too, but they aren't yours. The login `gh` gives you has the `admin:public_key` scope, which would let an agent add an SSH key to your account, and that would outlive the workspace. Use a fine-grained token if you can.
- **Between a Lead's agents.** Keeping them apart stops them influencing each other by accident. It isn't a security boundary. They run as the same user in the same workspace, so one that goes looking can read another's conversation, push to GitHub, or change files the Lead reads, including ones that instruct it. The Lead is told to treat what agents report as evidence rather than instructions, but that's a request to a model, not a control.
- **Outbound internet.** An agent can send anything it can read to the internet. It could read your code and any variables in the project's settings, but not your sign-ins or your computer's other files.
- **Ports on your `localhost`.** A port the Lead forwards is one of your computer's for as long as it's forwarded. A program that starts on it meanwhile may not notice: on macOS it can still listen on `0.0.0.0`, `::` or `::1`, but connections to `127.0.0.1`, and sometimes `localhost`, reach the virtual machine instead. That includes a sign-in page sending your browser back to a CLI on your computer. Close forwards you no longer need.
- **Your browser and clipboard, from a virtual machine.** Docker Sandboxes lets processes in a VM open links in your browser (`sbx settings set browser.enabled false` stops that for every sandbox) and write to your clipboard.
- **Be careful on your computer.** Checkouts live in `~/.lonca/projects/<project>/workspaces/<name>` and work with your local tools, but running `git` in one, or opening it in an editor, reads config an agent could have written. Treat a checkout an agent has touched as untrusted code, as you would any repository you download.
