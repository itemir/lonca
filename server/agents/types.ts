import type { Attachment, ChatItem, Project, Session, Workspace } from '../../shared/types.ts';

export type ChatOp =
  | { op: 'upsert'; item: ChatItem }
  | { op: 'delta'; itemId: string; text: string }
  | { op: 'remove'; itemId: string }
  | { op: 'resume'; id: string }
  /** The CLI has read the message with this uuid, which may have been sent while it worked. */
  | { op: 'delivered'; uuid: string }
  /** The same process began another turn, for what it was sent while it finished the last one. */
  | { op: 'turn' };

/** The result of a run's first turn, or of a later one by the same process. */
export function resultId(runId: string, turn: number): string {
  return turn > 1 ? `${runId}:result:${turn}` : `${runId}:result`;
}

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
  /** Settings for this process alone, such as where its sign-in is used. */
  config?: string[];
}

export interface AgentAdapter {
  command(context: TurnContext): string[];
  /** For a turn of this session, which says what model it asked for. */
  parser(runId: string, session: Pick<Session, 'model'>): AgentParser;
  /** Its CLI reads messages from the run's inbox while it works, and echoes each one it reads. */
  readsWhileWorking: boolean;
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
