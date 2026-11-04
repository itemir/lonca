import { useState } from 'react';
import { useStore } from '../store.ts';
import { api } from '../api.ts';
import { Modal } from './ui.tsx';

type Source = 'url' | 'path';

export function AddProjectDialog() {
  const open = useStore((store) => store.addProjectOpen);
  const setOpen = useStore((store) => store.setAddProjectOpen);
  const [source, setSource] = useState<Source>('url');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    setValue('');
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addProject(source === 'url' ? { url: value } : { path: value });
      close();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a project" onClose={close}>
      <form onSubmit={submit}>
        <div className="segmented" role="tablist" aria-label="Where the project comes from">
          <button type="button" role="tab" aria-selected={source === 'url'} className={source === 'url' ? 'active' : ''} onClick={() => setSource('url')}>GitHub repository</button>
          <button type="button" role="tab" aria-selected={source === 'path'} className={source === 'path' ? 'active' : ''} onClick={() => setSource('path')}>Folder on this computer</button>
        </div>
        <label className="field">
          <span className="field-label">{source === 'url' ? 'Repository' : 'Path to a git repository'}</span>
          <input
            className="input input-mono"
            autoFocus
            value={value}
            placeholder={source === 'url' ? 'owner/repo or https://github.com/owner/repo' : '~/Projects/my-app'}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p className="field-help">
          {source === 'url'
            ? 'Cloned with your git credentials on this computer. Workspaces branch from its default branch.'
            : 'Lonca makes its own copy, so your checkout is never changed. Workspaces branch from the repository’s origin when it has one.'}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={close}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={busy || !value.trim()}>{busy ? 'Adding…' : 'Add project'}</button>
        </div>
      </form>
    </Modal>
  );
}
