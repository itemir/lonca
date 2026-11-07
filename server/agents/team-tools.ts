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
        sign_in: { type: 'string', description: 'A sign-in id from team_status, of the model\'s provider, for when it has several. Leave it out to use yours, or for another provider, its default.' },
      },
      required: ['label', 'model', 'job', 'task'],
    },
  },
  {
    name: 'message_agent',
    description: 'Send an agent you started a follow-up, such as a question, a challenge or the next piece of work. If it\'s working, a Claude agent reads it at its next step, and a Codex agent when its turn ends. Returns at once: end your turn, and Lonca wakes you when it answers.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The agent\'s id.' },
        text: { type: 'string', description: 'What to tell it.' },
        job: { type: 'string', enum: ['analyze', 'implement', 'review'], description: 'Give it a different job once its current turn and queued messages have finished.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'read_agent',
    description: 'Read what an agent reported at the end of its latest turn, or with view "activity", what it did during that turn. Either says what went wrong, if anything did.',
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
    description: 'List your agents and their states, the models and sign-ins you can start agents on, which sign-ins are at a usage limit, and how many agents can work at once.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_agent',
    description: 'Stop an agent\'s current turn. Its conversation is kept, so you can message it again.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The agent\'s id.' } }, required: ['id'] },
  },
  {
    name: 'retry_agent',
    description: 'Have an agent pick up where it left off after a failure or a usage limit, in the same conversation. At a usage limit, it can carry on on another sign-in of the same provider.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The agent\'s id.' },
        sign_in: { type: 'string', description: 'A sign-in id from team_status, of the agent\'s provider, to carry on on. Leave it out to stay on the one it has.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'forward_port',
    description: 'Forward a port on the user\'s localhost to a port in this virtual machine, so the user can open a server running here. Returns the URL to give them, and what\'s listening on the port: a server has to listen on 0.0.0.0, not only localhost, to be reachable. Forwards close when the workspace stops.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', description: 'The port in this virtual machine.' },
        host_port: { type: 'integer', description: 'The port on the user\'s localhost. Leave it out to use the same number if it\'s free, or else one Lonca chooses.' },
      },
      required: ['port'],
    },
  },
  {
    name: 'close_port',
    description: 'Stop forwarding a port you forwarded with forward_port.',
    inputSchema: { type: 'object', properties: { port: { type: 'integer', description: 'The port in this virtual machine.' } }, required: ['port'] },
  },
  {
    name: 'list_ports',
    description: 'List the ports the user can open on their localhost: this workspace\'s ten published ports and what you\'ve forwarded, each with what\'s listening on it.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function portText(value: unknown): string | undefined {
  return (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)) ? String(value) : undefined;
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
    case 'forward_port': {
      const port = portText(input.port);
      const hostPort = portText(input.host_port);
      return { kind: 'web', title: `${port ? `Forwarded port ${port}` : 'Forwarded a port'}${hostPort ? ` to localhost:${hostPort}` : ''}` };
    }
    case 'close_port':
      return { kind: 'web', title: portText(input.port) ? `Stopped forwarding port ${portText(input.port)}` : 'Stopped forwarding a port' };
    case 'list_ports':
      return { kind: 'web', title: 'Checked the ports' };
    default:
      return { kind: 'team', title: name };
  }
}
