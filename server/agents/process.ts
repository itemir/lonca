import crypto from 'node:crypto';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('./process.py', import.meta.url), 'utf8');
const inboxScript = fs.readFileSync(new URL('./inbox.py', import.meta.url), 'utf8');

/**
 * Starts a CLI that reads messages while it works, with inbox.py passing them on, `uuid` first.
 * It's sent with each run, as process.py is, so a VM needs no new template for it.
 */
export function inboxCommand(dir: string, uuid: string, command: string[]): string[] {
  return ['python3', '-I', '-c', inboxScript, dir, uuid, ...command];
}

/** What a CLI that wants a UUID for each message calls this one. The same id always gives the same UUID. */
export function messageUuid(id: string): string {
  const hex = crypto.createHash('sha256').update(`lonca-message:${id}`).digest('hex');
  const variant = (8 | (parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Send the current protocol with each exec so existing VMs use it too. */
export function agentProcessCommand(action: 'status' | 'follow' | 'signal', dir: string, ...args: string[]): string[] {
  // Keep project modules and Python startup settings out of the control helper's imports.
  return ['python3', '-I', '-c', script, action, dir, ...args];
}

const toolsScript = fs.readFileSync(new URL('./lonca-tools.py', import.meta.url), 'utf8');

/** A Lead's tools, with what they offer written into the script so that one file carries it all. */
export function leadToolsScript(tools: unknown): string {
  return `TOOLS = ${JSON.stringify(JSON.stringify(tools))}\n${toolsScript}`;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Tool calls reach the server on the follower's stderr, ahead of its final receipt. */
export function parseToolCall(line: string): ToolCall | null {
  if (!line.startsWith('LONCA_CALL ')) return null;
  try {
    const call = JSON.parse(line.slice('LONCA_CALL '.length)) as ToolCall;
    // The id becomes a file name in the workspace, and an agent could have written this.
    if (typeof call.id !== 'string' || !/^[a-f0-9]{32}$/.test(call.id) || typeof call.tool !== 'string') return null;
    return { id: call.id, tool: call.tool, args: call.args && typeof call.args === 'object' ? call.args : {} };
  } catch {
    return null;
  }
}

export interface AgentOutputReceipt {
  code: number | null;
  stderr: string;
  end?: number;
  unavailable?: string;
}

/** Runtime diagnostics may precede the helper's final receipt on stderr. */
export function parseOutputReceipt(stderr: string): AgentOutputReceipt | null {
  const line = stderr.split('\n').findLast((line) => line.startsWith('LONCA_OUTPUT '));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice('LONCA_OUTPUT '.length)) as AgentOutputReceipt;
    if (typeof value.stderr !== 'string' || !(value.code === null || Number.isSafeInteger(value.code))) return null;
    if (Number.isSafeInteger(value.end) && value.end! >= 0 || typeof value.unavailable === 'string') return value;
  } catch { /* A disconnected stream may end partway through the receipt. */ }
  return null;
}
