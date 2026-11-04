import type { Catalog, ModelOption } from './types.ts';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const claudeModel = (id: string, label: string): ModelOption => ({
  id,
  label,
  efforts: CLAUDE_EFFORTS,
  defaultEffort: 'high',
});

/** Codex's list is replaced at runtime with the catalog of the CLI in the workspace image. */
export const DEFAULT_CATALOG: Catalog = {
  claude: {
    label: 'Claude',
    models: [
      claudeModel('claude-opus-5-5', 'Opus 5.5'),
      claudeModel('claude-fable-5-1', 'Fable 5.1'),
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
};
