// A scripted stand-in for the Anthropic Messages and OpenAI Responses APIs that plays one scene for
// the README's GIF: a Lead has Claude build night mode, Codex review it, and Claude fix what the
// review found. The real `claude` and `codex` CLIs run in a real VM; only the model is scripted.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const USER_ASK = 'Add a night mode to Settings, for reading the logbook on night watches. Get it reviewed before it’s done.';
const BUILD_TASK = 'Add a night mode to the logbook: a `night` setting, off by default, and a function that applies it to the page. Keep the tests passing.';
const REVIEW_TASK = 'Review the night mode change in this checkout (`git diff`). Report problems, most important first. Don’t change any files.';
const FIX_TEXT = 'Codex reviewed your change. With nothing saved, night mode should follow the system setting (prefers-color-scheme) rather than start off. Fix that and run the tests again.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root = '';
/** Where the workspace's checkout is, for the absolute paths Claude's file tools need. */
export function setWorkspaceRoot(path: string): void {
  root = path;
}

type Call = { name: string; input: Record<string, unknown> };
type Action = { text?: string; calls?: Call[]; pause?: number };

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Every string in a request, joined, for finding what a conversation has been told. */
function allText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(allText).join('\n');
  return '';
}

function idOf(history: string, label: string): string {
  const found = [...history.matchAll(new RegExp(`"${label}" \\([^)]*?id ([0-9a-f]{12})\\)`, 'g'))];
  return found.at(-1)?.[1] ?? 'unknown';
}

// --- Claude ---------------------------------------------------------------------------------

function isToolResult(message: any): boolean {
  return Array.isArray(message?.content) && message.content.some((block: any) => block?.type === 'tool_result');
}

/** The latest message from the user (or the Lead, or Lonca), and how many tool results have come back since. */
function claudeTurn(body: any): { asked: string; asks: string[]; step: number } {
  const messages: any[] = (body.messages ?? []).filter((message: any) => message.role === 'user');
  const asks = messages.filter((message) => !isToolResult(message)).map((message) => allText(message.content));
  const last = (body.messages ?? []).findLastIndex((message: any) => message.role === 'user' && !isToolResult(message));
  const step = (body.messages ?? []).slice(last + 1).filter((message: any) => message.role === 'user' && isToolResult(message)).length;
  return { asked: asks.at(-1) ?? '', asks, step };
}

function leadAction(body: any): Action {
  const { asked, asks, step } = claudeTurn(body);
  const history = allText(body.messages);
  const build = idOf(history, 'Build');
  const review = idOf(history, 'Review');
  const buildsDone = asks.filter((ask) => ask.includes('"Build"') && ask.includes('finished')).length;
  if (asked.includes('"Review"') && asked.includes('finished')) {
    if (step === 0) return { calls: [{ name: 'read_agent', input: { id: review } }], pause: 900 };
    if (step === 1) {
      return {
        text: 'Codex found one problem: with nothing saved, night mode ignores the system setting. Sending it back to Build.',
        calls: [{ name: 'message_agent', input: { id: build, text: FIX_TEXT } }],
        pause: 1200,
      };
    }
    return { text: 'Build is fixing it.' };
  }
  if (asked.includes('"Build"') && asked.includes('finished') && buildsDone >= 2) {
    if (step === 0) return { calls: [{ name: 'read_agent', input: { id: build } }], pause: 900 };
    return { text: 'Done. Claude built night mode, Codex reviewed it, and Claude fixed the one problem the review found. The tests pass, and the branch is ready for a pull request.', pause: 1200 };
  }
  if (asked.includes('"Build"') && asked.includes('finished')) {
    if (step === 0) return { calls: [{ name: 'read_agent', input: { id: build } }], pause: 900 };
    if (step === 1) {
      return {
        text: 'Build added the setting, and the tests pass. Now a review, from a different model.',
        calls: [{ name: 'spawn_agent', input: { label: 'Review', model: 'gpt-5.5', job: 'review', task: REVIEW_TASK } }],
        pause: 1200,
      };
    }
    return { text: 'Waiting for the review.' };
  }
  if (step === 0) {
    return {
      text: 'I’ll have Claude build it, then get Codex to review it.',
      calls: [{ name: 'spawn_agent', input: { label: 'Build', model: 'claude-sonnet-5-5', job: 'implement', task: BUILD_TASK } }],
      pause: 1500,
    };
  }
  return { text: 'Build is on it. I’ll check its work when it’s done.' };
}

const SETTINGS_DEFAULTS = "export const defaults = { units: 'nautical', vessel: 'Ruya' };";
const SAVE = "export function saveSettings(settings, storage = localStorage) {\n  storage.setItem('settings', JSON.stringify(settings));\n}";
const LOAD = "export function loadSettings(storage = localStorage) {\n  const saved = JSON.parse(storage.getItem('settings') ?? '{}');\n  return { ...defaults, ...saved };\n}";

function builderAction(body: any): Action {
  const { asked, step } = claudeTurn(body);
  const system = allText(body.system);
  const cwd = root || (/(?:Primary working directory|Working directory): ([^\n]+)/.exec(system)?.[1]?.trim() ?? '.');
  const file = `${cwd}/src/settings.js`;
  if (asked.includes('prefers-color-scheme')) {
    if (step === 0) return { text: 'Making the system setting the default.', calls: [{ name: 'Read', input: { file_path: file } }], pause: 1000 };
    if (step === 1) {
      return {
        calls: [{
          name: 'Edit',
          input: {
            file_path: file,
            old_string: LOAD,
            new_string: "export function loadSettings(storage = localStorage, prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false) {\n  const saved = JSON.parse(storage.getItem('settings') ?? '{}');\n  return { ...defaults, night: prefersDark, ...saved };\n}",
          },
        }],
        pause: 1200,
      };
    }
    if (step === 2) return { calls: [{ name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }], pause: 800 };
    return { text: 'With nothing saved, night mode now follows the system setting. The tests pass.', pause: 800 };
  }
  if (step === 0) return { text: 'I’ll start with the settings module.', calls: [{ name: 'Read', input: { file_path: file } }], pause: 1000 };
  if (step === 1) {
    return {
      calls: [{ name: 'Edit', input: { file_path: file, old_string: SETTINGS_DEFAULTS, new_string: "export const defaults = { units: 'nautical', vessel: 'Ruya', night: false };" } }],
      pause: 1000,
    };
  }
  if (step === 2) {
    return {
      calls: [{ name: 'Edit', input: { file_path: file, old_string: SAVE, new_string: `${SAVE}\n\nexport function applyNightMode(settings, root = document.documentElement) {\n  root.classList.toggle('night', settings.night);\n}` } }],
      pause: 1000,
    };
  }
  if (step === 3) return { calls: [{ name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }], pause: 800 };
  return { text: 'Added a `night` setting, off by default, and `applyNightMode`, which puts a `night` class on the page. The tests pass.', pause: 800 };
}

async function streamClaude(res: http.ServerResponse, body: any, action: Action, counter: number): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id: `msg_demo_${counter}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } },
  });
  await sleep(action.pause ?? 600);
  let index = 0;
  if (action.text) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const part of action.text.match(/.{1,6}/gs) ?? []) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
      await sleep(22);
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  for (const [offset, call] of (action.calls ?? []).entries()) {
    const name = ['Read', 'Edit', 'Bash'].includes(call.name) ? call.name : `mcp__lonca__${call.name}`;
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_demo_${counter}_${offset}`, name, input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  const stop = action.calls?.length ? 'tool_use' : 'end_turn';
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// --- Codex ----------------------------------------------------------------------------------

function codexTools(body: any): any[] {
  const flatten = (tools: any[]): any[] => tools.flatMap((tool) => (tool.type === 'namespace' ? flatten(tool.tools ?? []) : [tool]));
  const additional = (body.input ?? []).filter((item: any) => item.type === 'additional_tools');
  return flatten([...(body.tools ?? []), ...additional.flatMap((item: any) => item.tools ?? [])]);
}

function codexShellCall(tools: any[], command: string, callId: string): unknown {
  const code = tools.find((tool) => tool.type === 'custom' && tool.name === 'exec');
  if (code) {
    return { type: 'custom_tool_call', id: `ctc_${callId}`, call_id: callId, name: 'exec', input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)} }); text(JSON.stringify(result));` };
  }
  const shell = tools.find((tool) => ['shell_command', 'exec_command', 'shell'].includes(tool.name));
  if (!shell) return null;
  const args = shell.name === 'exec_command' ? { cmd: command } : shell.name === 'shell_command' ? { command } : { command: ['bash', '-lc', command] };
  return { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: shell.name, arguments: JSON.stringify(args) };
}

async function streamCodex(res: http.ServerResponse, body: any, counter: number): Promise<void> {
  const input: any[] = Array.isArray(body.input) ? body.input : [];
  const lastUser = input.findLastIndex((item) => item.type === 'message' && item.role === 'user');
  const step = input.slice(lastUser + 1).filter((item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output').length;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'response.created', { type: 'response.created', response: { id: `resp_demo_${counter}` } });
  await sleep(step === 0 ? 1200 : 1500);
  const call = step === 0 ? codexShellCall(codexTools(body), 'git diff', `call_${counter}`) : null;
  if (call) {
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', item: call });
  } else {
    const text = 'One problem: with nothing saved, night mode starts off even when the system is set to dark. Default it to `prefers-color-scheme`. The rest looks right: it’s off by default, and the tests pass.';
    const itemId = `msg_${counter}`;
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', item: { type: 'message', id: itemId, role: 'assistant', content: [] } });
    sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, delta: text });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', item: { type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text }] } });
  }
  sse(res, 'response.completed', {
    type: 'response.completed',
    response: { id: `resp_demo_${counter}`, usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 32 } },
  });
  res.end();
}

// --- Server ---------------------------------------------------------------------------------

export interface Director { port: number; close(): Promise<void> }

export function startDirector(port: number, log?: string): Promise<Director> {
  let counter = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const path = (req.url ?? '').split('?')[0];
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        // Some background calls send other bodies; they get the default reply.
      }
      counter++;
      const tools: string[] = (body.tools ?? []).map((tool: any) => tool.name);
      const role = tools.includes('mcp__lonca__spawn_agent') ? 'lead' : tools.includes('Edit') ? 'builder' : path.endsWith('/responses') ? 'codex' : 'other';
      if (log) fs.appendFileSync(log, `${new Date().toISOString()} ${req.method} ${path} ${role} model=${body.model ?? ''} stream=${body.stream ?? ''}\n`);
      try {
        if (req.method === 'POST' && path.endsWith('/messages/count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 12 }));
        } else if (req.method === 'POST' && path.endsWith('/messages') && body.stream && (role === 'lead' || role === 'builder')) {
          const action = role === 'lead' ? leadAction(body) : builderAction(body);
          if (log) fs.appendFileSync(log, `  -> ${JSON.stringify(action).slice(0, 300)}\n`);
          await streamClaude(res, body, action, counter);
        } else if (req.method === 'POST' && path.endsWith('/messages') && body.stream) {
          await streamClaude(res, body, { text: 'OK', pause: 50 }, counter);
        } else if (req.method === 'POST' && path.endsWith('/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: `msg_demo_${counter}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }));
        } else if (req.method === 'POST' && path.endsWith('/responses')) {
          await streamCodex(res, body, counter);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [], models: [] }));
        }
      } catch (error) {
        if (log) fs.appendFileSync(log, `  !! ${String(error)}\n`);
        res.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve({
      port: (server.address() as AddressInfo).port,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
    }));
  });
}
