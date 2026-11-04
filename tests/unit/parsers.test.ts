import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../shared/types.ts';
import { createClaudeParser, describeClaudeTool } from '../../server/agents/claude.ts';
import { claudeAdapter } from '../../server/agents/claude.ts';
import { codexAdapter, createCodexParser, unwrapShellCommand } from '../../server/agents/codex.ts';
import { sanitizeItem } from '../../server/agents/sanitize.ts';
import type { AgentParser, ChatOp } from '../../server/agents/types.ts';

function fixture(name: string): unknown[] {
  return fs
    .readFileSync(path.join(import.meta.dirname, '..', 'fixtures', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Applies a parser's output the way the runner does and returns the resulting chat. */
function replay(parser: AgentParser, events: unknown[]): { items: ChatItem[]; resume: string | null } {
  const items = new Map<string, ChatItem>();
  let resume: string | null = null;
  const apply = (ops: ChatOp[]) => {
    for (const op of ops) {
      if (op.op === 'upsert') items.set(op.item.id, op.item);
      else if (op.op === 'remove') items.delete(op.itemId);
      else if (op.op === 'resume') resume = op.id;
      else {
        const item = items.get(op.itemId);
        if (item && (item.type === 'text' || item.type === 'thinking')) item.text += op.text;
      }
    }
  };
  for (const event of events) apply(parser.line(event));
  apply(parser.finish());
  return { items: [...items.values()], resume };
}

describe('Claude parser', () => {
  it('turns a captured turn into thinking, text, a tool call and a result', () => {
    const { items, resume } = replay(createClaudeParser('run'), fixture('claude-1'));
    expect(items.map((item) => item.type)).toEqual(['thinking', 'text', 'tool', 'text', 'result']);
    expect(items[0]).toMatchObject({ text: 'Considering the request.' });
    expect(items[1]).toMatchObject({ text: 'Running that now.' });
    expect(items[2]).toMatchObject({
      kind: 'command', status: 'done', detail: 'echo hi > made-by-claude.txt && ls', output: 'made-by-claude.txt',
    });
    expect(items[3]).toMatchObject({ text: 'The command finished.' });
    expect(items[4]).toMatchObject({ failed: false, costUsd: expect.any(Number), durationMs: expect.any(Number) });
    expect(resume).toMatch(/^[0-9a-f-]{36}$/);
    for (const item of items) {
      if (item.type === 'text' || item.type === 'thinking') expect(item.streaming).toBeFalsy();
    }
  });

  it('streams text as deltas before the final message arrives', () => {
    const parser = createClaudeParser('run');
    const ops = fixture('claude-2').flatMap((event) => parser.line(event));
    const deltas = ops.filter((op) => op.op === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    const first = ops.find((op) => op.op === 'upsert');
    expect(first).toMatchObject({ item: { type: 'text', streaming: true } });
  });

  it('reports a missing login as an error with a way to fix it', () => {
    const { items } = replay(createClaudeParser('run'), fixture('claude-signedout'));
    expect(items.filter((item) => item.type === 'text')).toEqual([]);
    expect(items[0]).toMatchObject({ type: 'notice', level: 'error', code: 'auth', text: expect.stringMatching(/Not logged in/) });
    expect(items.filter((item) => item.type === 'notice')).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ type: 'result', failed: true });
  });

  it('closes open blocks when the process dies mid-stream', () => {
    const parser = createClaudeParser('run');
    const partial = fixture('claude-2').filter((event: any) => event.type === 'stream_event').slice(0, 4);
    const { items } = replay(parser, partial);
    expect(items[0]).toMatchObject({ type: 'text', streaming: false });
    expect((items[0] as { text: string }).text.length).toBeGreaterThan(0);
  });

  it('marks tools still running at exit as failed', () => {
    const events = [
      { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } },
    ];
    const { items } = replay(createClaudeParser('run'), events);
    expect(items[0]).toMatchObject({ status: 'error', detail: '/x' });
  });

  it('nests work done by a sub-agent under its tool call', () => {
    const events = [
      { type: 'assistant', parent_tool_use_id: 'parent', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] } },
    ];
    const { items } = replay(createClaudeParser('run'), events);
    expect(items[0]).toMatchObject({ parentId: 'parent', kind: 'search' });
  });

  it('keeps the plan and edits from tool input', () => {
    const events = [
      { type: 'assistant', message: { id: 'm', content: [
        { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a.ts', old_string: 'old', new_string: 'new' } },
      ] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'edited' }], is_error: false },
      ] } },
    ];
    const { items } = replay(createClaudeParser('run'), events);
    expect(items[0]).toMatchObject({ kind: 'todos', todos: [{ text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress' }, { text: 'C', status: 'pending' }] });
    expect(items[1]).toMatchObject({ kind: 'edit', status: 'done', output: 'edited', edits: [{ path: '/a.ts', removed: 'old', added: 'new' }] });
  });

  it('clips very long tool output', () => {
    const events = [
      { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'yes' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(100000) }] } },
    ];
    const { items } = replay(createClaudeParser('run'), events);
    expect((items[0] as { output: string }).output.length).toBe(16384);
    expect(items[0]).toMatchObject({ outputTruncated: true });
  });

  it('ignores event types it has never seen', () => {
    const parser = createClaudeParser('run');
    expect(parser.line({ type: 'rate_limit_event' })).toEqual([]);
    expect(parser.line({ type: 'system', subtype: 'status' })).toEqual([]);
    expect(parser.line(null)).toEqual([]);
  });

  it('names common tools in plain language', () => {
    expect(describeClaudeTool('Bash', { command: 'ls', description: 'List files' })).toEqual({ kind: 'command', title: 'List files', detail: 'ls' });
    expect(describeClaudeTool('mcp__github__create_issue', {})).toEqual({ kind: 'other', title: 'github: create_issue' });
    expect(describeClaudeTool('SomethingNew', {})).toEqual({ kind: 'other', title: 'SomethingNew' });
  });

  it('builds a resumable, non-interactive command', () => {
    const argv = claudeAdapter.command({
      session: { model: 'claude-opus-5-5', effort: 'max', resumeId: 'abc' },
      systemPrompt: 'context',
    } as never);
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'max', '--resume', 'abc', '--append-system-prompt', 'context']));
    expect(argv.slice(0, 2)).toEqual(['claude', '-p']);
  });
});

describe('Codex parser', () => {
  it('turns a captured turn into a command, text and a result', () => {
    const { items, resume } = replay(createCodexParser('run'), fixture('codex-1'));
    expect(resume).toMatch(/^[0-9a-f-]{36}$/);
    expect(items.map((item) => item.type)).toEqual(['tool', 'text', 'result']);
    expect(items[0]).toMatchObject({
      kind: 'command', status: 'done', detail: 'echo hi > made-by-codex.txt && ls',
      output: expect.stringContaining('made-by-codex.txt'),
    });
    expect(items[1]).toMatchObject({ text: 'The command finished.' });
    expect(items[2]).toMatchObject({ inputTokens: 24, outputTokens: 40 });
  });

  it('shows retries as one note and clears it on success', () => {
    const parser = createCodexParser('run');
    const during = replay(parser, [{ type: 'error', message: 'Reconnecting... 1/5 (timeout)' }, { type: 'error', message: 'Reconnecting... 2/5 (timeout)' }]);
    expect(during.items).toEqual([]);
    const ops = createCodexParser('run').line({ type: 'error', message: 'Reconnecting... 1/5 (timeout)' });
    expect(ops).toMatchObject([{ op: 'upsert', item: { type: 'notice', level: 'info' } }]);
  });

  it('reports a failed turn once, offering sign-in for auth failures', () => {
    const events = [
      { type: 'error', message: 'unexpected status 401 Unauthorized' },
      { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } },
    ];
    const { items } = replay(createCodexParser('run'), events);
    expect(items.map((item) => item.type)).toEqual(['notice', 'result']);
    expect(items[0]).toMatchObject({ level: 'error', code: 'auth' });
    expect(items[1]).toMatchObject({ failed: true });
  });

  it('keeps routine transport changes out of the chat but shows other warnings', () => {
    const { items } = replay(createCodexParser('run'), [
      { type: 'item.completed', item: { id: 'a', type: 'error', message: 'Falling back from WebSockets to HTTPS transport. details' } },
      { type: 'item.completed', item: { id: 'b', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'notice', level: 'warning', text: expect.stringContaining('ignoring') });
  });

  it('flags a command that exits non-zero', () => {
    const { items } = replay(createCodexParser('run'), [
      { type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } },
    ]);
    expect(items[0]).toMatchObject({ status: 'error' });
  });

  it('maps file changes, plans and unknown items', () => {
    const { items } = replay(createCodexParser('run'), [
      { type: 'item.completed', item: { id: 'a', type: 'file_change', changes: [{ path: 'x.ts', kind: 'update' }], status: 'completed' } },
      { type: 'item.updated', item: { id: 'b', type: 'todo_list', items: [{ text: 'Do it', completed: true }, { text: 'Next', completed: false }] } },
      { type: 'item.completed', item: { id: 'c', type: 'brand_new_thing' } },
    ]);
    expect(items[0]).toMatchObject({ kind: 'edit', title: 'Edited', detail: 'x.ts' });
    expect(items[1]).toMatchObject({ kind: 'todos', todos: [{ text: 'Do it', status: 'completed' }, { text: 'Next', status: 'pending' }] });
    expect(items[2]).toMatchObject({ kind: 'other', title: 'Brand new thing', status: 'done' });
  });

  it('shows the command without its shell wrapper', () => {
    expect(unwrapShellCommand(`/bin/bash -lc 'ls -la'`)).toBe('ls -la');
    expect(unwrapShellCommand(`/bin/bash -lc 'echo '\\''hi'\\'''`)).toBe(`echo 'hi'`);
    expect(unwrapShellCommand('ls')).toBe('ls');
  });

  it('builds fresh and resume commands that read the prompt from stdin', () => {
    const base = {
      session: { model: 'gpt-x', effort: 'high', resumeId: null },
      systemPrompt: 'say "hi"\nthere',
      attachments: [{ path: '.context/a.png', mime: 'image/png' }, { path: '.context/b.txt', mime: 'text/plain' }],
    };
    const fresh = codexAdapter.command(base as never);
    expect(fresh.slice(0, 4)).toEqual(['codex', 'exec', '-i', '.context/a.png']);
    expect(fresh).not.toContain('.context/b.txt');
    expect(fresh.at(-1)).toBe('-');
    expect(fresh).toContain(`developer_instructions=${JSON.stringify(base.systemPrompt)}`);
    const resumed = codexAdapter.command({ ...base, session: { ...base.session, resumeId: 'tid' } } as never);
    expect(resumed.slice(0, 4)).toEqual(['codex', 'exec', 'resume', 'tid']);
    expect(resumed.at(-1)).toBe('-');
  });
});

describe('output from a misbehaving agent', () => {
  it('can’t put anything but strings where the page renders text', () => {
    const parser = createClaudeParser('run');
    const ops = parser.line({
      type: 'assistant',
      message: { id: 'm', content: [{ type: 'tool_use', id: { evil: true }, name: { evil: true }, input: { description: { evil: true }, command: 5 } }] },
    });
    const item = sanitizeItem((ops[0] as { item: ChatItem }).item);
    expect(item).toMatchObject({ type: 'tool', id: expect.any(String), name: expect.any(String), title: expect.any(String) });
  });

  it('normalizes every field of a tool item', () => {
    const dirty = {
      id: 7, ts: 'soon', type: 'tool', kind: 'other', name: {}, title: [], detail: {}, status: 'done', output: 12,
      edits: [{ path: {}, removed: 1, added: null }, null], todos: [{ text: 1, status: 'bad' }, null],
    } as unknown as ChatItem;
    expect(sanitizeItem(dirty)).toMatchObject({
      id: '7', ts: expect.any(Number), name: '{}', title: '[]', detail: '{}', output: '12',
      edits: [{ path: '{}', removed: '1', added: '' }, { path: '', removed: '', added: '' }],
      todos: [{ text: '1', status: 'pending' }, { text: '', status: 'pending' }],
    });
  });

  it('drops numbers that aren’t numbers', () => {
    const dirty = { id: 'r', ts: 1, type: 'result', durationMs: '5s', costUsd: {}, inputTokens: NaN, outputTokens: 3 } as unknown as ChatItem;
    expect(sanitizeItem(dirty)).toMatchObject({ durationMs: undefined, costUsd: undefined, inputTokens: undefined, outputTokens: 3 });
  });
});
