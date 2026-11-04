// Builds the web app if its sources changed, then starts the server.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, WEB_DIST } from '../server/config.ts';

function newestChange(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) newest = Math.max(newest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return newest;
}

const built = path.join(WEB_DIST, 'index.html');
const sources = Math.max(newestChange(path.join(REPO_ROOT, 'web')), newestChange(path.join(REPO_ROOT, 'shared')));
if (!fs.existsSync(built) || fs.statSync(built).mtimeMs < sources) {
  console.log('Building the web app…');
  const result = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await import('../server/index.ts');
