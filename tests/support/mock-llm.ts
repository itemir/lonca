// A scripted stand-in for the Anthropic Messages and OpenAI Responses APIs. It lets
// tests drive the real `claude` and `codex` CLIs inside a real container without
// credentials or token spend. A prompt containing `RUN: <shell command>` makes the
// mock call the CLI's shell tool with that command, then finish with a short reply.
// `SLOW` delays the response, and `THINK` adds a thinking block for Claude. A line with
// `TOOL: <name> <json>` calls one of Lonca's tools for a Lead, and there can be several.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockLlm {
  port: number;
  /** `body` is the whole request, for checking what a CLI was told. */
  requests: { path: string; model?: string; auth?: string; body: string }[];
  /** Answers Codex's requests with a 401, as the real API does without a valid login. */
  refuseCodex: boolean;
  /** Models that answer with a 429, as the real APIs do at a usage limit. */
  limited: Set<string>;
  close(): Promise<void>;
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SLOW_MS = 12000;

// The user's prompt is the last text block; earlier blocks carry CLI context.
function promptOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = content.map((block: any) => block?.text).filter((text) => typeof text === 'string');
  return texts.at(-1) ?? '';
}

function wantedCommand(prompt: string): string | null {
  return /RUN: (.+)/.exec(prompt)?.[1]?.trim() ?? null;
}

function wantedTools(prompt: string): { name: string; input: unknown }[] {
  return [...prompt.matchAll(/^.*TOOL: (\w+) (.+)$/gm)].map((match) => ({ name: match[1], input: JSON.parse(match[2]) }));
}

let counter = 0;

async function anthropicStream(res: http.ServerResponse, body: any): Promise<void> {
  const last = (body.messages ?? []).filter((message: any) => message.role === 'user').at(-1);
  const hasToolResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result');
  const prompt = promptOf(last?.content);
  const command = hasToolResult ? null : wantedCommand(prompt);
  const hasBash = (body.tools ?? []).some((tool: any) => tool.name === 'Bash');
  const id = `msg_mock_${++counter}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', content: [], model: body.model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 },
    },
  });
  let index = 0;
  if (prompt.includes('THINK')) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'Considering the request.' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock' } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  if (prompt.includes('SLOW')) await sleep(SLOW_MS);
  const reply = hasToolResult ? 'The command finished.' : `Mock Claude here. You said: ${prompt.slice(0, 80)}`;
  const teamCalls = hasToolResult ? [] : wantedTools(prompt).filter((call) => (body.tools ?? []).some((tool: any) => tool.name === `mcp__lonca__${call.name}`));
  if (teamCalls.length > 0) {
    for (const [offset, call] of teamCalls.entries()) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: index + offset, content_block: { type: 'tool_use', id: `toolu_mock_${counter}_${offset}`, name: `mcp__lonca__${call.name}`, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: index + offset, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: index + offset });
    }
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
  } else if (command && hasBash) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Running that now.' } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
    const toolId = `toolu_mock_${counter}`;
    const input = JSON.stringify({ command, description: 'Run the requested command' });
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
  } else {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const part of reply.match(/.{1,12}/gs) ?? []) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
      await sleep(15);
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  }
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function anthropicJson(res: http.ServerResponse, body: any): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: `msg_mock_${++counter}`, type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  }));
}

// Codex lists tools in `body.tools` or, namespaced, in an `additional_tools` input item.
function codexTools(body: any): any[] {
  const flatten = (tools: any[]): any[] =>
    tools.flatMap((tool) => (tool.type === 'namespace' ? flatten(tool.tools ?? []) : [tool]));
  const additional = (body.input ?? []).filter((item: any) => item.type === 'additional_tools');
  return flatten([...(body.tools ?? []), ...additional.flatMap((item: any) => item.tools ?? [])]);
}

function codexToolCall(tools: any[], command: string, callId: string): unknown {
  const code = tools.find((tool) => tool.type === 'custom' && tool.name === 'exec');
  if (code) {
    return {
      type: 'custom_tool_call', id: `ctc_${callId}`, call_id: callId, name: 'exec',
      input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)} }); text(JSON.stringify(result));`,
    };
  }
  const shell = tools.find((tool) => ['shell_command', 'exec_command', 'shell'].includes(tool.name));
  if (!shell) return null;
  const args =
    shell.name === 'exec_command' ? { cmd: command }
    : shell.name === 'shell_command' ? { command }
    : { command: ['bash', '-lc', command] };
  return { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: shell.name, arguments: JSON.stringify(args) };
}

// Depending on the model, Codex offers MCP tools inside its code tool, or has the model find them first.
function codexTeamCalls(tools: any[], calls: { name: string; input: unknown }[], searched: boolean, callId: string): unknown[] {
  if (tools.some((tool) => tool.type === 'custom' && tool.name === 'exec')) {
    return [{
      type: 'custom_tool_call', id: `ctc_${callId}`, call_id: callId, name: 'exec',
      input: calls.map((call) => `text(JSON.stringify(await tools.mcp__lonca__${call.name}(${JSON.stringify(call.input)})));`).join('\n'),
    }];
  }
  if (!searched) {
    const query = [...new Set(calls.map((call) => call.name))].join(' ');
    return [{ type: 'tool_search_call', id: `ts_${callId}`, call_id: callId, execution: 'client', status: 'completed', arguments: { query, limit: 8 } }];
  }
  return calls.map((call, index) => ({
    type: 'function_call', id: `fc_${callId}_${index}`, call_id: `${callId}_${index}`, namespace: 'mcp__lonca', name: call.name, arguments: JSON.stringify(call.input),
  }));
}

async function responsesStream(res: http.ServerResponse, body: any): Promise<void> {
  const input: any[] = Array.isArray(body.input) ? body.input : [];
  const lastUserIndex = input.findLastIndex((item) => item.type === 'message' && item.role === 'user');
  const hasToolResult = input
    .slice(lastUserIndex + 1)
    .some((item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output');
  const prompt = promptOf(input[lastUserIndex]?.content);
  const command = hasToolResult ? null : wantedCommand(prompt);
  const id = `resp_mock_${++counter}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'response.created', { type: 'response.created', response: { id } });
  if (prompt.includes('SLOW')) await sleep(SLOW_MS);
  const teamCalls = hasToolResult ? [] : wantedTools(prompt);
  const searched = input.slice(lastUserIndex + 1).some((item) => item.type === 'tool_search_output');
  const toolCalls = teamCalls.length > 0
    ? codexTeamCalls(codexTools(body), teamCalls, searched, `call_${counter}`)
    : [command ? codexToolCall(codexTools(body), command, `call_${counter}`) : null].filter(Boolean);
  if (toolCalls.length > 0) {
    for (const toolCall of toolCalls) sse(res, 'response.output_item.done', { type: 'response.output_item.done', item: toolCall });
  } else {
    const text = hasToolResult ? 'The command finished.' : `Mock Codex here. You said: ${prompt.slice(0, 80)}`;
    const itemId = `msg_${counter}`;
    sse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      item: { type: 'message', id: itemId, role: 'assistant', content: [] },
    });
    sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, delta: text });
    sse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      item: { type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text }] },
    });
  }
  sse(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 12, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 32,
      },
    },
  });
  res.end();
}

export function startMockLlm(port = 0): Promise<MockLlm> {
  const requests: MockLlm['requests'] = [];
  const mock: MockLlm = { port: 0, requests, refuseCodex: false, limited: new Set(), close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const path = (req.url ?? '').split('?')[0];
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        // Some CLI background calls send non-JSON bodies; they get the default reply.
      }
      requests.push({ path, model: body.model, auth: req.headers.authorization ?? (req.headers['x-api-key'] as string | undefined), body: JSON.stringify(body) });
      if (req.method === 'POST' && mock.limited.has(body.model) && path.endsWith('/messages')) {
        // Told not to retry, as with a subscription: an API key's client would keep trying for minutes.
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' } }));
      } else if (req.method === 'POST' && mock.limited.has(body.model) && path.endsWith('/responses')) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
        res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: "You've hit your usage limit.", resets_in_seconds: 3600 } }));
      } else if (req.method === 'POST' && path.endsWith('/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 12 }));
      } else if (req.method === 'POST' && path.endsWith('/messages')) {
        if (body.stream) await anthropicStream(res, body);
        else anthropicJson(res, body);
      } else if (req.method === 'POST' && path.endsWith('/responses')) {
        if (mock.refuseCodex) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Missing bearer or basic authentication in header' } }));
        } else {
          await responsesStream(res, body);
        }
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [], models: [] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      mock.port = (server.address() as AddressInfo).port;
      mock.close = () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
      resolve(mock);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockLlm(Number(process.argv[2] ?? 0));
  console.log(`mock LLM listening on ${mock.port}`);
}
