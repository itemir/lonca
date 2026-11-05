import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { App } from './App.tsx';
import { TerminalWindow } from './components/TerminalWindow.tsx';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/terminals/:id" element={<TerminalWindow />} />
      <Route path="*" element={<App />} />
    </Routes>
  </BrowserRouter>,
);
