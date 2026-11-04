import { create } from 'zustand';
import { DEFAULT_CATALOG } from '../../shared/catalog.ts';
import type {
  AgentId, AppSettings, AppState, Catalog, ChatItem, LoginState, Me, Project, SecretsStatus, ServerEvent, Session,
  SystemStatus, TerminalInfo, Workspace,
} from '../../shared/types.ts';
import { api, onUnauthorized } from './api.ts';
import { accessToken, socketUrl, tokenAccepted, tokenRejected } from './auth.ts';

interface Transcript {
  items: ChatItem[];
  seq: number;
}

export type WorkspaceTab =
  | { kind: 'session'; id: string }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'diff'; path: string; untracked: boolean; oldPath?: string };

/**
 * Why signing in can't start yet, if it can't. It runs the agent's CLI from the workspace image,
 * and until the first check nobody knows whether it's needed.
 */
export function signInBlocker(system: SystemStatus): string | null {
  if (!system.docker.ok) return 'Waiting for Docker';
  if (system.image.state !== 'ready') return 'Waiting for the workspace image';
  if (!system.agentsChecked) return 'Checking sign-in…';
  return null;
}

export function tabKey(tab: WorkspaceTab): string {
  return tab.kind === 'session' ? `session:${tab.id}` : `${tab.kind}:${tab.path}`;
}

interface WorkspaceTabs {
  files: WorkspaceTab[];
  active: string | null;
}

interface Toast {
  id: number;
  text: string;
}

interface Store {
  ready: boolean;
  /** No valid access token: the page was opened without the link from the terminal. */
  locked: boolean;
  connected: boolean;
  me: Me;
  projects: Project[];
  workspaces: Workspace[];
  sessions: Session[];
  terminals: TerminalInfo[];
  logins: Partial<Record<AgentId, LoginState>>;
  system: SystemStatus;
  catalog: Catalog;
  settings: AppSettings;
  secrets: SecretsStatus;
  transcripts: Record<string, Transcript>;
  /** Why a chat's last load failed. An open chat keeps retrying while this is set. */
  transcriptErrors: Record<string, string>;
  tabs: Record<string, WorkspaceTabs>;
  toasts: Toast[];
  searchOpen: boolean;
  addProjectOpen: boolean;
  loginAgent: 'claude' | 'codex' | null;

  hydrate(state: AppState): void;
  apply(event: ServerEvent): void;
  loadTranscript(sessionId: string): Promise<void>;
  openTab(workspaceId: string, tab: WorkspaceTab): void;
  closeTab(workspaceId: string, key: string): void;
  setActiveTab(workspaceId: string, key: string): void;
  toast(text: string): void;
  dismissToast(id: number): void;
  setSearchOpen(open: boolean): void;
  setAddProjectOpen(open: boolean): void;
  setLoginAgent(agent: 'claude' | 'codex' | null): void;
}

const TABS_KEY = 'lonca.tabs';

function loadTabs(): Record<string, WorkspaceTabs> {
  try {
    return JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveTabs(tabs: Record<string, WorkspaceTabs>): void {
  localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
}

function upsertById<T extends { id: string }>(list: T[], entry: T): T[] {
  const index = list.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return [...list, entry];
  const next = [...list];
  next[index] = entry;
  return next;
}

function applyChatEvent(transcript: Transcript, event: ServerEvent): Transcript {
  switch (event.type) {
    case 'chat.item':
      return { seq: event.seq, items: upsertById(transcript.items, event.item) };
    case 'chat.delta':
      return {
        seq: event.seq,
        items: transcript.items.map((item) =>
          item.id === event.itemId && (item.type === 'text' || item.type === 'thinking')
            ? { ...item, text: item.text + event.text }
            : item,
        ),
      };
    case 'chat.remove':
      return { seq: event.seq, items: transcript.items.filter((item) => item.id !== event.itemId) };
    default:
      return transcript;
  }
}

// Events that arrive while a transcript loads are held back, then applied if newer than it.
const pendingChat = new Map<string, { generation: number; events: ServerEvent[] }>();
let connectionGeneration = 0;
let nextToastId = 1;

export const useStore = create<Store>((set, get) => ({
  ready: false,
  locked: false,
  connected: false,
  me: { name: '', machine: '' },
  projects: [],
  workspaces: [],
  sessions: [],
  terminals: [],
  logins: {},
  system: {
    docker: { ok: true },
    sandbox: { state: 'checking' },
    agentsChecked: false,
    image: { tag: '', state: 'unknown', log: '' },
    agents: { claude: { signedIn: false }, codex: { signedIn: false } },
  },
  catalog: DEFAULT_CATALOG,
  settings: { branchPrefix: '', gitName: '', gitEmail: '', defaultAgent: 'claude', defaultModel: 'claude-opus-5-5', defaultEffort: 'high' },
  secrets: { claudeToken: null, githubToken: null },
  transcripts: {},
  transcriptErrors: {},
  tabs: loadTabs(),
  toasts: [],
  searchOpen: false,
  addProjectOpen: false,
  loginAgent: null,

  hydrate(state) {
    // A sign-in carries on through a page reload, so its window comes back with it.
    const inProgress = (Object.values(state.logins) as LoginState[]).find((login) => login.phase !== 'done' && login.phase !== 'failed');
    set((store) => ({ ...state, ready: true, loginAgent: store.loginAgent ?? inProgress?.agent ?? null }));
  },

  apply(event) {
    switch (event.type) {
      case 'project':
        set((store) => ({ projects: upsertById(store.projects, event.project) }));
        break;
      case 'project.removed':
        set((store) => ({ projects: store.projects.filter((project) => project.id !== event.id) }));
        break;
      case 'workspace':
        set((store) => ({ workspaces: upsertById(store.workspaces, event.workspace) }));
        break;
      case 'workspace.removed':
        set((store) => ({ workspaces: store.workspaces.filter((workspace) => workspace.id !== event.id) }));
        break;
      case 'session':
        set((store) => ({ sessions: upsertById(store.sessions, event.session) }));
        break;
      case 'session.removed':
        set((store) => ({ sessions: store.sessions.filter((session) => session.id !== event.id) }));
        break;
      case 'terminal':
        set((store) => ({ terminals: upsertById(store.terminals, event.terminal) }));
        break;
      case 'terminal.removed':
        set((store) => ({ terminals: store.terminals.filter((terminal) => terminal.id !== event.id) }));
        break;
      case 'login':
        set((store) => {
          const logins = { ...store.logins };
          if (event.login) logins[event.agent] = event.login;
          else delete logins[event.agent];
          return { logins };
        });
        break;
      case 'system':
        set({ system: event.system, catalog: event.catalog });
        break;
      case 'settings':
        set({ settings: event.settings, secrets: event.secrets });
        break;
      case 'chat.item':
      case 'chat.delta':
      case 'chat.remove': {
        const waiting = pendingChat.get(event.sessionId);
        if (waiting) {
          waiting.events.push(event);
          break;
        }
        const transcript = get().transcripts[event.sessionId];
        if (transcript) {
          set((store) => ({
            transcripts: { ...store.transcripts, [event.sessionId]: applyChatEvent(transcript, event) },
          }));
        }
        break;
      }
    }
  },

  async loadTranscript(sessionId) {
    if (pendingChat.get(sessionId)?.generation === connectionGeneration) return;
    const pending = { generation: connectionGeneration, events: [] as ServerEvent[] };
    pendingChat.set(sessionId, pending);
    const current = () => pendingChat.get(sessionId) === pending && pending.generation === connectionGeneration;
    try {
      const snapshot = await api.session(sessionId);
      if (!current()) return;
      let transcript: Transcript = { items: snapshot.items, seq: snapshot.seq };
      for (const event of pending.events) {
        if ('seq' in event && event.seq > snapshot.seq) transcript = applyChatEvent(transcript, event);
      }
      set((store) => {
        const { [sessionId]: _recovered, ...transcriptErrors } = store.transcriptErrors;
        return { transcripts: { ...store.transcripts, [sessionId]: transcript }, transcriptErrors };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (current()) set((store) => ({ transcriptErrors: { ...store.transcriptErrors, [sessionId]: message } }));
    } finally {
      // Keep invalidated requests listed so the next connection also reloads chats
      // whose first snapshot never arrived. An old response cannot clear a new request.
      if (current()) pendingChat.delete(sessionId);
    }
  },

  openTab(workspaceId, tab) {
    set((store) => {
      const current = store.tabs[workspaceId] ?? { files: [], active: null };
      const key = tabKey(tab);
      const files = tab.kind === 'session'
        ? current.files
        : [...current.files.filter((entry) => tabKey(entry) !== key), tab];
      const tabs = { ...store.tabs, [workspaceId]: { files, active: key } };
      saveTabs(tabs);
      return { tabs };
    });
  },

  closeTab(workspaceId, key) {
    set((store) => {
      const current = store.tabs[workspaceId] ?? { files: [], active: null };
      const files = current.files.filter((entry) => tabKey(entry) !== key);
      const active = current.active === key ? null : current.active;
      const tabs = { ...store.tabs, [workspaceId]: { files, active } };
      saveTabs(tabs);
      return { tabs };
    });
  },

  setActiveTab(workspaceId, key) {
    set((store) => {
      const current = store.tabs[workspaceId] ?? { files: [], active: null };
      const tabs = { ...store.tabs, [workspaceId]: { ...current, active: key } };
      saveTabs(tabs);
      return { tabs };
    });
  },

  toast(text) {
    const id = nextToastId++;
    set((store) => ({ toasts: [...store.toasts, { id, text }] }));
    setTimeout(() => get().dismissToast(id), 6000);
  },

  dismissToast(id) {
    set((store) => ({ toasts: store.toasts.filter((toast) => toast.id !== id) }));
  },

  setSearchOpen: (open) => set({ searchOpen: open }),
  setAddProjectOpen: (open) => set({ addProjectOpen: open }),
  setLoginAgent: (agent) => set({ loginAgent: agent }),
}));

/** Runs an action and shows any failure instead of leaving it in the console. */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    useStore.getState().toast(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export function startConnection(): void {
  const { apply, hydrate } = useStore.getState();
  onUnauthorized(() => {
    if (!tokenRejected()) useStore.setState({ locked: true });
  });
  if (!accessToken()) {
    useStore.setState({ locked: true });
    return;
  }
  const connect = () => {
    const socket = new WebSocket(socketUrl('/ws'));
    let closed = false;
    let pending: ServerEvent[] | null = [];
    socket.onopen = async () => {
      connectionGeneration++;
      useStore.setState({ connected: true });
      try {
        const snapshot = await api.state();
        // A response from a lost connection must never overwrite its replacement.
        if (closed) return;
        hydrate(snapshot);
        for (const event of pending ?? []) apply(event);
        pending = null;
        tokenAccepted();
        // Anything that changed while disconnected may have been missed.
        const open = new Set([...Object.keys(useStore.getState().transcripts), ...pendingChat.keys()]);
        await Promise.all([...open].map((id) => useStore.getState().loadTranscript(id)));
      } catch (error) {
        console.error(error);
        // Retry hydration with a fresh connection instead of buffering indefinitely.
        socket.close();
      }
    };
    socket.onmessage = (message) => {
      if (closed) return;
      const event = JSON.parse(message.data) as ServerEvent;
      if (pending) pending.push(event);
      else apply(event);
    };
    socket.onclose = () => {
      closed = true;
      pending = null;
      connectionGeneration++;
      useStore.setState({ connected: false });
      // A refused connection looks the same as a server that's down; the API can tell them apart.
      api.state().catch(() => {});
      setTimeout(() => {
        if (!useStore.getState().locked) connect();
      }, 1000);
    };
  };
  connect();
}
