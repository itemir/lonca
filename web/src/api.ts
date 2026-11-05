import type {
  AgentId, Attachment, ChangeSet, Checks, FileContent, FileEntry, LoginState, Project, ProjectSettings, SearchHit, Session,
  SessionSnapshot, TerminalInfo, UserItem, Workspace, AppState, AppSettings,
} from '../../shared/types.ts';
import { accessToken } from './auth.ts';

const listeners = { unauthorized: () => {} };

export function onUnauthorized(listener: () => void): void {
  listeners.unauthorized = listener;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${accessToken() ?? ''}` };
}

async function failure(response: Response, fallback: string): Promise<Error> {
  if (response.status === 401) listeners.unauthorized();
  const body = await response.json().catch(() => null);
  return new Error(body?.error ?? fallback);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...authHeaders(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw await failure(response, `The request failed (${response.status})`);
  if (response.status === 202 || response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('json') ? response.json() : response.text()) as Promise<T>;
}

const query = (values: Record<string, string>) => new URLSearchParams(values).toString();

export const api = {
  state: () => request<AppState>('GET', '/state'),

  addProject: (source: { url?: string; path?: string }) => request<Project>('POST', '/projects', source),
  updateProject: (id: string, patch: { name?: string; settings?: Partial<ProjectSettings> }) =>
    request<Project>('PATCH', `/projects/${id}`, patch),
  removeProject: (id: string) => request<void>('DELETE', `/projects/${id}`),
  branches: (id: string) => request<string[]>('GET', `/projects/${id}/branches`),
  createWorkspace: (projectId: string, options: { baseBranch?: string; agent?: AgentId; model?: string; effort?: string; prompt?: string } = {}) =>
    request<{ workspace: Workspace; session: Session }>('POST', `/projects/${projectId}/workspaces`, options),

  renameWorkspace: (id: string, title: string) => request<Workspace>('PATCH', `/workspaces/${id}`, { title }),
  deleteWorkspace: (id: string) => request<void>('DELETE', `/workspaces/${id}`),
  workspaceAction: (id: string, action: 'retry' | 'restore' | 'start' | 'archive' | 'recreate') =>
    request<void>('POST', `/workspaces/${id}/${action}`),

  listFiles: (id: string, path: string) => request<FileEntry[]>('GET', `/workspaces/${id}/files?${query({ path })}`),
  readFile: (id: string, path: string) => request<FileContent>('GET', `/workspaces/${id}/file?${query({ path })}`),
  search: (id: string, q: string, mode: 'names' | 'content') =>
    request<SearchHit[]>('GET', `/workspaces/${id}/search?${query({ q, mode })}`),
  changes: (id: string) => request<ChangeSet>('GET', `/workspaces/${id}/changes`),
  diff: (id: string, path: string, untracked: boolean, oldPath?: string) =>
    request<string>('GET', `/workspaces/${id}/diff?${query({ path, untracked: untracked ? '1' : '0', oldPath: oldPath ?? '' })}`),
  checks: (id: string) => request<Checks>('GET', `/workspaces/${id}/checks`),

  async uploadAttachment(workspaceId: string, file: File): Promise<Attachment> {
    const response = await fetch(`/api/workspaces/${workspaceId}/attachments?${query({ name: file.name })}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) throw await failure(response, `Could not upload ${file.name}`);
    return response.json();
  },

  createTerminal: (workspaceId: string) => request<TerminalInfo>('POST', `/workspaces/${workspaceId}/terminals`),
  restartTerminal: (workspaceId: string, id: string) => request<void>('POST', `/workspaces/${workspaceId}/terminals/${id}/restart`),
  closeTerminal: (id: string) => request<void>('DELETE', `/terminals/${id}`),
  scripts: (workspaceId: string) => request<{ setup: boolean; run: boolean }>('GET', `/workspaces/${workspaceId}/scripts`),
  runScript: (workspaceId: string, kind: 'setup' | 'run') => request<TerminalInfo>('POST', `/workspaces/${workspaceId}/scripts/${kind}`),
  stopScript: (workspaceId: string, kind: 'setup' | 'run') => request<void>('DELETE', `/workspaces/${workspaceId}/scripts/${kind}`),

  createSession: (workspaceId: string, options: { agent?: AgentId; model?: string; effort?: string } = {}) =>
    request<Session>('POST', `/workspaces/${workspaceId}/sessions`, options),
  session: (id: string) => request<SessionSnapshot>('GET', `/sessions/${id}`),
  updateSession: (id: string, patch: { title?: string; agent?: AgentId; model?: string; effort?: string }) =>
    request<Session>('PATCH', `/sessions/${id}`, patch),
  deleteSession: (id: string) => request<void>('DELETE', `/sessions/${id}`),
  sendMessage: (id: string, text: string, attachments: Attachment[]) =>
    request<UserItem>('POST', `/sessions/${id}/messages`, { text, attachments }),
  cancelQueued: (id: string, itemId: string) => request<void>('DELETE', `/sessions/${id}/queue/${itemId}`),
  flushQueue: (id: string) => request<void>('POST', `/sessions/${id}/queue/flush`),
  interrupt: (id: string) => request<void>('POST', `/sessions/${id}/interrupt`),

  updateSettings: (patch: Partial<AppSettings>) => request<AppSettings>('PATCH', '/settings', patch),
  saveClaudeToken: (token: string) => request<{ verified: boolean }>('PUT', '/secrets/claude', { token }),
  saveGithubToken: (token: string) => request<void>('PUT', '/secrets/github', { token }),
  importGithubToken: () => request<void>('POST', '/secrets/github/import'),
  startLogin: (agent: AgentId) => request<LoginState | null>('POST', `/agents/${agent}/login`),
  cancelLogin: (agent: AgentId) => request<void>('DELETE', `/agents/${agent}/login`),
  submitLoginCode: (agent: AgentId, code: string) => request<void>('POST', `/agents/${agent}/login/code`, { code }),
  loginOutput: (agent: AgentId) => request<string>('GET', `/agents/${agent}/login/output`),
  saveCodexKey: (key: string) => request<{ verified: boolean }>('PUT', '/agents/codex/api-key', { key }),
  logout: (agent: AgentId) => request<void>('POST', `/agents/${agent}/logout`),
  refreshAgents: () => request<void>('POST', '/agents/refresh'),
  rebuildImage: () => request<void>('POST', '/image/rebuild'),
  checkSandboxes: () => request<void>('POST', '/sandboxes/check'),
};
