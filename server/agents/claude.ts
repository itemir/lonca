import { READS_WHILE_WORKING } from '../../shared/catalog.ts';
import type { TextItem, ThinkingItem, ToolItem, ToolKind } from '../../shared/types.ts';
import { describeTeamTool } from './team-tools.ts';
import { type AgentAdapter, type AgentParser, type ChatOp, clipEdit, clipOutput, resultId } from './types.ts';

interface ToolDescription {
  kind: ToolKind;
  title: string;
  detail?: string;
  agentId?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function describeClaudeTool(name: string, input: Record<string, unknown>): ToolDescription {
  switch (name) {
    case 'Bash':
      return { kind: 'command', title: str(input.description) ?? 'Ran a command', detail: str(input.command) };
    case 'Read':
      return { kind: 'read', title: 'Read', detail: str(input.file_path) };
    case 'Write':
      return { kind: 'edit', title: 'Wrote', detail: str(input.file_path) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', title: 'Edited', detail: str(input.file_path) ?? str(input.notebook_path) };
    case 'Grep':
      return { kind: 'search', title: 'Searched for', detail: str(input.pattern) };
    case 'Glob':
      return { kind: 'search', title: 'Listed files matching', detail: str(input.pattern) };
    case 'WebFetch':
      return { kind: 'web', title: 'Fetched', detail: str(input.url) };
    case 'WebSearch':
      return { kind: 'web', title: 'Searched the web for', detail: str(input.query) };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', title: str(input.description) ?? 'Ran a sub-agent', detail: str(input.subagent_type) };
    case 'TodoWrite':
      return { kind: 'todos', title: 'Updated the plan' };
    case 'Skill':
      return { kind: 'other', title: 'Used skill', detail: str(input.skill) };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp?.[1] === 'lonca') return describeTeamTool(mcp[2], input);
      if (mcp) return { kind: 'other', title: `${mcp[1]}: ${mcp[2]}` };
      return { kind: 'other', title: name };
    }
  }
}

function editsFor(name: string, input: Record<string, unknown>): ToolItem['edits'] {
  const path = str(input.file_path) ?? '';
  if (name === 'Edit') return [{ path, removed: clipEdit(input.old_string), added: clipEdit(input.new_string) }];
  if (name === 'Write') return [{ path, removed: '', added: clipEdit(input.content) }];
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((edit: { old_string?: unknown; new_string?: unknown }) => ({
      path,
      removed: clipEdit(edit.old_string),
      added: clipEdit(edit.new_string),
    }));
  }
  return undefined;
}

function todosFor(input: Record<string, unknown>): ToolItem['todos'] {
  if (!Array.isArray(input.todos)) return undefined;
  return input.todos.map((todo: { content?: unknown; status?: unknown }) => ({
    text: str(todo.content) ?? '',
    status: todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
  }));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text ?? '' : block.type ? `[${block.type}]` : ''))
    .join('\n');
}

export function createClaudeParser(runId: string): AgentParser {
  // Blocks being streamed, in order, so the final `assistant` event can close the right one.
  const open = new Map<string, { type: 'text' | 'thinking'; item: TextItem | ThinkingItem; parentId?: string }>();
  const tools = new Map<string, ToolItem>();
  let extraBlocks = 0;
  let sawError = false;
  let limitResetsAt: number | undefined;
  // A message sent while it finished a turn gets a turn of its own in the same process.
  let turn = 1;
  let resultInTurn = false;
  // Its results count the process's cost so far, which each turn's row shouldn't repeat.
  let costSoFar = 0;

  const itemId = (messageId: string, index: number | string) => `${runId}:${messageId}:${index}`;

  function streamEvent(event: any, apiMessageId: string, parentId: string | undefined): ChatOp[] {
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          const item: ToolItem = {
            id: block.id, ts: Date.now(), runId, parentId, type: 'tool', name: block.name, status: 'running',
            ...describeClaudeTool(block.name, {}),
          };
          tools.set(block.id, item);
          return [{ op: 'upsert', item: { ...item } }];
        }
        return [];
      }
      case 'content_block_delta': {
        const delta = event.delta;
        const text = delta?.type === 'text_delta' ? delta.text : delta?.type === 'thinking_delta' ? delta.thinking : null;
        if (!text) return [];
        const type = delta.type === 'text_delta' ? 'text' : 'thinking';
        const id = itemId(apiMessageId, event.index);
        const ops: ChatOp[] = [];
        let entry = open.get(id);
        if (!entry) {
          const item = { id, ts: Date.now(), runId, parentId, type, text: '', streaming: true } as TextItem | ThinkingItem;
          entry = { type, item, parentId };
          open.set(id, entry);
          ops.push({ op: 'upsert', item: { ...item } });
        }
        entry.item.text += text;
        ops.push({ op: 'delta', itemId: id, text });
        return ops;
      }
      default:
        return [];
    }
  }

  function assistantEvent(event: any): ChatOp[] {
    const parentId = event.parent_tool_use_id ?? undefined;
    const message = event.message;
    const ops: ChatOp[] = [];
    if (event.error || message?.model === '<synthetic>') {
      // The CLI reports failures like a missing login as a fake assistant message.
      const text = (message?.content ?? []).map((block: { text?: string }) => block.text ?? '').join('\n') || 'The agent reported an error.';
      sawError = true;
      const limited = event.error === 'rate_limit' || event.api_error_status === 429;
      ops.push({
        op: 'upsert',
        item: {
          id: itemId(message?.id ?? 'error', 'error'), ts: Date.now(), runId, type: 'notice', level: 'error', text,
          code: event.error === 'authentication_failed' ? 'auth' : limited ? 'limit' : undefined,
          ...(limited && limitResetsAt ? { resetsAt: limitResetsAt } : {}),
        },
      });
      return ops;
    }
    for (const block of message?.content ?? []) {
      if (block.type === 'text' || block.type === 'thinking') {
        const text: string = block.type === 'text' ? block.text : block.thinking;
        const entry = [...open.values()].find((candidate) => candidate.type === block.type && candidate.item.id.startsWith(`${runId}:${message.id}:`));
        if (entry) open.delete(entry.item.id);
        if (!text?.trim()) continue;
        ops.push({
          op: 'upsert',
          item: {
            id: entry?.item.id ?? itemId(message.id, `b${extraBlocks++}`),
            ts: entry?.item.ts ?? Date.now(),
            runId,
            parentId,
            type: block.type,
            text,
          } as TextItem | ThinkingItem,
        });
      } else if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const item: ToolItem = {
          id: block.id,
          ts: tools.get(block.id)?.ts ?? Date.now(),
          runId,
          parentId,
          type: 'tool',
          name: block.name,
          status: 'running',
          ...describeClaudeTool(block.name, input),
          edits: editsFor(block.name, input),
          todos: block.name === 'TodoWrite' ? todosFor(input) : undefined,
        };
        tools.set(block.id, item);
        ops.push({ op: 'upsert', item: { ...item } });
      }
    }
    return ops;
  }

  function userEvent(event: any): ChatOp[] {
    // It echoes each message it reads with the uuid it was sent with, whenever in the turn that is.
    if (event.isReplay) return typeof event.uuid === 'string' ? [{ op: 'delivered', uuid: event.uuid }] : [];
    const ops: ChatOp[] = [];
    const content = event.message?.content;
    if (!Array.isArray(content)) return ops;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const tool = tools.get(block.tool_use_id);
      if (!tool) continue;
      tool.status = block.is_error ? 'error' : 'done';
      Object.assign(tool, clipOutput(resultText(block.content)));
      ops.push({ op: 'upsert', item: { ...tool } });
    }
    return ops;
  }

  function resultEvent(event: any): ChatOp[] {
    const ops: ChatOp[] = [];
    resultInTurn = true;
    const spent = costSoFar;
    if (typeof event.total_cost_usd === 'number') costSoFar = event.total_cost_usd;
    if (event.session_id) ops.push({ op: 'resume', id: event.session_id });
    if (event.is_error && !sawError) {
      const errors = Array.isArray(event.errors) ? event.errors.join('\n') : '';
      ops.push({
        op: 'upsert',
        item: { id: `${resultId(runId, turn)}-error`, ts: Date.now(), runId, type: 'notice', level: 'error', text: event.result || errors || 'The agent stopped with an error.' },
      });
    }
    ops.push({
      op: 'upsert',
      item: {
        id: resultId(runId, turn),
        ts: Date.now(),
        runId,
        type: 'result',
        durationMs: event.duration_ms,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd - spent : undefined,
        inputTokens: event.usage ? (event.usage.input_tokens ?? 0) + (event.usage.cache_read_input_tokens ?? 0) + (event.usage.cache_creation_input_tokens ?? 0) : undefined,
        outputTokens: event.usage?.output_tokens,
        failed: Boolean(event.is_error),
      },
    });
    return ops;
  }

  return {
    line(raw) {
      const event = raw as any;
      switch (event?.type) {
        case 'system':
          if (event.subtype === 'init') {
            const ops: ChatOp[] = [];
            if (resultInTurn) {
              turn++;
              resultInTurn = false;
              sawError = false;
              limitResetsAt = undefined;
              ops.push({ op: 'turn' });
            }
            if (event.session_id) ops.push({ op: 'resume', id: event.session_id });
            return ops;
          }
          if (event.subtype === 'compact_boundary') {
            return [{ op: 'upsert', item: { id: `${runId}:compact:${event.uuid ?? Date.now()}`, ts: Date.now(), runId, type: 'notice', level: 'info', text: 'The conversation was summarized to free up context.' } }];
          }
          return [];
        case 'rate_limit_event':
          // Says when the limit ends, and comes ahead of the error that says it was reached.
          if (event.rate_limit_info?.status === 'rejected' && typeof event.rate_limit_info.resetsAt === 'number') {
            limitResetsAt = event.rate_limit_info.resetsAt * 1000;
          }
          return [];
        case 'stream_event':
          return streamEvent(event.event, event.api_message_id ?? 'message', event.parent_tool_use_id ?? undefined);
        case 'assistant':
          return assistantEvent(event);
        case 'user':
          return userEvent(event);
        case 'result':
          return resultEvent(event);
        default:
          return [];
      }
    },
    finish() {
      const ops: ChatOp[] = [];
      for (const entry of open.values()) {
        ops.push({ op: 'upsert', item: { ...entry.item, streaming: false } });
      }
      open.clear();
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

export const claudeAdapter: AgentAdapter = {
  command({ session, systemPrompt, tools }) {
    return [
      'claude', '-p',
      // Messages come one per line, from the run's inbox, and each is echoed when it's read.
      '--input-format', 'stream-json',
      '--replay-user-messages',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // The virtual machine is the sandbox, so the agent doesn't also need to ask permission.
      '--permission-mode', 'bypassPermissions',
      '--model', session.model,
      '--effort', session.effort,
      '--append-system-prompt', systemPrompt,
      // A Lead's agents have to be ones the user can see, so its CLI's own kind are off.
      ...(tools ? ['--mcp-config', JSON.stringify({ mcpServers: { lonca: { type: 'stdio', ...tools } } }), '--strict-mcp-config', '--disallowedTools', 'Task', 'Agent'] : []),
      ...(session.resumeId ? ['--resume', session.resumeId] : []),
    ];
  },
  parser: createClaudeParser,
  readsWhileWorking: READS_WHILE_WORKING.claude,
};
