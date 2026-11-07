import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AppSettings, Catalog, ChatItem, Profile, Project, SecretsStatus, Session, Workspace,
} from '../shared/types.ts';
import { DEFAULT_CATALOG } from '../shared/catalog.ts';
import { PROFILE_ID } from '../shared/profiles.ts';
import { paths } from './config.ts';

interface StateFile {
  version: 1;
  projects: Project[];
  workspaces: Workspace[];
  sessions: Session[];
  settings: AppSettings;
  /** Each provider's sign-ins, in order, the first being its default. Kept apart from settings, which a page patches whole. */
  profiles: Profile[];
  /** Sign-ins whose usage limit a turn reached, so that they aren't moved to again until it ends. */
  profileLimits?: Record<string, { at: number; resetsAt?: number }>;
  catalog: Catalog;
  /** The template `catalog` was read from. */
  catalogTemplate?: string;
}

export interface Secrets {
  /** The Claude sign-in each Lonca had before there could be several, whose id is `claude`. */
  claudeToken?: string;
  /** Every other Claude sign-in's, by id. */
  claudeTokens?: Record<string, string>;
  githubToken?: string;
}

/** Before there could be several, each provider had one sign-in, which keeps the provider's id. */
function firstProfiles(): Profile[] {
  return [
    { id: 'claude', agent: 'claude', name: '', createdAt: 0 },
    { id: 'codex', agent: 'codex', name: '', createdAt: 0 },
  ];
}

function defaultSettings(): AppSettings {
  const user = os.userInfo().username.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'lonca';
  return {
    branchPrefix: user,
    gitName: '',
    gitEmail: '',
    defaultAgent: 'claude',
    defaultModel: 'claude-opus-5-5',
    defaultEffort: 'high',
    leadDefault: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    leadMaxAgents: 4,
    notifications: true,
  };
}

export function writeAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

/** Workspaces saved when some could run in containers. Those get a VM the next time they start. */
function upgradeWorkspace(saved: Workspace & { containerName?: string; runtime?: string }): Workspace {
  const { containerName, runtime: _runtime, ...workspace } = saved;
  return {
    ...workspace,
    sandboxName: workspace.sandboxName ?? containerName!,
    steps: workspace.steps.map((step) => ((step.id as string) === 'container' ? { ...step, id: 'sandbox' } : step)),
  };
}

function load(): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.state, 'utf8')) as StateFile;
    return {
      ...parsed,
      workspaces: parsed.workspaces.map(upgradeWorkspace),
      settings: { ...defaultSettings(), ...parsed.settings },
      profiles: (parsed.profiles ?? firstProfiles()).filter((profile) => PROFILE_ID.test(profile.id)),
      // Only Codex's list is discovered at runtime. Claude's ships with the app, so upgrades update it.
      catalog: { claude: DEFAULT_CATALOG.claude, codex: parsed.catalog?.codex ?? DEFAULT_CATALOG.codex },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, projects: [], workspaces: [], sessions: [], settings: defaultSettings(), profiles: firstProfiles(), catalog: DEFAULT_CATALOG };
  }
}

export const state: StateFile = load();

let saveTimer: NodeJS.Timeout | null = null;

export function saveState(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flushState, 100);
}

export function flushState({ required = false }: { required?: boolean } = {}): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    writeAtomic(paths.state, JSON.stringify(state, null, 2), 0o600);
  } catch (error) {
    // Most likely a full disk. Everything is still in memory, and the next save tries again.
    console.error('could not save state:', error);
    if (required) throw error;
  }
}

export function getProject(id: string): Project | undefined {
  return state.projects.find((project) => project.id === id);
}

export function getWorkspace(id: string): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === id);
}

export function getSession(id: string): Session | undefined {
  return state.sessions.find((session) => session.id === id);
}

// Secrets are kept apart from state.json so that file stays safe to read and share.

/** Claude's tokens and API keys share a prefix; anything else, like a sign-in code pasted by mistake, can't work. */
export function isClaudeCredential(value: string): boolean {
  return /^sk-ant-[\w-]{20,}$/.test(value);
}

let secrets: Secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(paths.secrets, 'utf8')) as Secrets;
} catch (error) {
  // Starting without them would erase them at the next save. A JSON error quotes the file, so it isn't passed on.
  const { code } = error as NodeJS.ErrnoException;
  if (code !== 'ENOENT') throw new Error(`Could not read ${paths.secrets}: ${code ?? 'it isn’t valid JSON'}`);
}

export function getSecrets(): Readonly<Secrets> {
  return secrets;
}

export function updateSecrets(patch: Partial<Secrets>): void {
  secrets = { ...secrets, ...patch };
  for (const key of Object.keys(secrets) as (keyof Secrets)[]) {
    if (!secrets[key] || (typeof secrets[key] === 'object' && Object.keys(secrets[key]).length === 0)) delete secrets[key];
  }
  writeAtomic(paths.secrets, JSON.stringify(secrets, null, 2), 0o600);
  shareSecretsWithProxy();
}

/** A Claude sign-in's token or key. The first one's stays where it always was, so going back a version keeps it. */
export function claudeCredential(profileId: string): string | undefined {
  return profileId === 'claude' ? secrets.claudeToken : secrets.claudeTokens?.[profileId];
}

export function setClaudeCredential(profileId: string, value: string | undefined): void {
  if (!PROFILE_ID.test(profileId) || !profileId.startsWith('claude')) throw new Error('That isn’t a Claude sign-in.');
  if (profileId === 'claude') return updateSecrets({ claudeToken: value ?? '' });
  const claudeTokens = { ...secrets.claudeTokens };
  if (value) claudeTokens[profileId] = value;
  else delete claudeTokens[profileId];
  updateSecrets({ claudeTokens });
}

/** A sign-in's id, or GitHub's. Anything else could name a file outside the directory. */
type BoundaryName = string;

function boundaryFile(name: BoundaryName): string {
  if (name !== 'github' && !PROFILE_ID.test(name)) throw new Error(`Not a credential the proxy reads: ${name}`);
  return path.join(paths.boundary, name);
}

/** What the proxy on this computer sends for a virtual machine. It reads this for every request, so a change applies at once. */
export function setBoundaryValue(name: BoundaryName, value: string | undefined): void {
  const file = boundaryFile(name);
  if (!value) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(paths.boundary, { recursive: true, mode: 0o700 });
  writeAtomic(file, value, 0o600);
}

export function boundaryValue(name: BoundaryName): string | undefined {
  try {
    return fs.readFileSync(boundaryFile(name), 'utf8') || undefined;
  } catch {
    return undefined;
  }
}

function boundaryNames(): string[] {
  try {
    return fs.readdirSync(paths.boundary);
  } catch {
    return [];
  }
}

/** What the proxy reads follows what's saved, so a file left by a sign-out that was cut short goes too. */
function shareSecretsWithProxy(): void {
  setBoundaryValue('claude', secrets.claudeToken);
  const tokens = secrets.claudeTokens ?? {};
  for (const id of new Set([...Object.keys(tokens), ...boundaryNames()])) {
    if (PROFILE_ID.test(id) && id.startsWith('claude-')) setBoundaryValue(id, tokens[id]);
  }
  setBoundaryValue('github', secrets.githubToken);
}

shareSecretsWithProxy();

function mask(secret: string | undefined): string | null {
  return secret ? `••••${secret.slice(-4)}` : null;
}

export function secretsStatus(): SecretsStatus {
  return { claudeToken: mask(secrets.claudeToken), githubToken: mask(secrets.githubToken) };
}

/** The token that guards the web UI and API, stable across restarts. */
export function accessToken(): string {
  try {
    return fs.readFileSync(paths.token, 'utf8').trim();
  } catch {
    const token = crypto.randomBytes(24).toString('base64url');
    writeAtomic(paths.token, token, 0o600);
    return token;
  }
}

// Chat transcripts are append-only JSONL files, coalesced by item id on load.

function transcriptFile(sessionId: string): string {
  return path.join(paths.sessions, `${sessionId}.jsonl`);
}

fs.mkdirSync(paths.sessions, { recursive: true });

type TranscriptRecord = ChatItem | { removed: string } | { moved: ChatItem };
interface TranscriptWrites {
  lines: string[];
  scheduled?: NodeJS.Immediate;
  retry?: NodeJS.Timeout;
  error?: string;
}

const transcriptWrites = new Map<string, TranscriptWrites>();

function cancelTranscriptFlush(writes: TranscriptWrites): void {
  if (writes.scheduled) clearImmediate(writes.scheduled);
  if (writes.retry) clearTimeout(writes.retry);
  writes.scheduled = undefined;
  writes.retry = undefined;
}

function appendRecords(sessionId: string, records: TranscriptRecord[]): void {
  if (records.length === 0) return;
  let writes = transcriptWrites.get(sessionId);
  if (!writes) {
    writes = { lines: [] };
    transcriptWrites.set(sessionId, writes);
  }
  writes.lines.push(...records.map((record) => JSON.stringify(record)));
  if (!writes.scheduled && !writes.retry) {
    writes.scheduled = setImmediate(() => {
      try { flushTranscript(sessionId); } catch { /* Retained and retried by flushTranscript. */ }
    });
  }
}

/**
 * A persistence boundary, like flushState: nothing else can change the session between
 * saving its transcript and saving the state that refers to it. Normal output is batched
 * once per event-loop turn instead of opening the file separately for every chat event.
 */
export function flushTranscript(sessionId: string): void {
  const writes = transcriptWrites.get(sessionId);
  if (!writes) return;
  cancelTranscriptFlush(writes);
  try {
    // A crash or failed append may leave a partial final line. Separate the next batch
    // from it so its first record stays readable. Replaying a partly written batch is
    // safe: upserts, removals and moves are all coalesced by item ID when loading.
    fs.appendFileSync(transcriptFile(sessionId), `\n${writes.lines.join('\n')}\n`, { mode: 0o600, flush: true });
    transcriptWrites.delete(sessionId);
  } catch (error) {
    const message = String(error);
    if (writes.error !== message) console.error('could not save transcript', sessionId, error);
    writes.error = message;
    writes.retry = setTimeout(() => {
      try { flushTranscript(sessionId); } catch { /* Keep the records until writing succeeds. */ }
    }, 1000).unref();
    throw error;
  }
}

/** Save every conversation, even if one of the files fails. */
export function flushTranscripts(): void {
  const errors: unknown[] = [];
  for (const sessionId of transcriptWrites.keys()) {
    try { flushTranscript(sessionId); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Some conversations could not be saved');
}

export function appendTranscript(sessionId: string, items: ChatItem[]): void {
  appendRecords(sessionId, items);
}

export function loadTranscript(sessionId: string): ChatItem[] {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptFile(sessionId), 'utf8');
  } catch (error) {
    // Only a missing file means there's no conversation yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const byId = new Map<string, ChatItem>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as TranscriptRecord;
      if ('removed' in entry) byId.delete(entry.removed);
      else if ('moved' in entry) {
        byId.delete(entry.moved.id);
        byId.set(entry.moved.id, entry.moved);
      } else byId.set(entry.id, entry);
    } catch {
      // A partial line from a crash mid-write; everything before it is intact.
    }
  }
  return [...byId.values()];
}

export function appendTranscriptRemoval(sessionId: string, itemId: string): void {
  appendRecords(sessionId, [{ removed: itemId }]);
}

/** A queued message moves without a crash window between removing and restoring it. */
export function appendTranscriptMove(sessionId: string, item: ChatItem): void {
  appendRecords(sessionId, [{ moved: item }]);
}

export async function deleteTranscript(sessionId: string): Promise<void> {
  // Deliberate deletion doesn't need to save pending output, but no retry may recreate it.
  fs.rmSync(transcriptFile(sessionId), { force: true });
  const writes = transcriptWrites.get(sessionId);
  if (writes) cancelTranscriptFlush(writes);
  transcriptWrites.delete(sessionId);
}
