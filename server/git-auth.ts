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

/** Credentials for an initial HTTPS GitHub import, scoped again by Git's credential URL. */
export function githubGitAuth(remoteUrl: string | null | undefined, token: string | undefined): { args: string[]; env: NodeJS.ProcessEnv } {
  if (token && remoteUrl) {
    try {
      const url = new URL(remoteUrl);
      if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.port) {
        return {
          args: ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=${GITHUB_HELPER}`],
          env: { LONCA_GITHUB_TOKEN: token },
        };
      }
    } catch { /* SSH shorthand and local paths use the host's own authentication. */ }
  }
  return { args: [], env: {} };
}
