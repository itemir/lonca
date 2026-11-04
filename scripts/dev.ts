// Runs the server with reloads on change, alongside Vite's dev server.
import { spawn } from 'node:child_process';

const env = { ...process.env, LONCA_DEV: '1', LONCA_NO_OPEN: '1' };
const children = [
  spawn('node', ['--watch-path=server', '--watch-path=shared', 'server/index.ts'], { stdio: 'inherit', env }),
  spawn('npx', ['vite'], { stdio: 'inherit', env }),
];

for (const child of children) {
  child.on('exit', (code) => {
    for (const other of children) other.kill();
    process.exit(code ?? 0);
  });
}
process.on('SIGINT', () => {
  for (const child of children) child.kill();
});
