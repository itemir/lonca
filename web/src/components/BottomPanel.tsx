import { useEffect, useRef, useState } from 'react';
import { AppWindow, ChevronDown, Play, Plus, Square, X } from 'lucide-react';
import type { Project, Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { usePolled } from '../hooks.ts';
import { attempt, useStore } from '../store.ts';
import { IconButton } from './ui.tsx';
import { TerminalNotice, TerminalView } from './TerminalView.tsx';
import { openTerminalWindow } from './TerminalWindow.tsx';

export function BottomPanel({ workspace, project, onCollapse }: { workspace: Workspace; project: Project; onCollapse: () => void }) {
  const terminals = useStore((store) => store.terminals);
  const mine = terminals.filter((terminal) => terminal.workspaceId === workspace.id);
  const shells = mine.filter((terminal) => terminal.kind === 'shell');
  const setup = mine.find((terminal) => terminal.kind === 'setup');
  const [selection, setSelection] = useState('');
  const creating = useRef(false);
  const ready = workspace.status === 'ready';

  // Repository setup scripts can change inside the workspace, independently of settings.
  const scripts = usePolled(ready ? () => api.scripts(workspace.id) : null, 30000, [workspace.id, ready, project.settings.setupScript]);
  const hasScript = Boolean(scripts.data?.setup ?? project.settings.setupScript.trim());
  // The tab is for projects with a script, and stays for as long as the chat points to it.
  const setupRan = workspace.steps.some((step) => step.id === 'setup' && step.status !== 'pending');
  const hasSetupTab = hasScript || setupRan;
  const showingSetup = selection === 'setup' && hasSetupTab;

  const selectedShell = shells.find((terminal) => terminal.id === selection) ?? shells[0];
  const selected = showingSetup ? setup : selectedShell;

  useEffect(() => {
    setSelection('');
  }, [workspace.id]);

  // Every workspace opens with a terminal ready to type in.
  useEffect(() => {
    if (!ready || shells.length > 0 || creating.current) return;
    creating.current = true;
    attempt(() => api.createTerminal(workspace.id)).finally(() => {
      creating.current = false;
    });
  }, [ready, shells.length, workspace.id]);

  const moveToWindow = () => {
    if (!selectedShell || !openTerminalWindow(selectedShell.id) || selectedShell.windowed) return;
    // The panel carries on with another terminal if it has one.
    const next = shells.find((terminal) => terminal.id !== selectedShell.id && !terminal.windowed);
    if (next) setSelection(next.id);
  };

  return (
    <section className="bottom-panel" aria-label="Terminals">
      <div className="bottom-tabs">
        <IconButton label="Hide terminals" onClick={onCollapse}><ChevronDown size={15} /></IconButton>
        <div className="bottom-tab-list" role="tablist">
          {hasSetupTab && (
            <button type="button" role="tab" aria-selected={showingSetup} className={`bottom-tab ${showingSetup ? 'active' : ''}`} onClick={() => setSelection('setup')}>
              Setup
              {setup?.status === 'running' && <span className="live-dot" />}
            </button>
          )}
          {shells.map((terminal) => {
            const active = !showingSetup && selectedShell?.id === terminal.id;
            return (
              <div key={terminal.id} className={`bottom-tab terminal-tab ${active ? 'active' : ''}`}>
                <button type="button" role="tab" aria-selected={active} onClick={() => setSelection(terminal.id)}>
                  {terminal.title}
                </button>
                {shells.length > 1 && (
                  <button type="button" className="tab-close" aria-label={`Close ${terminal.title}`} onClick={() => void attempt(() => api.closeTerminal(terminal.id))}>
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
          <IconButton
            label="New terminal"
            disabled={!ready}
            onClick={async () => {
              const created = await attempt(() => api.createTerminal(workspace.id));
              if (created) setSelection(created.id);
            }}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        {showingSetup && (hasScript || setup?.status === 'running') && ready && (
          setup?.status === 'running' ? (
            <IconButton label="Stop the setup script" onClick={() => void attempt(() => api.stopSetupScript(workspace.id))}>
              <Square size={13} />
            </IconButton>
          ) : (
            <IconButton label="Start the setup script" onClick={() => void attempt(() => api.runSetupScript(workspace.id))}>
              <Play size={14} />
            </IconButton>
          )
        )}
        {!showingSetup && selectedShell && (
          <IconButton
            className="terminal-window-button"
            label={selectedShell.windowed ? `Show the window for ${selectedShell.title}` : `Move ${selectedShell.title} to a separate window`}
            onClick={moveToWindow}
          >
            <AppWindow size={15} />
          </IconButton>
        )}
      </div>
      <div className="terminal-stack">
        {mine.filter((terminal) => !terminal.windowed).map((terminal) => (
          <TerminalView key={terminal.id} id={terminal.id} active={selected?.id === terminal.id} autoFocus={false} />
        ))}
        {showingSetup && !setup && <div className="panel-empty">No output to show.{hasScript && ready && ' Press play to run the setup script.'}</div>}
        {!showingSetup && !selectedShell && <div className="panel-empty">{ready ? 'Opening a terminal…' : 'The terminal opens once the workspace is running.'}</div>}
        {selected?.windowed && (
          <div className="terminal-exit terminal-away">
            <span>This terminal is in a separate window. Closing that window brings it back here, still running.</span>
            <button type="button" className="link-button" onClick={() => void attempt(() => api.closeTerminalWindow(selected.id))}>
              Bring it back
            </button>
          </div>
        )}
        {selected && !selected.windowed && <TerminalNotice terminal={selected} canRestart={ready} />}
      </div>
    </section>
  );
}
