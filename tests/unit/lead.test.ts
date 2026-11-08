import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '../../shared/catalog.ts';
import { canRun, leadBlocker } from '../../shared/lead.ts';
import type { ChatItem, Session, SystemStatus } from '../../shared/types.ts';
import { agentProcessCommand, leadToolsScript, parseToolCall } from '../../server/agents/process.ts';
import { claudeAdapter, createClaudeParser } from '../../server/agents/claude.ts';
import { codexAdapter, createCodexParser } from '../../server/agents/codex.ts';
import { TEAM_TOOLS } from '../../server/agents/team-tools.ts';
import type { ChatOp, TurnContext } from '../../server/agents/types.ts';
import { notificationCommand } from '../../server/notify.ts';

const execFileAsync = promisify(execFile);
const ID = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

function items(ops: ChatOp[]): ChatItem[] {
  return ops.flatMap((op) => (op.op === 'upsert' ? [op.item] : []));
}

describe('usage limits', () => {
  it('recognizes Claude reaching a limit, and when it ends', () => {
    const parser = createClaudeParser('run');
    expect(parser.line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1800000000 } })).toEqual([]);
    const [notice] = items(parser.line({
      type: 'assistant', error: 'rate_limit', api_error_status: 429,
      message: { id: 'm', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Request rejected (429)' }] },
    }));
    expect(notice).toMatchObject({ type: 'notice', code: 'limit', resetsAt: 1800000000000 });
  });

  it('ignores a limit that was only coming close', () => {
    const parser = createClaudeParser('run');
    parser.line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1800000000 } });
    const [notice] = items(parser.line({ type: 'assistant', error: 'rate_limit', message: { id: 'm', model: '<synthetic>', content: [] } }));
    expect(notice).toMatchObject({ code: 'limit' });
    expect((notice as { resetsAt?: number }).resetsAt).toBeUndefined();
  });

  it('recognizes Codex reaching a limit without confusing it for a sign-in problem', () => {
    const parser = createCodexParser('run');
    const [limit] = items(parser.line({ type: 'turn.failed', error: { message: 'You’ve hit your usage limit. Try again later.' } }));
    expect(limit).toMatchObject({ type: 'notice', code: 'limit' });
    const [auth] = items(parser.line({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } }));
    expect(auth).toMatchObject({ type: 'notice', code: 'auth' });
    const [other] = items(parser.line({ type: 'turn.failed', error: { message: 'The model produced invalid output.' } }));
    expect((other as { code?: string }).code).toBeUndefined();
  });
});

describe('Lonca’s tools in the CLIs', () => {
  const context = {
    session: { model: 'm', effort: 'high', resumeId: null },
    systemPrompt: 'prompt',
    attachments: [],
    tools: { command: 'python3', args: ['-I', '/run/lonca-tools.py', '/run'] },
  } as unknown as TurnContext;

  it('gives only a Lead’s Claude the tools', () => {
    const args = claudeAdapter.command(context);
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { lonca: { type: 'stdio', command: 'python3', args: ['-I', '/run/lonca-tools.py', '/run'] } } });
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--disallowedTools') + 3)).toEqual(['Task', 'Agent']);
    expect(claudeAdapter.command({ ...context, tools: undefined })).not.toContain('--mcp-config');
  });

  it('gives only a Lead’s Codex the tools', () => {
    const args = codexAdapter.command(context);
    expect(args).toContain('mcp_servers.lonca.command="python3"');
    expect(args).toContain('mcp_servers.lonca.args=["-I","/run/lonca-tools.py","/run"]');
    expect(args).toContain('features.multi_agent=false');
    expect(codexAdapter.command({ ...context, tools: undefined }).join(' ')).not.toContain('mcp_servers');
  });

  it('shows Codex’s tool calls the way it shows Claude’s', () => {
    const parser = createCodexParser('run');
    const [tool] = items(parser.line({
      type: 'item.completed',
      item: { id: 'i', type: 'mcp_tool_call', server: 'lonca', tool: 'message_agent', arguments: { id: 'abc', text: 'Are you sure?' }, status: 'completed', result: { content: [{ type: 'text', text: 'Sent.' }] } },
    }));
    expect(tool).toMatchObject({ kind: 'team', title: 'Messaged', detail: 'Are you sure?', agentId: 'abc', status: 'done', output: 'Sent.' });
  });
});

describe('tool calls', () => {
  it('takes only well-formed calls, since an agent could have written them', () => {
    expect(parseToolCall(`LONCA_CALL {"id":"${ID}","tool":"team_status","args":{"a":1}}`)).toEqual({ id: ID, tool: 'team_status', args: { a: 1 } });
    expect(parseToolCall(`LONCA_CALL {"id":"${ID}","tool":"team_status"}`)).toEqual({ id: ID, tool: 'team_status', args: {} });
    expect(parseToolCall('LONCA_CALL {"id":"../../etc/passwd","tool":"team_status"}')).toBeNull();
    expect(parseToolCall(`LONCA_CALL {"id":"${ID}"}`)).toBeNull();
    expect(parseToolCall('LONCA_CALL {broken')).toBeNull();
    expect(parseToolCall('LONCA_OUTPUT {"code":0}')).toBeNull();
  });

  describe('in the workspace', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-tools-'));
      fs.mkdirSync(path.join(dir, 'replies'));
      fs.writeFileSync(path.join(dir, 'out.jsonl'), '');
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    /** The follower ends once the process it's following has gone, which here is from the start. */
    async function followerStderr(): Promise<string> {
      const [command, ...args] = agentProcessCommand('follow', dir, '0', 'calls');
      return (await execFileAsync(command, args)).stderr;
    }

    it('hands on calls with no reply yet, and ignores what isn’t a call', async () => {
      fs.writeFileSync(path.join(dir, 'calls.jsonl'), [
        JSON.stringify({ id: ID, tool: 'team_status', args: {} }),
        JSON.stringify({ id: OTHER, tool: 'read_agent', args: { id: 'x' } }),
        JSON.stringify({ id: '../escape', tool: 'read_agent' }),
        'not json',
        '{"id":"cccccccccccccccccccccccccccccccc","tool":"unfinished',
      ].join('\n'));
      fs.writeFileSync(path.join(dir, 'replies', `${OTHER}.json`), '{}');
      const calls = (await followerStderr()).split('\n').map(parseToolCall).filter(Boolean);
      expect(calls.map((call) => call!.id)).toEqual([ID]);
    });

    it('leaves a FIFO planted as the calls file alone', async () => {
      await execFileAsync('mkfifo', [path.join(dir, 'calls.jsonl')]);
      expect(await followerStderr()).toContain('LONCA_OUTPUT');
    });

    it('doesn’t look for calls when following anything but a Lead', async () => {
      fs.writeFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ id: ID, tool: 'team_status', args: {} })}\n`);
      const [command, ...args] = agentProcessCommand('follow', dir, '0');
      expect((await execFileAsync(command, args)).stderr).not.toContain('LONCA_CALL');
    });

    it('serves the tools over MCP and passes a call through files', async () => {
      const script = path.join(dir, 'lonca-tools.py');
      fs.writeFileSync(script, leadToolsScript(TEAM_TOOLS));
      const child = spawn('python3', ['-I', script, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
      const replies = new Map<number, any>();
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) replies.set(JSON.parse(line).id, JSON.parse(line));
      });
      const request = (id: number, method: string, params: unknown = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const reply = async (id: number) => {
        for (let i = 0; i < 400 && !replies.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 25));
        return replies.get(id);
      };
      try {
        request(1, 'initialize', { protocolVersion: '2025-06-18' });
        expect((await reply(1)).result.serverInfo.name).toBe('lonca');
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        request(2, 'tools/list');
        expect((await reply(2)).result.tools.map((tool: { name: string }) => tool.name)).toEqual(TEAM_TOOLS.map((tool) => tool.name));
        request(3, 'tools/call', { name: 'read_agent', arguments: { id: 'abc' } });
        const callsFile = path.join(dir, 'calls.jsonl');
        for (let i = 0; i < 400 && !fs.existsSync(callsFile); i++) await new Promise((resolve) => setTimeout(resolve, 25));
        const call = JSON.parse(fs.readFileSync(callsFile, 'utf8').trim());
        expect(call).toMatchObject({ tool: 'read_agent', args: { id: 'abc' } });
        expect(call.id).toMatch(/^[a-f0-9]{32}$/);
        expect(replies.has(3)).toBe(false);
        fs.writeFileSync(path.join(dir, 'replies', `${call.id}.json`), JSON.stringify({ text: 'A report', failed: true }));
        expect((await reply(3)).result).toEqual({ content: [{ type: 'text', text: 'A report' }], isError: true });
        request(4, 'tools/call', { name: 'message_agent', arguments: { id: 'abc', text: 'x'.repeat(600 * 1024) } });
        expect((await reply(4)).result.isError).toBe(true);
        request(5, 'something/else');
        expect((await reply(5)).error.code).toBe(-32601);
      } finally {
        child.kill();
      }
    });
  });
});

describe('when a Lead’s model can change', () => {
  const lead = { agent: 'claude', model: 'claude-opus-5-5' } as Session;
  const system = (signedIn: boolean, agentsChecked = true) => ({ agentsChecked, profiles: { claude: { signedIn }, codex: { signedIn } } }) as unknown as SystemStatus;

  it('stays put while it can run', () => {
    expect(leadBlocker(lead, DEFAULT_CATALOG, system(true), undefined)).toBeNull();
    expect(leadBlocker({ ...lead, lastOutcome: 'failed' }, DEFAULT_CATALOG, system(true), undefined)).toBeNull();
    expect(leadBlocker(lead, DEFAULT_CATALOG, system(false, false), undefined)).toBeNull();
    // A project can bring its own key.
    expect(leadBlocker(lead, DEFAULT_CATALOG, system(false), { settings: { env: { ANTHROPIC_API_KEY: 'sk-x' } } as never })).toBeNull();
    expect(canRun({ agent: 'codex' }, system(false), { settings: { env: { CODEX_API_KEY: 'sk-x' } } as never })).toBe(true);
  });

  it('can move when it’s out of limit, signed out or retired', () => {
    expect(leadBlocker({ ...lead, lastOutcome: 'limit' }, DEFAULT_CATALOG, system(true), undefined)).toBe('limit');
    expect(leadBlocker(lead, DEFAULT_CATALOG, system(false), undefined)).toBe('signed-out');
    expect(leadBlocker({ ...lead, model: 'claude-gone' }, DEFAULT_CATALOG, system(true), undefined)).toBe('retired');
  });
});

describe('notifications', () => {
  it('can’t turn text into AppleScript or a flag', () => {
    const text = '" & do shell script "rm -rf ~" & "';
    const [mac, macArgs] = notificationCommand('darwin', 'Lonca', text)!;
    expect(mac).toBe('osascript');
    expect(macArgs.slice(0, -2).join(' ')).not.toContain('rm -rf');
    expect(macArgs.at(-1)).toBe(text);
    const [linux, linuxArgs] = notificationCommand('linux', 'Lonca', '--icon=evil')!;
    expect(linux).toBe('notify-send');
    expect(linuxArgs.indexOf('--')).toBeLessThan(linuxArgs.indexOf('--icon=evil'));
    expect(notificationCommand('win32', 'Lonca', 'x')).toBeNull();
  });
});
