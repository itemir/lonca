import fs from 'node:fs';
import { READS_WHILE_WORKING } from '../../shared/catalog.ts';
import type { Attachment, NoticeItem, ResultItem, Session, TextItem, TodoEntry, ToolItem, ToolKind, Workspace } from '../../shared/types.ts';
import { GEMINI_HOMES_DIR, paths } from '../config.ts';
import type { SandboxSetup } from '../sandbox.ts';
import { TEAM_TOOLS, describeTeamTool } from './team-tools.ts';
import { type AgentAdapter, type AgentParser, type ChatOp, clipEdit, clipOutput, resultId } from './types.ts';

const script = fs.readFileSync(new URL('./gemini.py', import.meta.url), 'utf8');

/** What `gemini.py setup` exits with in a VM made from a template without Gemini. */
export const GEMINI_MISSING = 3;

/** What a turn says when the settings that come before a checkout's own couldn't be put in place. */
export const GEMINI_UNPROTECTED = 'Lonca couldn’t put the Gemini settings that a checkout can’t change in place in this workspace’s virtual machine, so the checkout’s own .gemini settings could choose how Gemini signs in or runs, or replace a Lead’s tools. Rebuilding the workspace from its ⋯ menu may fix it.';

/** Why a Lead's turn doesn't start without them, as a checkout's own server could stand in for its tools. */
export const GEMINI_LEAD_UNPROTECTED = 'This Lead can’t run on Gemini here: Lonca couldn’t put the Gemini settings that a checkout can’t change in place in this workspace’s virtual machine, and without them the checkout’s own settings could put something else in place of the Lead’s tools. Rebuild the workspace from its ⋯ menu, or use a template in which sudo works, to fix it.';

/** Whether `gemini.py setup` said it couldn't put those settings in place. */
export function geminiSettingsUnprotected(output: string): boolean {
  return output.split('\n').some((line) => {
    try {
      return typeof (JSON.parse(line) as { unprotected?: unknown }).unprotected === 'string';
    } catch {
      return false;
    }
  });
}

// The CLI keeps its settings, its conversations and the projects it knows in a home of its own,
// which is one for each conversation, so that agents in a workspace can't see each other's.
export function geminiHome(sessionId: string): string {
  return `${GEMINI_HOMES_DIR}/${sessionId}`;
}

/**
 * Where a conversation's copies of attachments go. Its prompts name them, so they're kept where it
 * is, in the workspace's state, which outlives the VM and has the same path in it.
 */
export function geminiAttachmentsDir(workspace: Pick<Workspace, 'id'>, sessionId: string): string {
  return `${paths.agentState(workspace.id)}/gemini-attachments/${sessionId}`;
}

/** Where the CLI reads the settings that come before a checkout's own, which root owns. */
export const GEMINI_SYSTEM_SETTINGS_PATH = '/etc/gemini-cli/settings.json';

/** What the CLI needs for a turn. A project's own variables can override it, such as where the service is. */
export function geminiTurnEnv(sessionId: string): string[] {
  return [
    `GEMINI_CLI_HOME=${geminiHome(sessionId)}`,
    // Said here, where a checkout's .gemini/.env can't, as the CLI reads settings again as it goes.
    `GEMINI_CLI_SYSTEM_SETTINGS_PATH=${GEMINI_SYSTEM_SETTINGS_PATH}`,
    // In a folder it doesn't trust, it quietly stops running without asking, or won't start.
    'GEMINI_CLI_TRUST_WORKSPACE=true',
    // A VM can open the user's browser, and nothing started by a turn should, such as a sign-in.
    'NO_BROWSER=true',
    // Otherwise it starts itself again as a second process.
    'GEMINI_CLI_NO_RELAUNCH=true',
    // The VM is the sandbox. A checkout's settings or .gemini/.env could otherwise ask the CLI for
    // one of its own, which fails, and this comes before those, as it does before the project's.
    'GEMINI_SANDBOX=false',
  ];
}

// LONCA.md holds what Lonca tells the agent, which the CLI adds to its own instructions. It isn't
// GEMINI.md, which the CLI tells the agent to keep its notes in.
const CONTEXT_FILES = ['GEMINI.md', 'LONCA.md'];

/**
 * A checkout's own .gemini/settings.json comes before the user's, and so could choose another
 * kind of sign-in, turn off running without asking, leave out Lonca's instructions or put a server
 * of its own in place of the Lead's tools. Only settings that root owns come before a checkout's,
 * so these are written at boot, where they are. The CLI fills in the kind of sign-in from each
 * process's environment. That includes signing in, in the helper, which has these too and so has
 * to say which kind it wants.
 *
 * A Lead's tools are here for that reason, with its turn's directory from its environment. Every
 * other conversation leaves them out. A Lead's CLI is told to start them and nothing else, and its
 * policy lets their tools back in.
 */
export const GEMINI_SYSTEM_SETTINGS = JSON.stringify({
  security: { auth: { selectedType: '${LONCA_GEMINI_AUTH:-}' }, disableYoloMode: false },
  context: { fileName: CONTEXT_FILES },
  general: { sessionRetention: { enabled: false }, enableAutoUpdate: false },
  // Its tools wait up to ten minutes for Lonca, so the CLI waits a little longer for them.
  mcpServers: { lonca: { command: 'python3', args: ['-I', '${LONCA_RUN_DIR}/lonca-tools.py', '${LONCA_RUN_DIR}'], timeout: 660000, trust: true } },
  mcp: { excluded: ['lonca'] },
});

// The project every conversation's home knows the workspace by, so that its conversations are
// kept in the same place in every home, and outlive the VM.
const PROJECT = 'workspace';

/**
 * The CLI's sub-agents are a tool of its own, which only a policy at this level can take away. The
 * settings root owns leave Lonca's tools out, which the CLI does with a policy too, so a Lead's
 * puts them back. A checkout's own policies come before neither.
 */
const LEAD_POLICY = `[[rule]]
toolName = "invoke_agent"
decision = "deny"
priority = 900

[[rule]]
mcpName = "lonca"
toolName = "*"
decision = "allow"
priority = 900
`;

const THINKING_LEVELS: Record<string, string> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };

function settingsFor(session: Pick<Session, 'effort'>, lead: boolean): object {
  return {
    security: { auth: { selectedType: '${LONCA_GEMINI_AUTH:-}' } },
    general: {
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
      checkpointing: { enabled: false },
      // It would otherwise report on itself with a tool call, which would show as work done.
      topicUpdateNarration: false,
      sessionRetention: { enabled: false },
    },
    ide: { enabled: false },
    context: { fileName: CONTEXT_FILES },
    // Only the thinking level changes. The rest of the CLI's own settings for these models stay.
    modelConfigs: {
      customAliases: {
        'chat-base-3': { extends: 'chat-base', modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: THINKING_LEVELS[session.effort] ?? 'HIGH' } } } },
      },
    },
    // A Lead's agents have to be ones the user can see, so its CLI's own kind are off. Its tools are
    // in the settings root owns, where a checkout can't replace them.
    ...(lead ? { experimental: { enableAgents: false } } : {}),
  };
}

/** Where a copy of an attachment goes, in the conversation's directory of them. */
function copyName(file: Attachment): string {
  return file.path.split('/').filter(Boolean).slice(-2).join('/');
}

/**
 * The CLI won't read a file git ignores, and attachments are in .context, so it's given copies,
 * in a directory it's told it can read.
 */
export function geminiAttachments(workspace: Pick<Workspace, 'id'>, sessionId: string, attachments: Attachment[]): Attachment[] {
  return attachments.map((file) => ({ ...file, path: `${geminiAttachmentsDir(workspace, sessionId)}/${copyName(file)}` }));
}

/** Writes a conversation's home before a turn, as `gemini.py setup` does from this. */
export function geminiSetup(context: {
  session: Session;
  workspace: Workspace;
  systemPrompt: string;
  attachments: Attachment[];
  tools?: { command: string; args: string[] };
}): SandboxSetup {
  const { session, workspace, systemPrompt, attachments, tools } = context;
  const home = geminiHome(session.id);
  const state = paths.agentState(workspace.id);
  const files: Record<string, string> = {
    '.gemini/settings.json': JSON.stringify(settingsFor(session, Boolean(tools)), null, 2),
    '.gemini/LONCA.md': systemPrompt,
    '.gemini/projects.json': JSON.stringify({ projects: { [workspace.path]: PROJECT } }),
    [`.gemini/tmp/${PROJECT}/.project_root`]: workspace.path,
    [`.gemini/history/${PROJECT}/.project_root`]: workspace.path,
    ...(tools ? { 'lonca-policy.toml': LEAD_POLICY } : {}),
  };
  return {
    command: ['python3', '-I', '-c', script, 'setup'],
    stdin: JSON.stringify({
      home,
      // Checked, and put in place again, before each turn.
      system: GEMINI_SYSTEM_SETTINGS,
      files,
      // The conversation names what the CLI keeps in these, so they outlive the VM with it, in the
      // workspace's state. Linked from the home in this order.
      links: {
        // Its files for the workspace, such as the notes it keeps on it. The whole directory, since
        // the CLI goes by real paths in deciding what the agent may write there.
        [`.gemini/tmp/${PROJECT}`]: `${state}/gemini-tmp/${session.id}`,
        [`.gemini/tmp/${PROJECT}/chats`]: `${state}/gemini-chats`,
      },
      // And its notes for every project, which are the first of its context files.
      fileLinks: { [`.gemini/${CONTEXT_FILES[0]}`]: `${state}/gemini-notes/${session.id}.md` },
      attachments: geminiAttachmentsDir(workspace, session.id),
      copies: attachments.map((file) => ({ from: `${workspace.path}/${file.path}`, to: copyName(file) })),
    }),
  };
}

interface ToolDescription {
  kind: ToolKind;
  title: string;
  detail?: string;
  agentId?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function list(value: unknown): string | undefined {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join(', ') || undefined : str(value);
}

function humanize(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TEAM_TOOL_NAMES = new Set(TEAM_TOOLS.map((tool) => tool.name));

export function describeGeminiTool(name: string, input: Record<string, unknown>): ToolDescription {
  switch (name) {
    case 'run_shell_command':
      return { kind: 'command', title: str(input.description) ?? 'Ran a command', detail: str(input.command) };
    case 'read_file':
      return { kind: 'read', title: 'Read', detail: str(input.file_path) };
    case 'read_many_files':
      return { kind: 'read', title: 'Read files', detail: list(input.include) };
    case 'list_directory':
      return { kind: 'read', title: 'Listed', detail: str(input.dir_path) };
    case 'glob':
      return { kind: 'search', title: 'Listed files matching', detail: str(input.pattern) };
    case 'grep_search':
      return { kind: 'search', title: 'Searched for', detail: str(input.pattern) };
    case 'replace':
      return { kind: 'edit', title: 'Edited', detail: str(input.file_path) };
    case 'write_file':
      return { kind: 'edit', title: 'Wrote', detail: str(input.file_path) };
    case 'web_fetch':
      return { kind: 'web', title: 'Fetched', detail: str(input.prompt) };
    case 'google_web_search':
      return { kind: 'web', title: 'Searched the web for', detail: str(input.query) };
    case 'write_todos':
      return { kind: 'todos', title: 'Updated the plan' };
    case 'invoke_agent':
      return { kind: 'agent', title: str(input.agent_name) ? `Ran the ${str(input.agent_name)} sub-agent` : 'Ran a sub-agent', detail: str(input.prompt) };
    case 'activate_skill':
      return { kind: 'other', title: 'Used skill', detail: str(input.name) };
    default: {
      // MCP tools are named mcp_<server>_<tool>, and either can have underscores of its own.
      const team = name.startsWith('mcp_lonca_') ? name.slice('mcp_lonca_'.length) : undefined;
      if (team && TEAM_TOOL_NAMES.has(team)) return describeTeamTool(team, input);
      if (name.startsWith('mcp_')) return { kind: 'other', title: name.slice('mcp_'.length) };
      return { kind: 'other', title: humanize(name) };
    }
  }
}

function editsFor(name: string, input: Record<string, unknown>): ToolItem['edits'] {
  const path = str(input.file_path) ?? '';
  if (name === 'replace') return [{ path, removed: clipEdit(input.old_string), added: clipEdit(input.new_string) }];
  if (name === 'write_file') return [{ path, removed: '', added: clipEdit(input.content) }];
  return undefined;
}

function todosFor(input: Record<string, unknown>): TodoEntry[] | undefined {
  if (!Array.isArray(input.todos)) return undefined;
  return input.todos.map((todo: { description?: unknown; status?: unknown }) => ({
    text: str(todo?.description) ?? '',
    status: todo?.status === 'completed' || todo?.status === 'in_progress' ? todo.status : 'pending',
  }));
}

function isAuthFailure(message: string): boolean {
  return /\b401\b|UNAUTHENTICATED|invalid authentication credentials|API_KEY_INVALID|API key not valid|Please set an Auth method|must specify the GEMINI_API_KEY/i.test(message);
}

function isLimit(message: string): boolean {
  return /\b429\b|RESOURCE_EXHAUSTED|quota|exhausted your (daily quota|capacity)/i.test(message);
}

/** "Your quota will reset after 19h14m47s", counted from when it was said. */
export function resetTime(message: string, saidAt: number): number | undefined {
  const match = /reset after\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(message);
  if (!match || !match.slice(1).some(Boolean)) return undefined;
  const [hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return saidAt + ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

function timeOf(event: { timestamp?: unknown }): number {
  const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(at) ? at : Date.now();
}

// What the CLI and Node say on stderr whatever happens, which says nothing about why it stopped.
const NOISE = /^(?:YOLO mode is enabled|Warning: |Ripgrep is not available|\[STARTUP\]|Loaded cached credentials|\(node:\d+\)|\(Use `node --trace)|^at |^\W*$/;

/** Why a CLI that wrote no result stopped, from the end of what it said on stderr. */
export function exitReason(stderr: string, code: unknown): string {
  const plain = stderr.replace(/\x1b\[[0-9;]*m/g, '');
  // What it says when something it didn't expect stopped it, followed by where.
  const critical = /An unexpected critical error occurred:\s*(?:[A-Za-z]*Error: )?([^\n]+)/.exec(plain)?.[1]?.trim();
  if (critical) return critical;
  const lines = plain.split('\n').map((line) => line.trim()).filter((line) => !NOISE.test(line));
  return lines.slice(-6).join('\n').slice(-1000) || `Gemini exited with code ${String(code)}.`;
}

export function createGeminiParser(runId: string, asked?: Pick<Session, 'model'>): AgentParser {
  let text: TextItem | null = null;
  let texts = 0;
  // By the CLI's id for each call, which only has to be unique while the call is running.
  const tools = new Map<string, ToolItem>();
  let calls = 0;
  let notices = 0;
  let resulted = false;

  const notice = (fields: Pick<NoticeItem, 'level' | 'text'> & Partial<NoticeItem>): ChatOp => ({
    op: 'upsert', item: { id: `${runId}:notice:${++notices}`, ts: Date.now(), runId, type: 'notice', ...fields },
  });

  const result = (fields: Partial<ResultItem>): ChatOp => {
    resulted = true;
    return { op: 'upsert', item: { id: resultId(runId, 1), ts: Date.now(), runId, type: 'result', ...fields } };
  };

  function closeText(): ChatOp[] {
    if (!text) return [];
    const done: TextItem = { ...text, streaming: false };
    text = null;
    return done.text.trim() ? [{ op: 'upsert', item: done }] : [{ op: 'remove', itemId: done.id }];
  }

  function message(event: any): ChatOp[] {
    // The prompt is echoed first, and isn't the agent's.
    if (event.role !== 'assistant' || typeof event.content !== 'string' || !event.content) return [];
    if (event.delta !== true) {
      const ops = closeText();
      if (event.content.trim()) ops.push({ op: 'upsert', item: { id: `${runId}:text:${++texts}`, ts: Date.now(), runId, type: 'text', text: event.content } });
      return ops;
    }
    const ops: ChatOp[] = [];
    if (!text) {
      text = { id: `${runId}:text:${++texts}`, ts: Date.now(), runId, type: 'text', text: '', streaming: true };
      ops.push({ op: 'upsert', item: { ...text } });
    }
    text.text += event.content;
    ops.push({ op: 'delta', itemId: text.id, text: event.content });
    return ops;
  }

  function toolUse(event: any): ChatOp[] {
    const ops = closeText();
    const name = String(event.tool_name ?? 'tool');
    const input = (event.parameters && typeof event.parameters === 'object' ? event.parameters : {}) as Record<string, unknown>;
    const item: ToolItem = {
      id: `${runId}:tool:${++calls}`, ts: Date.now(), runId, type: 'tool', name, status: 'running',
      ...describeGeminiTool(name, input),
      edits: editsFor(name, input),
      todos: name === 'write_todos' ? todosFor(input) : undefined,
    };
    tools.set(String(event.tool_id), item);
    ops.push({ op: 'upsert', item: { ...item } });
    return ops;
  }

  function toolResult(event: any): ChatOp[] {
    const tool = tools.get(String(event.tool_id));
    if (!tool) return [];
    tool.status = event.status === 'error' ? 'error' : 'done';
    // Output only comes as text when the tool shows it as text, and an error says why.
    const output = typeof event.output === 'string' ? event.output : str(event.error?.message);
    if (output) Object.assign(tool, clipOutput(output));
    return [{ op: 'upsert', item: { ...tool } }];
  }

  function resultEvent(event: any): ChatOp[] {
    const ops = closeText();
    const stats = event.stats ?? {};
    const totals = { durationMs: stats.duration_ms, inputTokens: stats.input_tokens, outputTokens: stats.output_tokens };
    // How it ends after a TERM, whether that was Stop or a usage limit.
    if (event.status === 'error' && event.error?.type === 'FatalCancellationError') return [...ops, result({ ...totals, interrupted: true })];
    if (event.status === 'error' && event.error) ops.push(failure(String(event.error.message ?? 'The agent stopped with an error.'), timeOf(event)));
    return [...ops, result({ ...totals, failed: event.status === 'error' })];
  }

  /** A failure, which may be the service refusing the sign-in or reaching its usage limit. */
  function failure(text: string, at: number): ChatOp {
    if (isAuthFailure(text)) return notice({ level: 'error', text, code: 'auth' });
    if (isLimit(text)) return notice({ level: 'error', text, code: 'limit', resetsAt: resetTime(text, at) });
    return notice({ level: 'error', text });
  }

  return {
    line(raw) {
      const event = raw as any;
      switch (event?.type) {
        case 'init': {
          const ops: ChatOp[] = typeof event.session_id === 'string' ? [{ op: 'resume', id: event.session_id }] : [];
          // The CLI swaps a preview model the sign-in can't use for one it can.
          if (asked && typeof event.model === 'string' && event.model !== asked.model) {
            ops.push(notice({ level: 'info', text: `Gemini is using ${event.model} for this turn instead of ${asked.model}, which may not be available to this sign-in.` }));
          }
          return ops;
        }
        case 'message':
          return message(event);
        case 'tool_use':
          return toolUse(event);
        case 'tool_result':
          return toolResult(event);
        case 'error':
          return [notice({ level: event.severity === 'warning' ? 'warning' : 'error', text: String(event.message ?? 'The agent reported an error.') })];
        case 'result':
          return resultEvent(event);
        case 'lonca_limit': {
          // Written by gemini.py, which stopped the CLI rather than let it wait this long.
          const said = String(event.message ?? 'Gemini reached a usage limit.');
          const resetsAt = resetTime(said, timeOf(event)) ?? (typeof event.wait_ms === 'number' ? timeOf(event) + event.wait_ms : undefined);
          return [...closeText(), notice({ level: 'error', text: said, code: 'limit', resetsAt }), result({ failed: true })];
        }
        case 'lonca_exit':
          // A CLI that reported its own end has said all there is to say. One that was stopped
          // before it could exits as cancelled.
          if (resulted) return [];
          if (event.code === 130) return [...closeText(), result({ interrupted: true })];
          return [...closeText(), failure(exitReason(String(event.stderr ?? ''), event.code), timeOf(event)), result({ failed: true })];
        default:
          return [];
      }
    },
    finish() {
      const ops = closeText();
      for (const tool of tools.values()) {
        if (tool.status === 'running') {
          tool.status = 'error';
          ops.push({ op: 'upsert', item: { ...tool } });
        }
      }
      return ops;
    },
  };
}

export const geminiAdapter: AgentAdapter = {
  command({ session, workspace, tools }) {
    const home = geminiHome(session.id);
    return [
      // Ends a turn that would otherwise wait out a usage limit, for up to a day.
      'python3', '-I', '-c', script, 'run',
      'gemini',
      '--output-format', 'stream-json',
      // The virtual machine is the sandbox, so the agent doesn't also need to ask permission.
      '--approval-mode', 'yolo',
      '-m', session.model,
      '--include-directories', geminiAttachmentsDir(workspace, session.id),
      ...(tools ? ['--allowed-mcp-server-names', 'lonca', '--admin-policy', `${home}/lonca-policy.toml`] : []),
      ...(session.resumeId ? ['--resume', session.resumeId] : []),
    ];
  },
  parser: createGeminiParser,
  readsWhileWorking: READS_WHILE_WORKING.gemini,
};
