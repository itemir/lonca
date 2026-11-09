// Git invokes this through a shell. The token stays in the child's environment, never
// in its command line or the repository config that workspaces can read later.
const GITHUB_HELPER = `!f() {
  [ "$1" = get ] || return 0
  protocol= host=
  while IFS='=' read -r key value; do
    case "$key" in protocol) protocol="$value";; host) host="$value";; esac
  done
  case "$protocol://$host" in
    https://github.com|https://github.com:443)
      printf 'username=x-access-token\\npassword=%s\\n' "$LONCA_GITHUB_TOKEN";;
  esac
}; f`;

// GitHub's SSH addresses, which workspaces rewrite in the same way (template/gitconfig).
const GITHUB_SSH = ['git@github.com:', 'ssh://git@github.com/'];

function isGithubHttps(remoteUrl: string): boolean {
  try {
    const url = new URL(remoteUrl);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port;
  } catch {
    return false;
  }
}

/**
 * Credentials for fetching from GitHub over HTTPS, scoped again by Git's credential URL. An SSH
 * address goes over HTTPS too, as it does in workspaces, so that the token is what's used rather
 * than this computer's own SSH. Without a token, or for anything else, that's left to the host.
 */
export function githubGitAuth(remoteUrl: string | null | undefined, token: string | undefined): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!token || !remoteUrl) return { args: [], env: {} };
  const ssh = GITHUB_SSH.some((prefix) => remoteUrl.startsWith(prefix));
  if (!ssh && !isGithubHttps(remoteUrl)) return { args: [], env: {} };
  return {
    args: [
      '-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=${GITHUB_HELPER}`,
      ...(ssh ? GITHUB_SSH.flatMap((prefix) => ['-c', `url.https://github.com/.insteadOf=${prefix}`]) : []),
    ],
    env: { LONCA_GITHUB_TOKEN: token },
  };
}
