import { type ReactNode, useEffect, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import type { PrStatus } from '../../../shared/pr.ts';
import type { Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { usePrStatus, usePrStore } from '../pr.ts';
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

function agentWorkingIn(workspaceId: string): boolean {
  return useStore.getState().sessions.some((session) => session.workspaceId === workspaceId && session.status === 'running');
}

/**
 * What pressing the trash icon does, whether it's waiting to hear if it can archive without asking,
 * and the dialog it opens. Someone who said not to be asked is asked anyway when an agent is working
 * or there may be uncommitted changes. The page can be out of date, so the server has the last word.
 */
export function useCloseWorkspace(workspace: Workspace): { press: () => void; checking: boolean; dialog: ReactNode } {
  const [asking, setAsking] = useState<{ agentWorking?: boolean } | null>(null);
  const [checking, setChecking] = useState(false);

  const press = () => {
    if (checking) return;
    if (deletes(workspace) || useStore.getState().settings.confirmArchive || workspace.status !== 'ready' || agentWorkingIn(workspace.id)) {
      setAsking({});
      return;
    }
    setChecking(true);
    void attempt(() => api.archiveUnasked(workspace.id)).then((outcome) => {
      setChecking(false);
      if (outcome?.ask) setAsking({ agentWorking: outcome.agentWorking });
    });
  };

  const dialog = asking && <CloseWorkspaceDialog workspace={workspace} agentWorking={asking.agentWorking} onClose={() => setAsking(null)} />;
  // Once it's archiving, its row and banner show that instead.
  return { press, checking: checking && workspace.status === 'ready', dialog };
}

/** What archiving means for the branch's pull request, when there is one. */
function PrLines({ status, unpushed }: { status: PrStatus; unpushed: number | null }) {
  const pr = status.pr;
  if (!pr) return null;
  const { number, baseRefName: base } = pr;
  if (status.kind === 'closed') {
    return <p className="close-warning">#{number} was closed without merging, so this work isn’t in {base}. Its branch is kept.</p>;
  }
  if (status.kind !== 'merged') return null;
  return (
    <>
      <p>#{number} is merged into {base}.</p>
      {unpushed !== null && unpushed > 0 && (
        <p className="close-warning">
          {unpushed === 1
            ? `1 commit on this branch isn’t in #${number}, so it isn’t in ${base}. The branch keeps it.`
            : `${unpushed} commits on this branch aren’t in #${number}, so they aren’t in ${base}. The branch keeps them.`}
        </p>
      )}
    </>
  );
}

function uncommittedLine(count: number | null, running: boolean): string {
  if (count === null) return running ? 'Any uncommitted changes are lost.' : 'Any uncommitted changes are lost. They can’t be counted while it isn’t running.';
  if (count === 0) return 'No uncommitted changes.';
  return count === 1 ? '1 uncommitted change is lost.' : `${count} uncommitted changes are lost.`;
}

/** `agentWorking` is the server saying so, which a page that's behind may not know yet. */
export function CloseWorkspaceDialog({ workspace, agentWorking: serverSaysWorking, onClose }: { workspace: Workspace; agentWorking?: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const onScreen = useMatch('/w/:id')?.params.id === workspace.id;
  const agentWorking = useStore((store) => store.sessions.some((session) => session.workspaceId === workspace.id && session.status === 'running')) || serverSaysWorking;
  // Once someone has said not to be asked, they're only asked when something is at stake, and the box has nothing left to do.
  const asksEveryTime = useStore((store) => store.settings.confirmArchive);
  const [uncommitted, setUncommitted] = useState<number | null>(null);
  const [stopAsking, setStopAsking] = useState(false);
  const ready = workspace.status === 'ready';
  const pr = usePrStatus(workspace);
  // Only known from a read of this workspace's own checkout, which only the workspace on screen has.
  const read = usePrStore((store) => store.entries[workspace.id]?.good ?? null);
  const unpushed = read?.pr?.state === 'MERGED' && read.pr.number === pr.pr?.number ? read.local?.unpushed ?? null : null;

  // The dialog doesn't wait for this: a busy sandbox can be slow to answer, and a stopped one isn't woken just to ask.
  useEffect(() => {
    if (!ready) return;
    api.changes(workspace.id).then((changes) => setUncommitted(changes.uncommitted), () => {});
  }, [ready, workspace.id]);

  // Ticking the box and then cancelling leaves things as they were.
  const archive = () => {
    onClose();
    if (stopAsking) void attempt(() => api.updateSettings({ confirmArchive: false }));
    void attempt(() => api.workspaceAction(workspace.id, 'archive'));
  };

  const remove = () => {
    onClose();
    if (onScreen) navigate('/');
    void attempt(() => api.deleteWorkspace(workspace.id));
  };

  return (
    <Modal className="close-dialog sheet-dialog" title={`${closeVerb(workspace)} this workspace?`} onClose={onClose}>
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
              <PrLines status={pr} unpushed={unpushed} />
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
          : <button type="button" className="button button-primary" onClick={archive}>Archive</button>}
      </div>
    </Modal>
  );
}
