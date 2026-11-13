import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatItem, ResultItem } from '../../shared/types.ts';
import { createClaudeParser, describeClaudeTool } from '../../server/agents/claude.ts';
import { claudeAdapter } from '../../server/agents/claude.ts';
import { codexAdapter, createCodexParser, unwrapShellCommand } from '../../server/agents/codex.ts';
import { createGeminiParser, describeGeminiTool, exitReason, resetTime } from '../../server/agents/gemini.ts';
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
function replay(parser: AgentParser, events: unknown[]): { items: ChatItem[]; resume: string | null; delivered: string[]; turns: number } {
  const items = new Map<string, ChatItem>();
  let resume: string | null = null;
  const delivered: string[] = [];
  let turns = 1;
  const apply = (ops: ChatOp[]) => {
    for (const op of ops) {
      if (op.op === 'upsert') items.set(op.item.id, op.item);
      else if (op.op === 'remove') items.delete(op.itemId);
      else if (op.op === 'resume') resume = op.id;
      else if (op.op === 'delivered') delivered.push(op.uuid);
      else if (op.op === 'turn') turns++;
      else {
        const item = items.get(op.itemId);
        if (item && (item.type === 'text' || item.type === 'thinking')) item.text += op.text;
      }
    }
  };
  for (const event of events) apply(parser.line(event));
  apply(parser.finish());
  return { items: [...items.values()], resume, delivered, turns };
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
    // It reads its messages as they come, and says when it's read each one.
    expect(argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--replay-user-messages']));
  });

  // Recorded from Claude Code 2.1.319 with the flags Lonca uses, through inbox.py.
  it('says when it reads messages sent during a tool call, in the turn it read them in', () => {
    const { items, delivered, turns } = replay(createClaudeParser('run'), fixture('claude-midturn'));
    expect(delivered).toEqual([
      '242d5ef2-d0e1-4367-ab2d-64154d6c15fd', '75f3b79a-7afc-4de4-a100-0e283f09d5a3', 'fdd03cc4-c890-4631-8528-e78ec6110844',
    ]);
    expect(turns).toBe(1);
    expect(items.map((item) => item.type)).toEqual(['text', 'tool', 'text', 'result']);
    expect(items.at(-1)).toMatchObject({ id: 'run:result', failed: false });
    // The echoes aren't tool results, which the same event type carries.
    expect(items[1]).toMatchObject({ status: 'done', output: 'first-done' });
  });

  it('gives each turn of one process its own result', () => {
    const { items, delivered, turns } = replay(createClaudeParser('run'), fixture('claude-followon'));
    expect(delivered).toEqual(['c4b1e268-cd9e-46b7-8855-9f72d4143f1b', '6b4ac5cd-c183-4a9f-bcbe-4fe24e002ba5']);
    expect(turns).toBe(2);
    expect(items.map((item) => item.type === 'result' ? item.id : item.type)).toEqual(['text', 'run:result', 'text', 'run:result:2']);
    expect(items[2]).toMatchObject({ text: 'Mock Claude here. You said: LATE message' });
    // The CLI counts the process's cost so far, and each turn shows its own.
    const costs = items.filter((item): item is ResultItem => item.type === 'result').map((item) => item.costUsd);
    expect(costs[0]).toBeCloseTo(0.000224, 9);
    expect(costs[1]).toBeCloseTo(0.000224, 9);
  });

  it('starts counting a turn again only after a result', () => {
    const parser = createClaudeParser('run');
    const init = { type: 'system', subtype: 'init', session_id: 'session' };
    expect(parser.line(init)).toEqual([{ op: 'resume', id: 'session' }]);
    expect(parser.line(init)).toEqual([{ op: 'resume', id: 'session' }]);
    parser.line({ type: 'result', subtype: 'success', is_error: true, result: 'First failed', session_id: 'session' });
    expect(parser.line(init)).toEqual([{ op: 'turn' }, { op: 'resume', id: 'session' }]);
    const second = parser.line({ type: 'result', subtype: 'success', is_error: true, result: 'Second failed', session_id: 'session' });
    expect(second.flatMap((op) => op.op === 'upsert' ? [op.item.id] : [])).toEqual(['run:result:2-error', 'run:result:2']);
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

describe('Gemini parser', () => {
  const asked = { model: 'gemini-3.1-pro-preview' };

  it('turns a captured turn into text, a shell command, more text and a result', () => {
    const { items, resume } = replay(createGeminiParser('run', asked), fixture('gemini-1'));
    expect(items.map((item) => item.type)).toEqual(['text', 'tool', 'text', 'result']);
    expect(items[0]).toMatchObject({ text: 'Running that now.', streaming: false });
    expect(items[1]).toMatchObject({
      kind: 'command', name: 'run_shell_command', title: 'Run the requested command', detail: 'echo hello from the shell', status: 'done', output: 'hello from the shell',
    });
    expect(items[2]).toMatchObject({ text: 'The command finished.', streaming: false });
    expect(items[3]).toMatchObject({ failed: false, inputTokens: 240, outputTokens: 30, durationMs: 95 });
    expect(resume).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('streams text as deltas, and continues the same conversation on the next turn', () => {
    const first = replay(createGeminiParser('one', asked), fixture('gemini-1'));
    const parser = createGeminiParser('two', asked);
    const ops = fixture('gemini-2').slice(0, 4).flatMap((event) => parser.line(event));
    expect(ops.filter((op) => op.op === 'delta').map((op) => (op as { text: string }).text)).toEqual(['Mock Gemini ', 'here. You sa']);
    expect(ops.find((op) => op.op === 'upsert' && op.item.type === 'text')).toMatchObject({ item: { streaming: true, text: '' } });
    const second = replay(createGeminiParser('two', asked), fixture('gemini-2'));
    expect(second.resume).toBe(first.resume);
    expect(second.items.map((item) => item.type)).toEqual(['text', 'result']);
    expect(second.items[0]).toMatchObject({ text: 'Mock Gemini here. You said: And a follow-up question' });
  });

  it('ends a turn the helper stopped at a usage limit as one, with when it resets, and no cancellation', () => {
    const events = fixture('gemini-limit');
    const { items } = replay(createGeminiParser('run', asked), events);
    expect(items.map((item) => item.type)).toEqual(['result', 'notice']);
    const limit = events.at(-1) as { timestamp: string };
    expect(items.find((item) => item.type === 'notice')).toMatchObject({
      level: 'error', code: 'limit', text: expect.stringContaining('exhausted your capacity'),
      resetsAt: Date.parse(limit.timestamp) + ((19 * 60 + 14) * 60 + 47) * 1000,
    });
    expect(items.find((item) => item.type === 'result')).toMatchObject({ failed: true });
  });

  it('counts an API key’s daily quota as a usage limit with no end it can tell', () => {
    const { items } = replay(createGeminiParser('run', { model: 'gemini-3.5-flash' }), fixture('gemini-daily'));
    expect(items.map((item) => item.type)).toEqual(['notice', 'result']);
    expect(items[0]).toMatchObject({ code: 'limit', text: expect.stringContaining('exhausted your daily quota') });
    expect((items[0] as { resetsAt?: number }).resetsAt).toBeUndefined();
    expect(items[1]).toMatchObject({ failed: true });
  });

  it('counts a refusal as one, whether the CLI said so in its result or only on stderr', () => {
    const key = replay(createGeminiParser('run', { model: 'gemini-3.5-flash' }), fixture('gemini-refused-key'));
    expect(key.items.map((item) => item.type)).toEqual(['notice', 'result']);
    expect(key.items[0]).toMatchObject({ code: 'auth', text: expect.stringContaining('UNAUTHENTICATED') });
    // A Google account's token is first used before the turn begins, so all there is is stderr.
    const account = replay(createGeminiParser('run', asked), fixture('gemini-refused'));
    expect(account.resume).toBeNull();
    expect(account.items.map((item) => item.type)).toEqual(['notice', 'result']);
    expect(account.items[0]).toMatchObject({
      code: 'auth', text: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.',
    });
    expect(account.items[1]).toMatchObject({ failed: true });
  });

  it('shows a Lead’s calls to Lonca’s tools as the team’s', () => {
    const { items } = replay(createGeminiParser('run', asked), fixture('gemini-lead'));
    const tools = items.filter((item) => item.type === 'tool');
    expect(tools).toMatchObject([
      { kind: 'team', title: 'Checked on the agents', status: 'done', output: 'No agents yet.' },
      { kind: 'team', title: 'Started Analysis', detail: 'look around', status: 'done', output: 'Started Analysis' },
    ]);
  });

  it('says when the CLI swapped the model for one the sign-in can use', () => {
    const { items } = replay(createGeminiParser('run', asked), fixture('gemini-swap'));
    expect(items[0]).toMatchObject({ type: 'notice', level: 'info', text: expect.stringContaining('auto-gemini-2.5') });
    expect(items[0]).toMatchObject({ text: expect.stringContaining('gemini-3.1-pro-preview') });
    expect(replay(createGeminiParser('run', asked), fixture('gemini-1')).items.some((item) => item.type === 'notice')).toBe(false);
  });

  it('reports a conversation the CLI can’t find with what it said', () => {
    const { items } = replay(createGeminiParser('run', asked), fixture('gemini-lost'));
    expect(items[0]).toMatchObject({ type: 'notice', text: expect.stringContaining('Invalid session identifier') });
    expect(items[0]).toMatchObject({ text: expect.not.stringContaining('UNDICI') });
  });

  it('ends a turn stopped before the CLI said anything as interrupted, not failed', () => {
    const { items } = replay(createGeminiParser('run', asked), [
      { type: 'init', session_id: 's', model: asked.model },
      { type: 'result', status: 'error', error: { type: 'FatalCancellationError', message: 'Operation cancelled.' } },
      { type: 'lonca_exit', code: 130, stderr: '' },
    ]);
    expect(items).toMatchObject([{ type: 'result', interrupted: true }]);
    expect(replay(createGeminiParser('run', asked), [{ type: 'lonca_exit', code: 130, stderr: '' }]).items).toMatchObject([{ type: 'result', interrupted: true }]);
  });

  it('closes text and running tools when the process ends partway', () => {
    const parser = createGeminiParser('run', asked);
    parser.line({ type: 'message', role: 'assistant', content: 'Half a', delta: true });
    parser.line({ type: 'tool_use', tool_name: 'read_file', tool_id: 'read_file__1', parameters: { file_path: 'a.ts' } });
    parser.line({ type: 'message', role: 'assistant', content: '   ', delta: true });
    const ops = parser.finish();
    expect(ops).toEqual(expect.arrayContaining([
      { op: 'remove', itemId: 'run:text:2' },
      expect.objectContaining({ op: 'upsert', item: expect.objectContaining({ type: 'tool', status: 'error', title: 'Read', detail: 'a.ts' }) }),
    ]));
  });

  it('shows warnings, and a tool that failed with what it said', () => {
    const { items } = replay(createGeminiParser('run', asked), [
      { type: 'tool_use', tool_name: 'replace', tool_id: 'replace__1', parameters: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } },
      { type: 'tool_result', tool_id: 'replace__1', status: 'error', error: { type: 'edit_no_occurrence_found', message: 'Failed to edit, 0 occurrences found.' } },
      { type: 'error', severity: 'warning', message: 'Loop detected, stopping execution' },
      { type: 'error', severity: 'error', message: 'Model stream ended with empty response text.' },
      { type: 'result', status: 'error', stats: {} },
    ]);
    expect(items).toMatchObject([
      { type: 'tool', kind: 'edit', status: 'error', output: 'Failed to edit, 0 occurrences found.', edits: [{ path: 'a.ts', removed: 'a', added: 'b' }] },
      { type: 'notice', level: 'warning', text: 'Loop detected, stopping execution' },
      { type: 'notice', level: 'error', text: 'Model stream ended with empty response text.' },
      { type: 'result', failed: true },
    ]);
  });

  it('describes the CLI’s tools, and Lonca’s by the names it knows', () => {
    expect(describeGeminiTool('write_file', { file_path: 'b.ts', content: 'x' })).toEqual({ kind: 'edit', title: 'Wrote', detail: 'b.ts' });
    expect(describeGeminiTool('read_many_files', { include: ['a.ts', 'b.ts'] })).toEqual({ kind: 'read', title: 'Read files', detail: 'a.ts, b.ts' });
    expect(describeGeminiTool('grep_search', { pattern: 'TODO' })).toEqual({ kind: 'search', title: 'Searched for', detail: 'TODO' });
    expect(describeGeminiTool('google_web_search', { query: 'lonca' })).toEqual({ kind: 'web', title: 'Searched the web for', detail: 'lonca' });
    expect(describeGeminiTool('invoke_agent', { agent_name: 'codebase_investigator', prompt: 'look' })).toMatchObject({ kind: 'agent', detail: 'look' });
    expect(describeGeminiTool('mcp_lonca_message_agent', { id: 'a1', text: 'hi', wait_for_previous: true })).toEqual({ kind: 'team', title: 'Messaged', detail: 'hi', agentId: 'a1' });
    expect(describeGeminiTool('mcp_lonca_forward_port', { port: 3000 })).toMatchObject({ kind: 'web', title: 'Forwarded port 3000' });
    expect(describeGeminiTool('mcp_lonca_tools_extra', {})).toEqual({ kind: 'other', title: 'lonca_tools_extra' });
    expect(describeGeminiTool('mcp_github_create_issue', {})).toEqual({ kind: 'other', title: 'github_create_issue' });
    expect(describeGeminiTool('get_internal_docs', {})).toEqual({ kind: 'other', title: 'Get internal docs' });
    const parser = createGeminiParser('run', asked);
    const [todos] = parser.line({
      type: 'tool_use', tool_name: 'write_todos', tool_id: 'write_todos__1',
      parameters: { todos: [{ description: 'Read', status: 'completed' }, { description: 'Write', status: 'in_progress' }, { description: 'Skip', status: 'cancelled' }] },
    });
    expect(todos).toMatchObject({ item: { kind: 'todos', todos: [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }, { text: 'Skip', status: 'pending' }] } });
  });

  it('reads when a limit resets, and why a CLI stopped', () => {
    expect(resetTime('Your quota will reset after 1h2m3s.', 1000)).toBe(1000 + 3723000);
    expect(resetTime('reset after 45s', 0)).toBe(45000);
    expect(resetTime('reset after soon', 0)).toBeUndefined();
    expect(exitReason('YOLO mode is enabled.\nPlease set an Auth method in your settings.json\n', 41)).toBe('Please set an Auth method in your settings.json');
    expect(exitReason('\x1b[31mError in settings.json: bad\x1b[0m\n', 52)).toBe('Error in settings.json: bad');
    expect(exitReason('', 3)).toBe('Gemini exited with code 3.');
  });
});
