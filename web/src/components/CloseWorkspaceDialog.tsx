import { type ReactNode, useEffect, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import type { Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
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

function archive(workspace: Workspace) {
  void attempt(() => api.workspaceAction(workspace.id, 'archive'));
}

function agentWorkingIn(workspaceId: string): boolean {
  return useStore.getState().sessions.some((session) => session.workspaceId === workspaceId && session.status === 'running');
}

/**
 * Archiving goes ahead without asking only for someone who said not to be asked, and even then only
 * when nothing they'd want warning of is lost: an agent at work is stopped, and uncommitted changes
 * are lost. Those can only be counted while the workspace is running.
 */
function mayArchiveUnasked(workspace: Workspace): boolean {
  return !deletes(workspace) && !useStore.getState().settings.confirmArchive && workspace.status === 'ready' && !agentWorkingIn(workspace.id);
}

// A busy sandbox can be slow to answer. After this long the dialog asks instead, and goes on counting.
const COUNT_PATIENCE_MS = 3000;

function countUncommitted(workspace: Workspace): Promise<number | undefined> {
  return Promise.race([
    api.changes(workspace.id).then((changes) => changes.uncommitted, () => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, COUNT_PATIENCE_MS)),
  ]);
}

/** What pressing the trash icon does, whether it's counting changes first, and the dialog it opens. */
export function useCloseWorkspace(workspace: Workspace): { press: () => void; checking: boolean; dialog: ReactNode } {
  const [asking, setAsking] = useState<{ uncommitted?: number } | null>(null);
  const [checking, setChecking] = useState(false);

  const press = () => {
    if (checking) return;
    if (!mayArchiveUnasked(workspace)) {
      setAsking({});
      return;
    }
    setChecking(true);
    void countUncommitted(workspace).then((uncommitted) => {
      setChecking(false);
      // Things can move on while it counts, and someone else may have closed it already.
      const current = useStore.getState().workspaces.find((entry) => entry.id === workspace.id);
      if (!current || !canClose(current)) return;
      if (uncommitted === 0 && mayArchiveUnasked(current)) archive(current);
      else setAsking({ uncommitted });
    });
  };

  const dialog = asking && <CloseWorkspaceDialog workspace={workspace} counted={asking.uncommitted} onClose={() => setAsking(null)} />;
  return { press, checking, dialog };
}

function uncommittedLine(count: number | null, running: boolean): string {
  if (count === null) return running ? 'Any uncommitted changes are lost.' : 'Any uncommitted changes are lost. They can’t be counted while it isn’t running.';
  if (count === 0) return 'No uncommitted changes.';
  return count === 1 ? '1 uncommitted change is lost.' : `${count} uncommitted changes are lost.`;
}

export function CloseWorkspaceDialog({ workspace, counted, onClose }: { workspace: Workspace; counted?: number; onClose: () => void }) {
  const navigate = useNavigate();
  const onScreen = useMatch('/w/:id')?.params.id === workspace.id;
  const agentWorking = useStore((store) => store.sessions.some((session) => session.workspaceId === workspace.id && session.status === 'running'));
  // Once someone has said not to be asked, they're only asked when something is at stake, and the box has nothing left to do.
  const asksEveryTime = useStore((store) => store.settings.confirmArchive);
  const [uncommitted, setUncommitted] = useState<number | null>(counted ?? null);
  const [stopAsking, setStopAsking] = useState(false);
  const ready = workspace.status === 'ready';

  // The dialog doesn't wait for this: a busy sandbox can be slow to answer, and a stopped one isn't woken just to ask.
  useEffect(() => {
    if (!ready) return;
    api.changes(workspace.id).then((changes) => setUncommitted(changes.uncommitted), () => {});
  }, [ready, workspace.id]);

  // Ticking the box and then cancelling leaves things as they were.
  const confirmArchive = () => {
    onClose();
    if (stopAsking) void attempt(() => api.updateSettings({ confirmArchive: false }));
    archive(workspace);
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
          <p>Its virtual machine, checkout, chat and branch are removed, including commits that were never pushed.</p>
        ) : (
          <>
            <div>
              {agentWorking && <p className="close-warning">An agent is working here and will be stopped.</p>}
              <p>Its virtual machine and checkout are removed, along with any git-ignored files and attachments.</p>
              <p className={uncommitted || !ready ? 'close-warning' : undefined}>{uncommittedLine(uncommitted, ready)}</p>
            </div>
            <p>Its branch and chat are kept, so you can restore it later or delete it for good from the archived list in the sidebar.</p>
          </>
        )}
      </div>
      <div className="modal-actions">
        {!deletes(workspace) && asksEveryTime && (
          <label className="close-stop-asking">
            <input type="checkbox" checked={stopAsking} onChange={(event) => setStopAsking(event.target.checked)} />
            Don’t ask again
          </label>
        )}
        <button type="button" className="button" autoFocus onClick={onClose}>Cancel</button>
        {deletes(workspace)
          ? <button type="button" className="button button-danger" onClick={remove}>Delete permanently</button>
          : <button type="button" className="button button-primary" onClick={confirmArchive}>Archive</button>}
      </div>
    </Modal>
  );
}
