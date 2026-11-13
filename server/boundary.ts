import path from 'node:path';
import { defaultProfile, projectBringsKey } from '../shared/profiles.ts';
import type { AgentId, Profile, Project } from '../shared/types.ts';
import { paths } from './config.ts';
import { geminiKeyFile, readGeminiLogin } from './gemini-login.ts';
import type { ProxySecret, SandboxSetup } from './sandbox.ts';
import { boundaryValue, claudeCredential, state } from './store.ts';

// A virtual machine never holds a credential. Docker Sandboxes' proxy, on this computer, adds them
// to requests on their way out, so all that's inside is a placeholder for it to swap. It reads each
// one from a file for every request, so refreshed credentials reach running VMs without copying
// secrets there. Each sign-in has a placeholder and a file of its own, and every VM has them all,
// so which one a process uses is only a matter of the placeholder it's given.

// The first sign-in of each provider keeps the placeholder it had before there could be several,
// so that VMs and conversations from then carry on.
const FIRST_PLACEHOLDERS: Record<AgentId, string> = {
  claude: 'sk-ant-oat01-lonca-placeholder',
  codex: 'oai-oat01-lonca-placeholder',
  gemini: 'goog-lonca-placeholder',
};

const PLACEHOLDER_PREFIXES: Record<AgentId, string> = {
  claude: 'sk-ant-oat01-lonca',
  codex: 'oai-oat01-lonca',
  gemini: 'goog-lonca',
};

// A Google account's access token can do whatever its cloud-platform scope allows, so it's swapped
// only where Gemini sends it, and a key only where a key goes. So a Gemini sign-in has a placeholder
// and a file for each kind, and the one it isn't using is empty, which lets it change kind without
// telling the VMs that have its placeholders.
const HOSTS: Record<AgentId, string[]> = {
  claude: ['api.anthropic.com'],
  codex: ['chatgpt.com', 'api.openai.com'],
  gemini: ['cloudcode-pa.googleapis.com'],
};
const GEMINI_KEY_HOSTS = ['generativelanguage.googleapis.com'];
const GEMINI_KEY_PREFIX = 'goog-key-lonca';

/**
 * What stands in for a sign-in's credential in a VM. None of them contains another, so the proxy
 * can't swap a piece of one for the wrong credential.
 */
export function placeholderFor(profile: Pick<Profile, 'id' | 'agent'>): string {
  if (profile.id === profile.agent) return FIRST_PLACEHOLDERS[profile.agent];
  const suffix = profile.id.slice(profile.agent.length + 1);
  return `${PLACEHOLDER_PREFIXES[profile.agent]}-profile-${suffix}-placeholder`;
}

/** What stands in for a Gemini sign-in's API key, beside `placeholderFor`'s for a Google account's token. */
export function geminiKeyPlaceholderFor(profile: Pick<Profile, 'id' | 'agent'>): string {
  if (profile.id === profile.agent) return `${GEMINI_KEY_PREFIX}-placeholder`;
  return `${GEMINI_KEY_PREFIX}-profile-${profile.id.slice(profile.agent.length + 1)}-placeholder`;
}

const fileFor = (name: string) => path.join(paths.boundary, name);

/** What the proxy is told about a sign-in: one credential, or for Gemini, one of each kind. */
export function profileSecrets(profile: Pick<Profile, 'id' | 'agent'>): ProxySecret[] {
  const own = { hosts: HOSTS[profile.agent], placeholder: placeholderFor(profile), file: fileFor(profile.id) };
  if (profile.agent !== 'gemini') return [own];
  return [own, { hosts: GEMINI_KEY_HOSTS, placeholder: geminiKeyPlaceholderFor(profile), file: fileFor(geminiKeyFile(profile.id)) }];
}

/** sbx plants GitHub's placeholder itself. Its built-in Anthropic service only sends API keys, and refuses a sign-in token. */
export function proxySecrets(): ProxySecret[] {
  return [{ service: 'github', file: fileFor('github') }, ...state.profiles.flatMap(profileSecrets)];
}

/** What a process in a VM needs for this Claude sign-in. Which variable depends on which kind of credential the proxy will put in. */
export function claudeEnv(profile: Pick<Profile, 'id' | 'agent'> | undefined): string[] {
  const token = profile && claudeCredential(profile.id);
  if (!profile || !token) return [];
  return [`${token.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'}=${placeholderFor(profile)}`];
}

/**
 * What a process in a VM needs for this Gemini sign-in: the variables for the kind of credential
 * the proxy will put in, with the other kind's emptied. The CLI's settings in the VM choose the
 * kind from `LONCA_GEMINI_AUTH`, so that a repository's own settings can't choose another.
 */
export function geminiEnv(profile: Pick<Profile, 'id' | 'agent'> | undefined): string[] {
  const login = profile && readGeminiLogin(profile.id);
  if (!profile || !login) return [];
  return login.kind === 'google'
    ? ['GOOGLE_GENAI_USE_GCA=true', `GOOGLE_CLOUD_ACCESS_TOKEN=${placeholderFor(profile)}`, 'GEMINI_API_KEY=', 'LONCA_GEMINI_AUTH=oauth-personal']
    : [`GEMINI_API_KEY=${geminiKeyPlaceholderFor(profile)}`, 'GOOGLE_GENAI_USE_GCA=', 'GOOGLE_CLOUD_ACCESS_TOKEN=', 'LONCA_GEMINI_AUTH=gemini-api-key'];
}

/** A project's own Gemini key, which isn't one for the proxy to swap. */
export function projectGeminiKey(project: Project | undefined): string | undefined {
  const env = project?.settings.env ?? {};
  return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined;
}

// The CLI only reads a Gemini API key from GEMINI_API_KEY, so a project's GOOGLE_API_KEY goes in
// there too. Vertex AI reads GOOGLE_API_KEY itself, and then the CLI chooses from the project's
// own variables.
function projectGeminiEnv(project: Project): string[] {
  if (project.settings.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') return [];
  return [`GEMINI_API_KEY=${projectGeminiKey(project)}`, 'LONCA_GEMINI_AUTH=gemini-api-key'];
}

/**
 * The placeholders a process is given: for an agent's own provider, those of the sign-in it runs
 * on, and otherwise those of each provider's default sign-in, as for terminals, scripts and what
 * agents start. A project's own Gemini key goes in place of any Gemini sign-in. Codex reads its
 * credential from a file, which is set up apart.
 */
export function placeholderEnv(project?: Project, profile?: Pick<Profile, 'id' | 'agent'>): string[] {
  const of = (agent: AgentId) => (profile?.agent === agent ? profile : defaultProfile(state.profiles, agent));
  const gemini = project && projectGeminiKey(project) ? projectGeminiEnv(project) : geminiEnv(of('gemini'));
  return [...claudeEnv(of('claude')), ...gemini];
}

const CODEX_STORE = 'cli_auth_credentials_store = "file"';
// A ChatGPT sign-in is used at this address. Codex keeps its built-in provider rather than a custom
// one because it refuses to resume a conversation under a provider that's no longer configured.
const CHATGPT_URL = 'https://chatgpt.com/backend-api/codex';
const API_URL = 'https://api.openai.com/v1';
const CODEX_ADDRESS = `openai_base_url = "${CHATGPT_URL}"`;

/** Whether the proxy sends an API key for this Codex sign-in, rather than a ChatGPT login. */
function codexUsesKey(profile: Pick<Profile, 'id'>): boolean {
  return Boolean(boundaryValue(profile.id)?.startsWith('sk-'));
}

// Agents can start at the same moment, and a CLI reading these mustn't find them missing or half
// written. So they're replaced whole, and only when they differ. That also drops a link to the old
// shared login, or a login someone ran by hand. Only Lonca's lines of config.toml change, because
// Codex adds its own there, such as which directories it trusts. One that says where to send
// requests or how to keep the login some other way is someone's own, so it stays.
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
rest=$(cat "$HOME/.codex/config.toml" 2>/dev/null | grep -vxF -e "$1" -e "$2" || true)
case "$rest" in
  *model_provider*|*openai_base_url*|*cli_auth_credentials_store*) exit 0 ;;
esac
wanted="$1"
[ -z "$3" ] || wanted="$wanted
$3"
[ -z "$rest" ] || wanted="$wanted
$rest"
replace "$HOME/.codex/config.toml" "$wanted"
`;

/** A project's own key, which isn't one for the proxy to swap. */
export function projectCodexKey(project: Project): string | undefined {
  const env = project.settings.env;
  return env.CODEX_API_KEY || env.OPENAI_API_KEY || undefined;
}

/**
 * Sets Codex up in a VM, for when it boots and before each Codex turn, since the kind of sign-in can
 * change. What's written is for the default sign-in, for terminals. An agent's turn says its own.
 */
export function codexSetup(project: Project): SandboxSetup {
  const projectKey = projectCodexKey(project);
  const profile = defaultProfile(state.profiles, 'codex');
  const usesKey = projectKey || (profile && codexUsesKey(profile));
  return {
    command: ['bash', '-c', CODEX_SETUP, 'lonca-codex-setup', CODEX_STORE, CODEX_ADDRESS, usesKey ? '' : CODEX_ADDRESS],
    // Codex ignores OPENAI_API_KEY in its environment, so a project's key goes in this file. It's
    // sent this way because anything on this computer can read the arguments of a command.
    stdin: JSON.stringify({ OPENAI_API_KEY: projectKey ?? placeholderFor(profile ?? { id: 'codex', agent: 'codex' }) }),
  };
}

/**
 * What one Codex process needs to run on this sign-in: its placeholder, which goes in place of the
 * one in auth.json, and the address for its kind of sign-in, since VMs have both kinds at once.
 * A project's own key goes in place of any sign-in, so it gets neither.
 */
export function codexTurn(profile: Pick<Profile, 'id' | 'agent'> | undefined, project: Project): { env: string[]; config: string[] } {
  if (!profile || projectCodexKey(project)) return { env: [], config: [] };
  return {
    env: [`CODEX_API_KEY=${placeholderFor(profile)}`],
    config: ['-c', `openai_base_url=${JSON.stringify(codexUsesKey(profile) ? API_URL : CHATGPT_URL)}`],
  };
}

/** The sign-in a turn of this conversation runs on, unless the project brings its own key in place of any. */
export function turnProfile(agent: AgentId, profileId: string, project: Project | undefined): string | undefined {
  return projectBringsKey(agent, project) ? undefined : profileId;
}
