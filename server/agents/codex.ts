import type { TodoEntry, ToolItem } from '../../shared/types.ts';
import { describeTeamTool } from './team-tools.ts';
import { type AgentAdapter, type AgentParser, type ChatOp, clipOutput } from './types.ts';

/** Codex wraps every command as `/bin/bash -lc '<command>'`; show just the command. */
export function unwrapShellCommand(command: string): string {
  const match = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  return match ? match[1].replace(/'\\''/g, "'") : command;
}

function humanize(type: string): string {
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isAuthFailure(message: string): boolean {
  return /\b401\b|unauthorized|not logged in|invalid_api_key/i.test(message);
}

function isLimit(message: string): boolean {
  return /usage limit|rate limit|too many requests|\b429\b|quota/i.test(message);
}

export function createCodexParser(runId: string): AgentParser {
  const open = new Map<string, ToolItem>();
  let reconnecting = false;

  function toolFor(item: any, id: string, completed: boolean): ToolItem | null {
    const base = { id, ts: open.get(id)?.ts ?? Date.now(), runId, type: 'tool' as const, name: item.type as string };
    const failed = item.status === 'failed' || item.status === 'declined' || Boolean(item.error);
    const status: ToolItem['status'] = !completed ? 'running' : failed ? 'error' : 'done';
    switch (item.type) {
      case 'command_execution':
        return {
          ...base,
          kind: 'command',
          title: 'Ran a command',
          detail: unwrapShellCommand(item.command ?? ''),
          status: completed && typeof item.exit_code === 'number' && item.exit_code !== 0 ? 'error' : status,
          ...clipOutput(item.aggregated_output ?? ''),
        };
      case 'file_change': {
        const changes: { path: string }[] = item.changes ?? [];
        return {
          ...base,
          kind: 'edit',
          title: changes.length === 1 ? 'Edited' : `Edited ${changes.length} files`,
          detail: changes.map((change) => change.path).join(', '),
          status,
        };
      }
      case 'mcp_tool_call':
        if (item.server === 'lonca') {
          return {
            ...base,
            ...describeTeamTool(String(item.tool), item.arguments ?? {}),
            status,
            ...clipOutput(item.error?.message ?? (item.result?.content ?? []).map((block: { text?: string }) => block.text ?? '').join('\n')),
          };
        }
        return {
          ...base,
          kind: 'other',
          title: `${item.server}: ${item.tool}`,
          status,
          ...clipOutput(item.error?.message ?? (item.result ? JSON.stringify(item.result) : '')),
        };
      case 'web_search':
        return { ...base, kind: 'web', title: 'Searched the web for', detail: item.query, status };
      case 'todo_list': {
        const todos: TodoEntry[] = (item.items ?? []).map((entry: { text?: string; completed?: boolean }) => ({
          text: entry.text ?? '',
          status: entry.completed ? 'completed' : 'pending',
        }));
        return { ...base, kind: 'todos', title: 'Updated the plan', status: 'done', todos };
      }
      default:
        return { ...base, kind: 'other', title: humanize(String(item.type ?? 'Tool call')), status };
    }
  }

  function itemEvent(item: any, completed: boolean): ChatOp[] {
    const id = `${runId}:${item.id}`;
    switch (item.type) {
      case 'agent_message':
        return completed && item.text?.trim() ? [{ op: 'upsert', item: { id, ts: Date.now(), runId, type: 'text', text: item.text } }] : [];
      case 'reasoning':
        return completed && item.text?.trim() ? [{ op: 'upsert', item: { id, ts: Date.now(), runId, type: 'thinking', text: item.text } }] : [];
      case 'error':
        // Switching transport is routine, and a real failure arrives as `turn.failed`.
        if (/^Falling back from WebSockets/.test(item.message ?? '')) return [];
        return [{ op: 'upsert', item: { id, ts: Date.now(), runId, type: 'notice', level: 'warning', text: item.message ?? '' } }];
      default: {
        const tool = toolFor(item, id, completed);
        if (!tool) return [];
        if (completed) open.delete(id);
        else open.set(id, tool);
        return [{ op: 'upsert', item: tool }];
      }
    }
  }

  const reconnectId = `${runId}:reconnecting`;

  function clearReconnect(): ChatOp[] {
    if (!reconnecting) return [];
    reconnecting = false;
    return [{ op: 'remove', itemId: reconnectId }];
  }

  return {
    line(raw) {
      const event = raw as any;
      switch (event?.type) {
        case 'thread.started':
          return event.thread_id ? [{ op: 'resume', id: event.thread_id }] : [];
        case 'item.started':
        case 'item.updated':
          return itemEvent(event.item ?? {}, false);
        case 'item.completed':
          return [...clearReconnect(), ...itemEvent(event.item ?? {}, true)];
        case 'error': {
          // Retries report themselves as errors; show one note that stays current.
          if (/^Reconnecting/.test(event.message ?? '')) {
            reconnecting = true;
            return [{ op: 'upsert', item: { id: reconnectId, ts: Date.now(), runId, type: 'notice', level: 'info', text: 'Connection trouble, retrying…' } }];
          }
          return [];
        }
        case 'turn.completed':
          return [
            ...clearReconnect(),
            {
              op: 'upsert',
              item: {
                id: `${runId}:result`,
                ts: Date.now(),
                runId,
                type: 'result',
                inputTokens: event.usage?.input_tokens,
                outputTokens: event.usage?.output_tokens,
              },
            },
          ];
        case 'turn.failed': {
          const message: string = event.error?.message ?? 'The agent stopped with an error.';
          return [
            ...clearReconnect(),
            {
              op: 'upsert',
              item: {
                id: `${runId}:failure`, ts: Date.now(), runId, type: 'notice', level: 'error', text: message,
                code: isAuthFailure(message) ? 'auth' : isLimit(message) ? 'limit' : undefined,
              },
            },
            { op: 'upsert', item: { id: `${runId}:result`, ts: Date.now(), runId, type: 'result', failed: true } },
          ];
        }
        default:
          return [];
      }
    },
    finish() {
      const ops: ChatOp[] = [...clearReconnect()];
      for (const tool of open.values()) ops.push({ op: 'upsert', item: { ...tool, status: 'error' } });
      open.clear();
      return ops;
    },
  };
}

export const codexAdapter: AgentAdapter = {
  command({ session, systemPrompt, attachments, tools, config }) {
    const images = attachments.filter((file) => file.mime.startsWith('image/')).flatMap((file) => ['-i', file.path]);
    const options = [
      ...images,
      '--json',
      '--skip-git-repo-check',
      // The virtual machine is the sandbox; Codex's own needn't nest inside it.
      '--dangerously-bypass-approvals-and-sandbox',
      '-m', session.model,
      '-c', `model_reasoning_effort=${JSON.stringify(session.effort)}`,
      '-c', `developer_instructions=${JSON.stringify(systemPrompt)}`,
      // A Lead's agents have to be ones the user can see, so its CLI's own kind are off.
      ...(tools ? ['-c', `mcp_servers.lonca.command=${JSON.stringify(tools.command)}`, '-c', `mcp_servers.lonca.args=${JSON.stringify(tools.args)}`, '-c', 'features.multi_agent=false'] : []),
      // A VM can have sign-ins of both kinds, which are used at different addresses.
      ...(config ?? []),
    ];
    return session.resumeId
      ? ['codex', 'exec', 'resume', session.resumeId, ...options, '-']
      : ['codex', 'exec', ...options, '-'];
  },
  parser: createCodexParser,
};
