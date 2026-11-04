import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, Play, Plus, RotateCcw, Square, X } from 'lucide-react';
import type { Project, TerminalInfo, Workspace } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { usePolled } from '../hooks.ts';
import { attempt, useStore } from '../store.ts';
import { IconButton } from './ui.tsx';
import { TerminalView } from './TerminalView.tsx';

type Selection = 'setup' | 'run' | string;

function ScriptEmpty({ kind, project, hasScript }: { kind: 'setup' | 'run'; project: Project; hasScript: boolean }) {
  const blurb = kind === 'setup'
    ? 'A setup script prepares each new workspace, for example by installing dependencies.'
    : 'A run script starts your app, for example a dev server on $LONCA_PORT.';
  return (
    <div className="panel-empty">
      {hasScript ? `Nothing has run here yet. Press play to start the ${kind} script.` : blurb}
      {!hasScript && <Link to={`/projects/${project.id}`} className="link-button">Add a {kind} script</Link>}
    </div>
  );
}

export function BottomPanel({ workspace, project, onCollapse, onOpen }: {
  workspace: Workspace;
  project: Project;
  onCollapse: () => void;
  onOpen: () => void;
}) {
  const terminals = useStore((store) => store.terminals);
  const mine = terminals.filter((terminal) => terminal.workspaceId === workspace.id);
  const shells = mine.filter((terminal) => terminal.kind === 'shell');
  const setup = mine.find((terminal) => terminal.kind === 'setup');
  const run = mine.find((terminal) => terminal.kind === 'run');
  const [selection, setSelection] = useState<Selection>('shell');
  const creating = useRef(false);
  const ready = workspace.status === 'ready';

  const selectedShell = shells.find((terminal) => terminal.id === selection) ?? shells[0];
  const showingShell = selection !== 'setup' && selection !== 'run';

  useEffect(() => {
    setSelection('shell');
  }, [workspace.id]);

  // Every workspace opens with a terminal ready to type in.
  useEffect(() => {
    if (!ready || shells.length > 0 || creating.current) return;
    creating.current = true;
    attempt(() => api.createTerminal(workspace.id)).finally(() => {
      creating.current = false;
    });
  }, [ready, shells.length, workspace.id]);

  const selected: TerminalInfo | undefined = selection === 'setup' ? setup : selection === 'run' ? run : selectedShell;
  const scriptKind = selection === 'setup' || selection === 'run' ? selection : null;
  // Repository setup scripts can change inside the workspace, independently of settings.
  const scripts = usePolled(ready && scriptKind ? () => api.scripts(workspace.id) : null, 5000,
    [workspace.id, ready, scriptKind, project.settings.setupScript, project.settings.runScript]);
  const hasScript = Boolean(scriptKind && (scripts.data?.[scriptKind]
    ?? (scriptKind === 'setup' ? project.settings.setupScript.trim() : project.settings.runScript.trim())));

  return (
    <section className="bottom-panel" aria-label="Terminals">
      <div className="bottom-tabs" role="tablist">
        <IconButton label="Hide terminals" onClick={onCollapse}><ChevronDown size={15} /></IconButton>
        <button type="button" role="tab" aria-selected={selection === 'setup'} className={`bottom-tab ${selection === 'setup' ? 'active' : ''}`} onClick={() => { setSelection('setup'); onOpen(); }}>
          Setup
          {setup?.status === 'running' && <span className="live-dot" />}
        </button>
        <button type="button" role="tab" aria-selected={selection === 'run'} className={`bottom-tab ${selection === 'run' ? 'active' : ''}`} onClick={() => { setSelection('run'); onOpen(); }}>
          Run
          {run?.status === 'running' && <span className="live-dot" />}
        </button>
        {shells.map((terminal) => (
          <div key={terminal.id} className={`bottom-tab terminal-tab ${showingShell && selectedShell?.id === terminal.id ? 'active' : ''}`}>
            <button type="button" role="tab" aria-selected={showingShell && selectedShell?.id === terminal.id} onClick={() => { setSelection(terminal.id); onOpen(); }}>
              {terminal.title}
            </button>
            {shells.length > 1 && (
              <button type="button" className="tab-close" aria-label={`Close ${terminal.title}`} onClick={() => void attempt(() => api.closeTerminal(terminal.id))}>
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        <IconButton
          label="New terminal"
          disabled={!ready}
          onClick={async () => {
            const created = await attempt(() => api.createTerminal(workspace.id));
            if (created) setSelection(created.id);
            onOpen();
          }}
        >
          <Plus size={15} />
        </IconButton>
        <span className="spacer" />
        {scriptKind && (hasScript || selected?.status === 'running') && ready && (
          selected?.status === 'running' ? (
            <IconButton label={`Stop the ${scriptKind} script`} onClick={() => void attempt(() => api.stopScript(workspace.id, scriptKind))}>
              <Square size={13} />
            </IconButton>
          ) : (
            <IconButton label={`Start the ${scriptKind} script`} onClick={() => void attempt(() => api.runScript(workspace.id, scriptKind))}>
              <Play size={14} />
            </IconButton>
          )
        )}
      </div>
      {selection === 'run' && ready && (
        <div className="script-strip">
          <a className="port-link" href={`http://localhost:${workspace.port}`} target="_blank" rel="noreferrer" title={`Ports ${workspace.port}–${workspace.port + 9} are published on localhost`}>
            localhost:{workspace.port} <ExternalLink size={12} />
          </a>
        </div>
      )}
      <div className="terminal-stack">
        {[...shells, ...(setup ? [setup] : []), ...(run ? [run] : [])].map((terminal) => (
          <TerminalView key={terminal.id} id={terminal.id} active={selected?.id === terminal.id} autoFocus={false} />
        ))}
        {scriptKind && !selected && <ScriptEmpty kind={scriptKind} project={project} hasScript={hasScript} />}
        {!scriptKind && !selected && <div className="panel-empty">{ready ? 'Opening a terminal…' : 'The terminal opens once the workspace is running.'}</div>}
        {(selected?.status === 'exited' || (selected?.disconnected && (!scriptKind || selected.jobsOnly))) && (
          <div className="terminal-exit">
            {selected.status === 'exited' || selected.jobsOnly
              ? <>{scriptKind ? `The ${scriptKind} script ` : 'This terminal '}exited{selected.exitCode ? ` with code ${selected.exitCode}` : ''}{selected.jobsOnly ? ', but something it started is still running.' : '.'}</>
              : 'This terminal is still running, but its connection was lost. Restart stops its old process.'}
            {!scriptKind && ready && (
              <button type="button" className="link-button" onClick={() => void attempt(() => api.restartTerminal(workspace.id, selected.id))}>
                <RotateCcw size={12} /> Restart
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
