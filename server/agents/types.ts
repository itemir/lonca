import type { Attachment, ChatItem, Project, Session, Workspace } from '../../shared/types.ts';

export type ChatOp =
  | { op: 'upsert'; item: ChatItem }
  | { op: 'delta'; itemId: string; text: string }
  | { op: 'remove'; itemId: string }
  | { op: 'resume'; id: string };

/** Turns one agent CLI's JSONL output into chat items. */
export interface AgentParser {
  line(event: unknown): ChatOp[];
  /** Closes anything still open once the process has exited. */
  finish(): ChatOp[];
}

export interface TurnContext {
  session: Session;
  workspace: Workspace;
  project: Project;
  systemPrompt: string;
  attachments: Attachment[];
  /** How the CLI starts the Lead's tools, for a Lead. */
  tools?: { command: string; args: string[] };
}

export interface AgentAdapter {
  command(context: TurnContext): string[];
  parser(runId: string): AgentParser;
}

export const TOOL_OUTPUT_LIMIT = 16 * 1024;
const EDIT_TEXT_LIMIT = 8 * 1024;

export function clipOutput(output: string): { output: string; outputTruncated?: boolean } {
  if (output.length <= TOOL_OUTPUT_LIMIT) return { output };
  return { output: output.slice(0, TOOL_OUTPUT_LIMIT), outputTruncated: true };
}

export function clipEdit(text: unknown): string {
  return typeof text === 'string' ? text.slice(0, EDIT_TEXT_LIMIT) : '';
}
