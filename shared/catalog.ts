import type { AgentId, Catalog, ModelOption } from './types.ts';

/**
 * Whether a provider's CLI reads a message sent while it works, at its next step. Codex's can't
 * while it runs as `codex exec`, nor Gemini's when it runs without a terminal, so a message to
 * either waits for the turn to end.
 */
export const READS_WHILE_WORKING: Record<AgentId, boolean> = { claude: true, codex: false, gemini: false };

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const claudeModel = (id: string, label: string): ModelOption => ({
  id,
  label,
  efforts: CLAUDE_EFFORTS,
  defaultEffort: 'high',
});

// Gemini's thinking levels, without MINIMAL, which a model can refuse: 3.5 Flash can be served as
// 3.8 Flash, which does.
const geminiModel = (id: string, label: string): ModelOption => ({
  id,
  label,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
});

/**
 * Codex's list is replaced at runtime with the catalog of the CLI in the workspace template.
 * Gemini's ships with the app, as Claude's does, since its CLI's own list is fixed too and leaves
 * out preview models.
 */
export const DEFAULT_CATALOG: Catalog = {
  claude: {
    label: 'Claude',
    models: [
      claudeModel('claude-opus-5-5', 'Opus 5.5'),
      claudeModel('claude-fable-5-2', 'Fable 5.2'),
      claudeModel('claude-sonnet-5-5', 'Sonnet 5.5'),
      claudeModel('claude-haiku-5-5', 'Haiku 5.5'),
    ],
  },
  codex: {
    label: 'Codex',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    ],
  },
  gemini: {
    label: 'Gemini',
    models: [
      geminiModel('gemini-3.1-pro-preview', 'Gemini 3.1 Pro'),
      geminiModel('gemini-3.5-flash', 'Gemini 3.5 Flash'),
      geminiModel('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'),
    ],
  },
};
