# Where Docker Sandboxes isn't available, every Lonca workspace runs in a container built from
# this image, and wherever it is, Lonca's helper container does. To add toolchains for a project, build your own image `FROM` this one and set
# it in the project's settings.
FROM node:24-trixie-slim

ARG LONCA_UID=1000
ARG LONCA_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    DISABLE_AUTOUPDATER=1 \
    CODEX_DISABLE_UPDATE_CHECK=1 \
    GIT_TERMINAL_PROMPT=0 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    LANG=C.UTF-8 \
    TERM=xterm-256color

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl fd-find file git gnupg iptables jq less make \
      nano openssh-client pkg-config procps python3 python3-pip python3-venv ripgrep tree \
      unzip util-linux vim-tiny wget xz-utils zip \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force

# The base image's `node` user would otherwise claim uid 1000.
RUN userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd -o -g "${LONCA_GID}" lonca \
 && useradd -o -m -u "${LONCA_UID}" -g "${LONCA_GID}" -s /bin/bash lonca

COPY gitconfig /etc/gitconfig
COPY bashrc /home/lonca/.bashrc
COPY --chmod=755 lonca-entrypoint lonca-run /usr/local/bin/

# Codex credentials live on a directory shared by all workspaces, so signing in once
# is enough and a token refresh in one workspace reaches the others. Claude uses a
# long-lived token passed in by the server instead. The rest of each workspace's
# home directory stays private to that workspace.
RUN install -d -o lonca -g lonca -m 700 /var/lib/lonca/credentials /var/lib/lonca/credentials/codex \
 && install -d -o lonca -g lonca -m 755 /var/tmp/lonca \
 && install -d -o lonca -g lonca -m 700 /home/lonca/.claude /home/lonca/.codex \
 && echo '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}' > /home/lonca/.claude.json \
 && echo 'cli_auth_credentials_store = "file"' > /home/lonca/.codex/config.toml \
 && chown -hR lonca:lonca /home/lonca

ENTRYPOINT ["/usr/local/bin/lonca-entrypoint"]
CMD ["sleep", "infinity"]
