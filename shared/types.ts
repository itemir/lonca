// Types shared by the server and the web app.

export type AgentId = 'claude' | 'codex';

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
}

export type Catalog = Record<AgentId, { label: string; models: ModelOption[] }>;

/**
 * One of a provider's sign-ins, which the page calls a sign-in. Its credentials are kept apart,
 * on this computer. The first of each provider's is its default, for whatever doesn't choose.
 */
export interface Profile {
  /** The provider's own id for the sign-in each had before there could be several, so that older conversations keep theirs. */
  id: string;
  agent: AgentId;
  /** Blank for one nobody has named, which shows as the provider's name. */
  name: string;
  /** Conversations at a usage limit elsewhere can move here by themselves. Off unless the user turns it on. */
  autoSwitch?: boolean;
}

/** The model and thinking level a workspace's Lead runs on. */
export interface LeadChoice {
  agent: AgentId;
  model: string;
  effort: string;
  /** The sign-in, of `agent`'s, which is its default if this is missing or gone. */
  profileId?: string;
}

export interface ProjectSettings {
  defaultBranch: string;
  setupScript: string;
  /** Globs of untracked files copied from a local repository into new workspaces. */
  filesToCopy: string[];
  /** A template saved from a workspace, to start this project's from. Blank uses the default. */
  image: string;
  /** `internet` blocks the host, LAN and other workspaces. `host` also allows host services (including other workspaces' published ports) and the LAN. */
  network: 'internet' | 'host';
  memoryGb: number;
  cpus: number;
  env: Record<string, string>;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  /** Git remote URL. Null for a local repository with no remote. */
  remoteUrl: string | null;
  /** Path of the local repository this project was added from, if any. */
  localPath: string | null;
  /** `owner` for GitHub remotes; used for the project's avatar. */
  githubOwner: string | null;
  status: 'cloning' | 'ready' | 'error';
  error?: string;
  progress?: string;
  createdAt: number;
  settings: ProjectSettings;
}

export type StepId = 'image' | 'checkout' | 'sandbox' | 'files' | 'setup';

export interface WorkspaceStep {
  id: StepId;
  status: 'pending' | 'running' | 'done' | 'error' | 'warning';
  detail?: string;
}

export type WorkspaceStatus =
  | 'creating'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'archiving'
  | 'archived'
  | 'restoring'
  | 'rebuilding'
  | 'deleting';

export type WorkspaceOperation = 'create' | 'restore' | 'start' | 'stop' | 'rebuild' | 'archive' | 'delete';

export interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

/** A port on the user's localhost that a Lead forwarded to one in its workspace's virtual machine. */
export interface PortForward {
  /** On 127.0.0.1 of the computer running Lonca. */
  hostPort: number;
  /** In the virtual machine. */
  port: number;
  /** When it was forwarded. */
  since: number;
}

export interface Workspace {
  id: string;
  projectId: string;
  /** City name; also the directory. */
  name: string;
  /** Short description derived from the first prompt, shown in the sidebar. */
  title: string | null;
  branch: string;
  baseBranch: string;
  path: string;
  /** Named for the common case: a sandbox has one of these too. */
  sandboxName: string;
  /** The image its VM was made from, as nothing else can say which that was. */
  templateImage?: string;
  /** What its Lead runs on, which a new Lead inherits. */
  lead?: LeadChoice;
  /** Set by the Lead's first message. After that `lead` only changes when it can't run. */
  leadLockedAt?: number;
  /** First of the ten ports published on the host's localhost. */
  port: number;
  /** Ports forwarded on top of those ten. They close when the workspace stops. */
  forwards?: PortForward[];
  status: WorkspaceStatus;
  error?: string;
  /** Saved before changing resources; retries finish this operation, even after a restart. */
  pendingOperation?: WorkspaceOperation;
  steps: WorkspaceStep[];
  filesCopied: number;
  diff: DiffStat | null;
  /** The branch's pull request when GitHub was last asked, kept for when it can't be asked. */
  pr?: PrSummary | null;
  createdAt: number;
  updatedAt: number;
}

export interface Attachment {
  name: string;
  /** Path relative to the workspace root. */
  path: string;
  size: number;
  mime: string;
}

export interface ChatItemBase {
  id: string;
  ts: number;
  runId?: string;
  /** Tool call this item belongs to, for work done by a sub-agent. */
  parentId?: string;
}

export interface UserItem extends ChatItemBase {
  type: 'user';
  text: string;
  attachments?: Attachment[];
  queued?: boolean;
  /** Who wrote it, when it wasn't the user. */
  from?: 'lead' | 'lonca';
  /** Shown instead of `text`, which Lonca writes for the Lead to read. */
  summary?: string;
  /** Sent ahead of `text` without being shown. */
  context?: string;
  /**
   * Handed to the turn under way, which reads it at its next step. It's still queued until the
   * agent shows it has read it. `seq` numbers its file in that turn's inbox.
   */
  handoff?: { runId: string; seq: number };
  /** Read by a turn that was already under way, rather than starting one. */
  midTurn?: boolean;
}

export interface TextItem extends ChatItemBase {
  type: 'text';
  text: string;
  streaming?: boolean;
}

export interface ThinkingItem extends ChatItemBase {
  type: 'thinking';
  text: string;
  streaming?: boolean;
}

export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'team' | 'todos' | 'other';

export interface TodoEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface EditEntry {
  path: string;
  removed: string;
  added: string;
}

export interface ToolItem extends ChatItemBase {
  type: 'tool';
  kind: ToolKind;
  name: string;
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'error';
  output?: string;
  outputTruncated?: boolean;
  edits?: EditEntry[];
  todos?: TodoEntry[];
  /** The agent a Lead's tool call was about. */
  agentId?: string;
}

export interface NoticeItem extends ChatItemBase {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  text: string;
  /** `auth` lets the UI offer a way to sign in. `limit` means the service's usage limit was reached. */
  code?: 'auth' | 'limit';
  /** When a usage limit ends, if the service said. */
  resetsAt?: number;
  /** The sign-in the turn ran on, for a limit or a refusal. */
  profileId?: string;
}

export interface ResultItem extends ChatItemBase {
  type: 'result';
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  interrupted?: boolean;
  failed?: boolean;
}

export type ChatItem = UserItem | TextItem | ThinkingItem | ToolItem | NoticeItem | ResultItem;

export type AgentJob = 'analyze' | 'implement' | 'review';

export type TurnOutcome = 'completed' | 'failed' | 'limit' | 'stopped';

/** What a Lead's agent is doing for it. */
export interface AgentWork {
  job: AgentJob;
  /** The latest thing it did, shown in the Lead's tab. */
  activity?: string;
  turnStartedAt?: number;
  /** The Lead hasn't been told how its latest turn ended. */
  unreported?: boolean;
  /** What the user wrote to it directly, until the Lead has been told. */
  userNote?: string;
  /** The tracked files when a turn began, for an agent told not to change them. */
  filesBefore?: string;
  /** They changed during its latest turn. */
  filesChanged?: boolean;
}

export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  /** Absent for a conversation of the user's own. */
  role?: 'lead' | 'agent';
  /** Set on an agent a Lead started. */
  work?: AgentWork;
  /** A Lead that was closed: its conversation stays readable, and it no longer runs. */
  closedAt?: number;
  lastOutcome?: TurnOutcome;
  /** When the usage limit that ended its latest turn ends, if known. */
  limitResetsAt?: number;
  /** The sign-in whose usage limit ended its latest turn. */
  limitProfileId?: string;
  /** Has a result nobody has read. On a Lead, this means it needs the user. */
  unread?: boolean;
  /** A Lead's turns since the user last wrote, which stops a team running forever unattended. */
  autonomousTurns?: number;
  /** Identifies the playbook a Lead was last told about. */
  playbookVersion?: string;
  /** Mutating tool calls and their replies, retained until this Lead's turn is saved as finished. */
  toolReplies?: Record<string, { text: string; failed?: boolean }>;
  agent: AgentId;
  model: string;
  effort: string;
  /** The sign-in its next turn runs on. Missing on conversations from before there could be several, which ran on the one whose id is `agent`. */
  profileId?: string;
  /** The sign-in of the turn that's running, which a move to another only changes from the next one. */
  activeProfileId?: string;
  status: 'idle' | 'running';
  /** Conversation id in the agent CLI, used to resume between turns. */
  resumeId: string | null;
  activeRunId: string | null;
  /** The durable user item answered by this run, including a retry after CLI history was lost. */
  activeMessageId?: string;
  /** An accepted Stop must survive a lost connection or server restart. */
  stopRequested?: { holdQueue: boolean };
  /** Ids of user items waiting for the current turn to finish, or for it to read them. */
  queue: string[];
  /** How many messages have been handed to turns under way, which numbers their files. */
  handoffs?: number;
  /** Queued messages wait for a decision, including after a stop, usage limit or failure. */
  held?: boolean;
  /** A team session stopped by the user. Only another user action can release it. */
  userStopped?: boolean;
  hasMessages: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalInfo {
  id: string;
  workspaceId: string;
  kind: 'shell' | 'setup';
  title: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  /** The process survived, but its original terminal stream cannot be reattached. */
  disconnected?: boolean;
  /** Its own process has ended, but something it started is still running. */
  jobsOnly?: boolean;
  /** It has been moved to a window of its own, so the panel doesn't show it. */
  windowed?: boolean;
}

export interface AgentStatus {
  signedIn: boolean;
  /** How it's signed in, in words for the Settings page. */
  summary?: string;
  /** Signed in with an API key rather than a subscription. */
  usesKey?: boolean;
  /** A turn just failed because the agent's service refused these credentials. */
  rejected?: boolean;
}

export interface ProfileStatus extends AgentStatus {
  /** When a turn on it last reached the service's usage limit. */
  limitedAt?: number;
  /** When that limit ends, if the service said. */
  limitResetsAt?: number;
}

export type LoginPhase = 'starting' | 'waiting' | 'submitting' | 'saving' | 'done' | 'failed';

export type LoginFailure =
  | 'rejected'
  | 'expired'
  | 'disabled'
  | 'denied'
  | 'stopped'
  | 'no-link'
  | 'save-failed'
  | 'unavailable'
  | 'port-busy';

/** Whether the sign-in page sends the browser back to Lonca, or Codex's one-time code is entered on it. */
export type LoginMethod = 'browser' | 'device';

/** A sign-in under way. It never includes a credential, so it's safe to send to the browser. */
export interface LoginState {
  agent: AgentId;
  /** Which of the provider's sign-ins this is for. */
  profileId: string;
  method: LoginMethod;
  phase: LoginPhase;
  /** The page to open in a browser. It sends the browser back to Lonca, unless there's a `code`. */
  url?: string;
  /** Claude's other page, which shows a code to paste instead, for a browser that can't get back. */
  pasteUrl?: string;
  /** Codex's one-time code, which the user enters on that page. */
  code?: string;
  failure?: LoginFailure;
  message?: string;
  /** What the CLI had printed when it failed, with anything secret removed. */
  output?: string;
}

/** Whether workspaces can run, which takes Docker Sandboxes, and if not, why not. */
export interface SandboxStatus {
  state: 'checking' | 'ready' | 'not-installed' | 'signed-out' | 'unsupported' | 'unavailable';
  version?: string;
  detail?: string;
  /** Commands to set it up, where there's one way to do that. */
  install?: string;
  /** Whether Docker Sandboxes passes SSH agents into sandboxes, which Lonca can only counter. */
  sshAgentForwarding?: boolean;
}

export type DockerLoginFailure = 'expired' | 'no-code' | 'stopped' | 'unavailable' | 'unchecked';

/**
 * Signing Docker Sandboxes in with `sbx login`, which is the user's own login for the whole
 * computer. It never includes a credential: the one-time code is only good for this sign-in.
 */
export interface DockerLoginState {
  phase: 'starting' | 'waiting' | 'checking' | 'done' | 'failed';
  /** The page where the code is entered. */
  url?: string;
  code?: string;
  failure?: DockerLoginFailure;
  message?: string;
  /** What sbx printed, once it's failed. */
  output?: string;
}

export interface SystemStatus {
  sandbox: SandboxStatus;
  /** The last sign-in to Docker Sandboxes from Lonca, if there's been one since it started. */
  dockerLogin?: DockerLoginState;
  image: { tag: string; state: 'unknown' | 'building' | 'ready' | 'error'; log: string; error?: string };
  /** Every sign-in's, by its id. */
  profiles: Record<string, ProfileStatus>;
  /** False until sign-in status has been checked once, before which "signed out" means nothing. */
  agentsChecked: boolean;
  /** Set while this computer's disk is nearly full, which can turn virtual machines' disks read-only. */
  lowDisk?: { freeGb: number };
}

export interface AppSettings {
  branchPrefix: string;
  gitName: string;
  gitEmail: string;
  defaultAgent: AgentId;
  defaultModel: string;
  defaultEffort: string;
  leadDefault: LeadChoice;
  /** How many agents a Lead can have working at once. */
  leadMaxAgents: number;
  /** Tell the computer's notification center when a Lead needs the user. */
  notifications: boolean;
  /** Ask before the trash icon archives a workspace. Deleting one for good always asks. */
  confirmArchive: boolean;
}

/** Instructions for Leads, from a project's file, the global file or the shipped template. */
export interface Playbook {
  content: string;
  source: 'template' | 'global' | 'project';
  template: string;
}

export interface SecretsStatus {
  claudeToken: string | null;
  githubToken: string | null;
}

export interface Me {
  name: string;
  machine: string;
}

export interface AppState {
  me: Me;
  projects: Project[];
  workspaces: Workspace[];
  sessions: Session[];
  terminals: TerminalInfo[];
  profiles: Profile[];
  /** By sign-in. */
  logins: Partial<Record<string, LoginState>>;
  system: SystemStatus;
  catalog: Catalog;
  settings: AppSettings;
  secrets: SecretsStatus;
}

export interface SessionSnapshot {
  session: Session;
  items: ChatItem[];
  seq: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  ignored: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  truncated: boolean;
  encoding: 'utf8' | 'base64';
  content: string;
  mime: string;
}

export interface SearchHit {
  path: string;
  line?: number;
  text?: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | '?';
  added: number;
  removed: number;
  binary: boolean;
}

export interface ChangeSet {
  base: string;
  files: ChangedFile[];
  added: number;
  removed: number;
  /** Null when git couldn't count them. */
  uncommitted: number | null;
  ahead: number;
}

export interface CheckRun {
  name: string;
  status: 'pending' | 'success' | 'failure' | 'skipped';
  url?: string;
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  /** GitHub sends an empty string, not null, when no review is required. */
  reviewDecision: string | null;
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string | null;
  /** CLEAN, UNSTABLE, HAS_HOOKS, BLOCKED, BEHIND, DIRTY, DRAFT or UNKNOWN. */
  mergeStateStatus: string | null;
  headRefOid: string;
  baseRefName: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** How the repository lets this user merge, from GitHub's GraphQL API. */
export interface MergeSettings {
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  viewerDefaultMergeMethod: 'MERGE' | 'SQUASH' | 'REBASE' | null;
  /** ADMIN, MAINTAIN, WRITE, TRIAGE or READ. */
  viewerPermission: string | null;
}

/** The workspace's own checkout, compared with the pull request. */
export interface LocalState {
  head: string;
  /** Commits here that aren't in the pull request, or null when its head isn't in this repository. */
  unpushed: number | null;
  uncommitted: number;
}

export interface Checks {
  github: 'connected' | 'missing-token' | 'not-github' | 'error';
  error?: string;
  pr: PullRequest | null;
  checks: CheckRun[];
  /** Null when GitHub couldn't say, which leaves every method to try. */
  repo: MergeSettings | null;
  local: LocalState | null;
  checkedAt: number;
}

/** What's kept of a pull request on its workspace, to show while it can't be read. */
export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  baseRefName: string;
  headRefOid: string;
  checkedAt: number;
}

export type MergeOutcome = 'merged' | 'pending' | 'failed' | 'unknown';

export interface MergeReply {
  outcome: MergeOutcome;
  message?: string;
  checks: Checks;
}

export type ServerEvent =
  | { type: 'project'; project: Project }
  | { type: 'project.removed'; id: string }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'workspace.removed'; id: string }
  | { type: 'session'; session: Session }
  | { type: 'session.removed'; id: string }
  | { type: 'chat.item'; sessionId: string; seq: number; item: ChatItem }
  | { type: 'chat.delta'; sessionId: string; seq: number; itemId: string; text: string }
  | { type: 'chat.remove'; sessionId: string; seq: number; itemId: string }
  | { type: 'terminal'; terminal: TerminalInfo }
  | { type: 'terminal.removed'; id: string; workspaceId: string }
  | { type: 'login'; profileId: string; login: LoginState | null }
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'system'; system: SystemStatus; catalog: Catalog }
  | { type: 'settings'; settings: AppSettings; secrets: SecretsStatus };

/** Sent over the events WebSocket: nothing needs to interrupt someone who's looking at the page. */
export type ClientEvent = { type: 'focus'; focused: boolean };

/** Sent over a terminal's WebSocket as text frames; output arrives as binary frames. */
export type TerminalClientMessage = { type: 'resize'; cols: number; rows: number };
