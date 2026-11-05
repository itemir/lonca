import type { ToolKind } from '../../shared/types.ts';

// What a Lead can do. The CLIs discover these from the script in lonca-tools.py.

export const TEAM_TOOLS = [
  {
    name: 'spawn_agent',
    description: 'Start a new agent in its own tab and give it its first instructions. Returns at once with its id: end your turn, and Lonca wakes you when it finishes. It shares your checkout but can\'t see what you or other agents have been told.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'A short name for its tab, such as "Analysis" or "Fix".' },
        model: { type: 'string', description: 'A model id from team_status.' },
        effort: { type: 'string', description: 'A thinking level the model offers, from team_status. Leave it out for the model\'s default.' },
        job: { type: 'string', enum: ['analyze', 'implement', 'review'], description: 'Only one agent at a time can have the job "implement", and it\'s the only one told it may change files.' },
        task: { type: 'string', description: 'Its instructions. It sees nothing else from you, so include what it needs.' },
      },
      required: ['label', 'model', 'job', 'task'],
    },
  },
  {
    name: 'message_agent',
    description: 'Send an agent you started a follow-up, such as a question, a challenge or the next piece of work. Queued if it\'s busy. Returns at once: end your turn, and Lonca wakes you when it answers.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The agent\'s id.' },
        text: { type: 'string', description: 'What to tell it.' },
        job: { type: 'string', enum: ['analyze', 'implement', 'review'], description: 'Give it a different job from now on.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'read_agent',
    description: 'Read what an agent reported at the end of its latest turn, or with view "activity", what it did during that turn.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The agent\'s id.' },
        view: { type: 'string', enum: ['report', 'activity'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'team_status',
    description: 'List your agents and their states, the models you can start agents on, and how many can work at once.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_agent',
    description: 'Stop an agent\'s current turn. Its conversation is kept, so you can message it again.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The agent\'s id.' } }, required: ['id'] },
  },
  {
    name: 'retry_agent',
    description: 'Have an agent pick up where it left off after a failure or a usage limit, in the same conversation.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The agent\'s id.' } }, required: ['id'] },
  },
];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function describeTeamTool(name: string, input: Record<string, unknown>): { kind: ToolKind; title: string; detail?: string; agentId?: string } {
  const agentId = str(input.id);
  switch (name) {
    case 'spawn_agent':
      return { kind: 'team', title: str(input.label) ? `Started ${str(input.label)}` : 'Started an agent', detail: str(input.task) };
    case 'message_agent':
      return { kind: 'team', title: 'Messaged', detail: str(input.text), agentId };
    case 'read_agent':
      return { kind: 'team', title: 'Read the report from', agentId };
    case 'stop_agent':
      return { kind: 'team', title: 'Stopped', agentId };
    case 'retry_agent':
      return { kind: 'team', title: 'Asked to try again:', agentId };
    case 'team_status':
      return { kind: 'team', title: 'Checked on the agents' };
    default:
      return { kind: 'team', title: name };
  }
}
