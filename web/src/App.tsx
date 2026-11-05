import { useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { AddProjectDialog } from './components/AddProjectDialog.tsx';
import { LoginDialog } from './components/LoginDialog.tsx';
import { SearchPalette } from './components/SearchPalette.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ErrorBoundary, Toasts } from './components/ui.tsx';
import { WorkspaceView } from './components/WorkspaceView.tsx';
import { useResizable } from './hooks.ts';
import { useLayout } from './layout.ts';
import { Create } from './pages/Create.tsx';
import { Home } from './pages/Home.tsx';
import { ProjectSettings } from './pages/ProjectSettings.tsx';
import { Settings } from './pages/Settings.tsx';
import { startConnection, useStore } from './store.ts';

let connectionStarted = false;

export function App() {
  const ready = useStore((store) => store.ready);
  const locked = useStore((store) => store.locked);
  const connected = useStore((store) => store.connected);
  const sandbox = useStore((store) => store.system.sandbox);
  const setSearchOpen = useStore((store) => store.setSearchOpen);
  const sidebarOpen = useLayout((layout) => layout.sidebarOpen);
  const sidebar = useResizable('sidebar', 272, 200, 460, 'x', false);
  const location = useLocation();
  const leadNeedsYou = useStore((store) => store.sessions.some((session) => session.role === 'lead' && !session.closedAt && session.unread));

  useEffect(() => {
    document.title = leadNeedsYou ? '● Lonca' : 'Lonca';
  }, [leadNeedsYou]);

  // An on-screen keyboard covers the page without resizing it, which would hide the composer.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !matchMedia('(pointer: coarse)').matches) return;
    const update = () => document.documentElement.style.setProperty('--viewport-height', `${viewport.height}px`);
    update();
    viewport.addEventListener('resize', update);
    return () => viewport.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!connectionStarted) {
      connectionStarted = true;
      startConnection();
    }
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen]);

  if (locked) return <div className="boot">Open Lonca with the link printed in the terminal where you started it.</div>;
  if (!ready) return <div className="boot">Connecting to Lonca…</div>;

  return (
    <div className="app" style={{ '--sidebar-width': `${sidebarOpen ? sidebar.size : 0}px` } as React.CSSProperties}>
      {sidebarOpen && (
        <>
          <Sidebar />
          <div className="resize-handle resize-x sidebar-handle" onPointerDown={sidebar.onPointerDown} />
        </>
      )}
      <main className="main">
        {!connected && <div className="banner">Lost the connection to the Lonca server. Reconnecting…</div>}
        {connected && sandbox.state === 'not-installed' && (
          <div className="banner banner-error">Workspaces can’t run without Docker Sandboxes. <Link to="/settings">Settings</Link> says how to install it.</div>
        )}
        {connected && sandbox.state === 'unsupported' && (
          <div className="banner banner-error">Workspaces can’t run on this computer: {sandbox.detail}</div>
        )}
        {connected && sandbox.state === 'signed-out' && (
          <div className="banner banner-error">Workspaces can’t run because Docker Sandboxes isn’t signed in. Run <code>sbx login</code> in a terminal, and Lonca will pick it up.</div>
        )}
        {connected && sandbox.state === 'unavailable' && (
          <div className="banner banner-error">Workspaces can’t run because Docker Sandboxes isn’t working: {sandbox.detail}</div>
        )}
        <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/create" element={<Create />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/projects/:id" element={<ProjectSettings />} />
            <Route path="/w/:id" element={<WorkspaceView />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <SearchPalette />
      <AddProjectDialog />
      <LoginDialog />
      <Toasts />
    </div>
  );
}
