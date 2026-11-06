#!/bin/bash
# build.sh <directory this is in>
# Runs as root in a fresh VM from Docker's own template, to make the one Lonca's workspaces start
# from. Docker's already has git, gh, Node, Python, Go, Java, compilers, ripgrep and a Docker engine.
set -eu
here="$1"
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq --no-install-recommends fd-find tree >/dev/null
ln -sf /usr/bin/fdfind /usr/local/bin/fd
rm -rf /var/lib/apt/lists/*

npm install -g --silent --prefix /usr/local @anthropic-ai/claude-code @openai/codex
npm cache clean --force --silent

install -m 644 "$here/gitconfig" /etc/gitconfig
install -m 755 "$here/lonca-pty" "$here/lonca-run" /usr/local/bin/
install -d -o agent -g agent -m 755 /var/tmp/lonca
