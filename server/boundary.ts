import path from 'node:path';
import type { Project } from '../shared/types.ts';
import { paths } from './config.ts';
import type { ProxySecret, SandboxSetup } from './sandbox.ts';
import { boundaryValue, getSecrets } from './store.ts';

// A virtual machine never holds a credential. Docker Sandboxes' proxy, on this computer, adds them
// to requests on their way out, so all that's inside is a placeholder for it to swap. It reads each
// one from a file for every request, so signing in or out reaches running VMs with nothing else to
// do.

const CLAUDE_PLACEHOLDER = 'sk-ant-oat01-lonca-placeholder';
const CODEX_PLACEHOLDER = 'oai-oat01-lonca-placeholder';

const fileFor = (name: Parameters<typeof boundaryValue>[0]) => path.join(paths.boundary, name);

/** sbx plants GitHub's placeholder itself. Its built-in Anthropic service only sends API keys, and refuses a sign-in token. */
export function proxySecrets(): ProxySecret[] {
  return [
    { service: 'github', file: fileFor('github') },
    { hosts: ['api.anthropic.com'], placeholder: CLAUDE_PLACEHOLDER, file: fileFor('claude') },
    { hosts: ['chatgpt.com', 'api.openai.com'], placeholder: CODEX_PLACEHOLDER, file: fileFor('codex') },
  ];
}

/** What a process in a VM needs for Claude. Which variable depends on which kind of credential the proxy will put in. */
export function placeholderEnv(): string[] {
  const token = getSecrets().claudeToken;
  if (!token) return [];
  return [`${token.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'}=${CLAUDE_PLACEHOLDER}`];
}

const CODEX_CONFIG = 'cli_auth_credentials_store = "file"';
// A ChatGPT sign-in is used at this address. Codex keeps its built-in provider rather than a custom
// one because it refuses to resume a conversation under a provider that's no longer configured.
const CODEX_CONFIG_CHATGPT = `${CODEX_CONFIG}\nopenai_base_url = "https://chatgpt.com/backend-api/codex"`;

// Agents can start at the same moment, and a CLI reading these mustn't find them missing or half
// written. So they're replaced whole, and only when they differ. That also drops a link to the old
// shared login, or a login someone ran by hand. A config.toml that's neither of Lonca's two is
// someone's own, so it stays.
const CODEX_SETUP = String.raw`
set -eu
mkdir -p "$HOME/.codex"
replace() {
  [ ! -L "$1" ] && [ "$(cat "$1" 2>/dev/null || true)" = "$2" ] && return 0
  new=$(mktemp "$1.XXXXXX")
  printf '%s\n' "$2" > "$new"
  mv -f "$new" "$1"
}
replace "$HOME/.codex/auth.json" "$(cat)"
case "$(cat "$HOME/.codex/config.toml" 2>/dev/null || true)" in
  ''|"$1"|"$2") replace "$HOME/.codex/config.toml" "$3" ;;
esac
`;

/** A project's own key, which isn't one for the proxy to swap. */
export function projectCodexKey(project: Project): string | undefined {
  const env = project.settings.env;
  return env.CODEX_API_KEY || env.OPENAI_API_KEY || undefined;
}

/** Sets Codex up in a VM, for when it boots and before each Codex turn, since the kind of sign-in can change. */
export function codexSetup(project: Project): SandboxSetup {
  const projectKey = projectCodexKey(project);
  const usesKey = projectKey || boundaryValue('codex')?.startsWith('sk-');
  return {
    command: ['bash', '-c', CODEX_SETUP, 'lonca-codex-setup', CODEX_CONFIG, CODEX_CONFIG_CHATGPT, usesKey ? CODEX_CONFIG : CODEX_CONFIG_CHATGPT],
    // Codex ignores OPENAI_API_KEY in its environment, so a project's key goes in this file. It's
    // sent this way because anything on this computer can read the arguments of a command.
    stdin: JSON.stringify({ OPENAI_API_KEY: projectKey ?? CODEX_PLACEHOLDER }),
  };
}
