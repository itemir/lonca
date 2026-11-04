import fs from 'node:fs';

const script = fs.readFileSync(new URL('./process.py', import.meta.url), 'utf8');

/** Send the current protocol with each exec so existing workspace images use it too. */
export function agentProcessCommand(action: 'status' | 'follow' | 'signal', dir: string, ...args: string[]): string[] {
  // Keep project modules and Python startup settings out of the control helper's imports.
  return ['python3', '-I', '-c', script, action, dir, ...args];
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
