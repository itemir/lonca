import { useEffect, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import type { Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { runtimeName } from '../format.ts';
import { attempt, useStore } from '../store.ts';
import { Modal } from './ui.tsx';

/** While a workspace is changing state there's nothing to offer, and its row and banner show the progress. */
export function canClose(workspace: Workspace): boolean {
  return ['ready', 'stopped', 'error', 'archived'].includes(workspace.status);
}

/**
 * The trash icon archives, and deleting for good is for what's already archived. A failed archive or
 * delete is the exception: a delete may already have removed the branch, and deleting can still
 * finish where archiving can't, since it doesn't need the old runtime to start.
 */
function deletes(workspace: Workspace): boolean {
  if (workspace.status === 'error') return workspace.pendingOperation === 'archive' || workspace.pendingOperation === 'delete';
  return workspace.status === 'archived';
}

/** What the trash icon does, so its label can say so. */
export function closeVerb(workspace: Workspace): string {
  return deletes(workspace) ? 'Delete' : 'Archive';
}

function uncommittedLine(count: number | null): string {
  if (count === null) return 'Any uncommitted changes are lost.';
  if (count === 0) return 'No uncommitted changes.';
  return count === 1 ? '1 uncommitted change is lost.' : `${count} uncommitted changes are lost.`;
}

export function CloseWorkspaceDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const navigate = useNavigate();
  const onScreen = useMatch('/w/:id')?.params.id === workspace.id;
  const agentWorking = useStore((store) => store.sessions.some((session) => session.workspaceId === workspace.id && session.status === 'running'));
  const [uncommitted, setUncommitted] = useState<number | null>(null);
  const ready = workspace.status === 'ready';
  const runtime = runtimeName(workspace);

  // The dialog doesn't wait for this: a busy runtime can be slow to answer, and a stopped one isn't woken just to ask.
  useEffect(() => {
    if (!ready) return;
    api.changes(workspace.id).then((changes) => setUncommitted(changes.uncommitted), () => {});
  }, [ready, workspace.id]);

  const archive = () => {
    onClose();
    void attempt(() => api.workspaceAction(workspace.id, 'archive'));
  };

  const remove = () => {
    onClose();
    if (onScreen) navigate('/');
    void attempt(() => api.deleteWorkspace(workspace.id));
  };

  return (
    <Modal className="close-dialog" title={`${closeVerb(workspace)} this workspace?`} onClose={onClose}>
      <div className="close-target">
        <span>{workspace.title ?? workspace.name}</span>
        <code>{workspace.branch}</code>
      </div>
      <div className="confirm-body close-body">
        {workspace.status === 'archived' ? (
          <p>Its chat and branch are removed, including commits that were never pushed.</p>
        ) : deletes(workspace) ? (
          <p>Its {runtime}, checkout, chat and branch are removed, including commits that were never pushed.</p>
        ) : (
          <>
            <div>
              {agentWorking && <p className="close-warning">An agent is working here and will be stopped.</p>}
              <p>Its {runtime} and checkout are removed, along with any git-ignored files and attachments.</p>
              <p className={uncommitted ? 'close-warning' : undefined}>{uncommittedLine(uncommitted)}</p>
            </div>
            <p>Its branch and chat are kept, so you can restore it later or delete it for good from the archived list in the sidebar.</p>
          </>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" autoFocus onClick={onClose}>Cancel</button>
        {deletes(workspace)
          ? <button type="button" className="button button-danger" onClick={remove}>Delete permanently</button>
          : <button type="button" className="button button-primary" onClick={archive}>Archive</button>}
      </div>
    </Modal>
  );
}
