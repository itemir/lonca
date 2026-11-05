import { useEffect, useState } from 'react';
import type { Playbook } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, useStore } from '../store.ts';

/** The instructions Leads follow: the global file, or with `project`, that project's own. */
export function PlaybookEditor({ project }: { project?: string }) {
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [text, setText] = useState('');
  const toast = useStore((store) => store.toast);

  const show = (loaded: Playbook | undefined) => {
    if (!loaded) return;
    setPlaybook(loaded);
    setText(loaded.content);
  };

  useEffect(() => {
    void attempt(() => api.playbook(project)).then(show);
  }, [project]);

  if (!playbook) return null;

  const custom = project ? playbook.source === 'project' : playbook.source === 'global';
  const save = async () => {
    const saved = await attempt(() => api.savePlaybook(text, project));
    if (saved) {
      show(saved);
      toast('Saved. Leads follow it from their next turn.');
    }
  };
  const reset = async () => {
    const restored = await attempt(() => api.resetPlaybook(project));
    if (restored) {
      show(restored);
      toast(project ? 'This project’s Leads now use the default playbook.' : 'Back to the template.');
    }
  };

  return (
    <div className="playbook">
      {project && <p className="field-help playbook-source">{custom ? 'This project has its own playbook, in place of the one in Settings.' : 'This project uses the playbook from Settings. Saving here gives it its own.'}</p>}
      <label className="field playbook-field">
        <span className="sr-only">Lead playbook</span>
        <textarea className="input input-mono playbook-text" rows={18} wrap="off" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
        <span className="field-help">Kept outside every workspace, so agents can’t change it. Leads follow it from their next turn.</span>
      </label>
      <div className="inline-actions">
        <button type="button" className="button button-primary" disabled={!text.trim() || text === playbook.content} onClick={() => void save()}>Save playbook</button>
        {custom && <button type="button" className="button" onClick={() => void reset()}>{project ? 'Use the default' : 'Reset to the template'}</button>}
      </div>
    </div>
  );
}
