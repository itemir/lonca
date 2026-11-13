// A scripted stand-in for the Anthropic Messages and OpenAI Responses APIs, and for both of
// Gemini's: Code Assist, which a Google account uses, and the Gemini API, which a key does. It
// lets tests drive the real `claude`, `codex` and `gemini` CLIs inside a real container without
// credentials or token spend. A prompt containing `RUN: <shell command>` makes the
// mock call the CLI's shell tool with that command, then finish with a short reply.
// `SLOW` delays the response, and `THINK` adds a thinking block for Claude. A line with
// `TOOL: <name> <json>` calls one of Lonca's tools for a Lead, and there can be several.
// `READ: <path>` has Gemini read a file with its own tool, and `WRITE: <path> <text>` write one.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockLlm {
  port: number;
  /** `body` is the whole request, for checking what a CLI was told. */
  requests: { path: string; model?: string; auth?: string; body: string }[];
  /** Answers Codex's requests with a 401, as the real API does without a valid login. */
  refuseCodex: boolean;
  /** Answers every Gemini request with a 401, as Google does for a token or key it won't take. */
  refuseGemini: boolean;
  /** Leaves preview models out of a Google account's quota, as for an account that can't use them. */
  hidePreviewModels: boolean;
  /** Models that answer with a 429, as the real APIs do at a usage limit. */
  limited: Set<string>;
  /** Credentials, or what stands in for them, that answer with a 429: one sign-in at its limit while another isn't. */
  limitedAuth: Set<string>;
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

interface GeminiRequest {
  /** Code Assist's own method, or the Gemini API's. */
  method: string;
  codeAssist: boolean;
  model?: string;
}

function geminiRequest(path: string): GeminiRequest | null {
  const codeAssist = /\/v1internal:(\w+)$/.exec(path);
  if (codeAssist) return { method: codeAssist[1], codeAssist: true };
  const api = /\/v1(?:beta|alpha)?\/models\/([^/:]+):(\w+)$/.exec(path);
  if (api) return { method: api[2], codeAssist: false, model: api[1] };
  if (/\/v1(?:beta)?\/models\/?$/.test(path)) return { method: 'listModels', codeAssist: false };
  return null;
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

// The user's prompt is the last text of the last user turn. The CLI puts its own context first.
function geminiPrompt(contents: any[]): { prompt: string; hasToolResult: boolean } {
  const last = (contents ?? []).filter((content) => content.role === 'user').at(-1);
  const parts: any[] = last?.parts ?? [];
  const texts = parts.map((part) => part.text).filter((text) => typeof text === 'string' && !text.startsWith('<session_context>'));
  return { prompt: texts.at(-1) ?? '', hasToolResult: parts.some((part) => part.functionResponse) };
}

/** What a Google account at its limit gets: a day to wait, which the CLI would sit out. */
const CAPACITY_EXHAUSTED = (model: string) => ({
  error: {
    code: 429,
    message: 'You have exhausted your capacity on this model. Your quota will reset after 19h14m47s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXHAUSTED', domain: 'cloudcode-pa.googleapis.com', metadata: { uiMessage: 'true', model, quotaResetDelay: '69287s' } },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '69287s' },
    ],
  },
});

/** What a key at its daily quota gets, which the CLI gives up on at once. */
const DAILY_QUOTA = (model: string) => ({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model, location: 'global' }, quotaValue: '50' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' },
    ],
  },
});

const REFUSED = { error: { code: 401, message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.', status: 'UNAUTHENTICATED' } };

/** Fills in a schema the CLI asks for an answer in, as it does to check on its own progress. */
function fillSchema(schema: any): unknown {
  const type = String(schema?.type ?? '').toUpperCase();
  if (schema?.enum) return schema.enum[0];
  if (type === 'OBJECT') return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, fillSchema(value)]));
  if (type === 'INTEGER' || type === 'NUMBER') return 10;
  if (type === 'BOOLEAN') return false;
  if (type === 'ARRAY') return [];
  return 'mock';
}

const GEMINI_USAGE = { promptTokenCount: 120, candidatesTokenCount: 15, totalTokenCount: 135 };

/** The parts of one answer, in the chunks they're streamed in. */
function geminiAnswer(request: any): any[][] {
  const { prompt, hasToolResult } = geminiPrompt(request.contents);
  const offered: string[] = (request.tools ?? []).flatMap((tool: any) => (tool.functionDeclarations ?? []).map((declaration: any) => declaration.name));
  const teamCalls = hasToolResult ? [] : wantedTools(prompt).filter((call) => offered.includes(`mcp_lonca_${call.name}`));
  if (teamCalls.length > 0) {
    return [teamCalls.map((call, index) => ({ functionCall: { id: `call_${++counter}_${index}`, name: `mcp_lonca_${call.name}`, args: call.input } }))];
  }
  const file = hasToolResult ? null : /READ: (\S+)/.exec(prompt)?.[1];
  if (file && offered.includes('read_file')) return [[{ functionCall: { id: `call_${++counter}`, name: 'read_file', args: { file_path: file } } }]];
  const write = hasToolResult ? null : /WRITE: (\S+) (.+)/.exec(prompt);
  if (write && offered.includes('write_file')) return [[{ functionCall: { id: `call_${++counter}`, name: 'write_file', args: { file_path: write[1], content: write[2] } } }]];
  const command = hasToolResult ? null : wantedCommand(prompt);
  if (command && offered.includes('run_shell_command')) {
    return [[{ text: 'Running that now.' }], [{ functionCall: { id: `call_${++counter}`, name: 'run_shell_command', args: { command, description: 'Run the requested command' } } }]];
  }
  const reply = hasToolResult ? 'The command finished.' : `Mock Gemini here. You said: ${prompt.slice(0, 80)}`;
  return (reply.match(/.{1,12}/gs) ?? []).map((text) => [{ text }]);
}

async function geminiResponse(res: http.ServerResponse, mock: MockLlm, gemini: GeminiRequest, body: any, limited: boolean): Promise<void> {
  if (mock.refuseGemini) return json(res, 401, REFUSED);
  const wrap = (response: unknown) => (gemini.codeAssist ? { response, traceId: `trace-${counter}` } : response);
  switch (gemini.method) {
    case 'loadCodeAssist':
      return json(res, 200, { currentTier: { id: 'free-tier', name: 'Gemini Code Assist for individuals' }, cloudaicompanionProject: 'mock-project' });
    case 'onboardUser':
      return json(res, 200, { done: true, response: { cloudaicompanionProject: { id: 'mock-project' } } });
    case 'retrieveUserQuota': {
      const models = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'];
      const all = mock.hidePreviewModels ? models : ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', ...models];
      return json(res, 200, { buckets: all.map((modelId) => ({ modelId, remainingFraction: 0.9, remainingAmount: '100', resetTime: new Date(Date.now() + 3600e3).toISOString(), tokenType: 'REQUESTS' })) });
    }
    case 'listExperiments':
      return json(res, 200, { experimentIds: [], flags: [] });
    case 'countTokens':
      return json(res, 200, { totalTokens: 42 });
    case 'listModels':
      return json(res, 200, { models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    case 'generateContent':
    case 'streamGenerateContent':
      break;
    default:
      return json(res, 200, {});
  }
  const request = gemini.codeAssist ? body.request ?? {} : body;
  const model = gemini.model ?? body.model ?? 'gemini';
  if (limited) return json(res, 429, gemini.codeAssist ? CAPACITY_EXHAUSTED(model) : DAILY_QUOTA(model));
  if (geminiPrompt(request.contents).prompt.includes('SLOW')) await sleep(SLOW_MS);
  const schema = request.generationConfig?.responseJsonSchema ?? request.generationConfig?.responseSchema;
  const chunks = schema ? [[{ text: JSON.stringify(fillSchema(schema)) }]] : geminiAnswer(request);
  const candidate = (parts: any[], last: boolean) => wrap({
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(last ? { finishReason: 'STOP' } : {}) }],
    ...(last ? { usageMetadata: GEMINI_USAGE } : {}),
    modelVersion: model,
  });
  if (gemini.method === 'generateContent') return json(res, 200, candidate(chunks.flat(), true));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [index, parts] of chunks.entries()) {
    res.write(`data: ${JSON.stringify(candidate(parts, index === chunks.length - 1))}\n\n`);
    await sleep(15);
  }
  res.end();
}

export function startMockLlm(port = 0): Promise<MockLlm> {
  const requests: MockLlm['requests'] = [];
  const mock: MockLlm = {
    port: 0, requests, refuseCodex: false, refuseGemini: false, hidePreviewModels: false, limited: new Set(), limitedAuth: new Set(), close: async () => {},
  };
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
      const auth = req.headers.authorization ?? (req.headers['x-api-key'] as string | undefined) ?? (req.headers['x-goog-api-key'] as string | undefined);
      const gemini = geminiRequest(path);
      const model = gemini?.model ?? body.model;
      requests.push({ path, model, auth, body: JSON.stringify(body) });
      const limited = mock.limited.has(model) || [...mock.limitedAuth].some((credential) => auth?.includes(credential));
      if (gemini) {
        await geminiResponse(res, mock, gemini, body, limited);
      } else if (req.method === 'POST' && limited && path.endsWith('/messages')) {
        // Told not to retry, as with a subscription: an API key's client would keep trying for minutes.
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' } }));
      } else if (req.method === 'POST' && limited && path.endsWith('/responses')) {
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
  return new Promise((resolve, reject) => {
    // Not one the system picks: those overlap the ports tests give to workspaces, and a workspace
    // publishing this one would take its traffic, leaving every CLI with an empty reply.
    const listen = () => server.listen(port || 41000 + Math.floor(Math.random() * 5000), '0.0.0.0');
    server.on('listening', () => {
      mock.port = (server.address() as AddressInfo).port;
      mock.close = () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
      resolve(mock);
    });
    let attempts = 0;
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (port || error.code !== 'EADDRINUSE' || ++attempts > 20) reject(error);
      else listen();
    });
    listen();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockLlm(Number(process.argv[2] ?? 0));
  console.log(`mock LLM listening on ${mock.port}`);
}
