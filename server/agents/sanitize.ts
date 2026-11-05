import type { ChatItem } from '../../shared/types.ts';

// Agent output is whatever the process in the sandbox chooses to write. Everything the
// web app renders has to be the type it expects, or one bad line could break the page on
// every load, since the item is saved with the conversation.

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? undefined : JSON.stringify(value);
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function sanitizeItem(item: ChatItem): ChatItem {
  const base = { id: String(item.id), ts: number(item.ts) ?? Date.now(), runId: text(item.runId), parentId: text(item.parentId) };
  switch (item.type) {
    case 'user':
      return { ...item, ...base };
    case 'text':
    case 'thinking':
      return { ...item, ...base, text: text(item.text) ?? '' };
    case 'tool':
      return {
        ...item,
        ...base,
        name: text(item.name) ?? 'tool',
        title: text(item.title) ?? 'Tool call',
        detail: text(item.detail),
        agentId: text(item.agentId),
        output: text(item.output),
        edits: Array.isArray(item.edits)
          ? item.edits.map((edit) => ({ path: text(edit?.path) ?? '', removed: text(edit?.removed) ?? '', added: text(edit?.added) ?? '' }))
          : undefined,
        todos: Array.isArray(item.todos)
          ? item.todos.map((todo) => ({ text: text(todo?.text) ?? '', status: todo?.status === 'completed' || todo?.status === 'in_progress' ? todo.status : 'pending' }))
          : undefined,
      };
    case 'notice':
      return { ...item, ...base, text: text(item.text) ?? '', resetsAt: number(item.resetsAt) };
    case 'result':
      return {
        ...item,
        ...base,
        durationMs: number(item.durationMs),
        costUsd: number(item.costUsd),
        inputTokens: number(item.inputTokens),
        outputTokens: number(item.outputTokens),
      };
  }
}
