import { execFileSync } from 'node:child_process';
import type { Workspace } from '../shared/types.ts';

export type SavedWorkspace = Workspace & { containerName?: string; runtime?: string };

/** The old server left agents running on exit. Nothing may use their checkout until they stop. */
export function stopLegacyContainers(workspaces: SavedWorkspace[]): void {
  const names = new Set(workspaces
    .filter((workspace) => workspace.containerName && !workspace.sandboxName && workspace.runtime !== 'sandbox' && workspace.status !== 'archived')
    .map((workspace) => workspace.containerName!));
  if (names.size === 0) return;

  const docker = (args: string[]) => execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
  const active = () => docker(['container', 'ls', '--all', '--format', '{{json .}}'])
    .split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { ID: string; Names: string; State: string })
    .filter((container) => names.has(container.Names) && !['created', 'exited', 'dead'].includes(container.State));
  try {
    const running = active();
    if (running.length) {
      docker(['container', 'stop', '--timeout', '10', ...running.map((container) => container.ID)]);
      if (active().length) throw new Error('A legacy container is still running.');
    }
  } catch {
    // load() hasn't returned yet, so the original runtime identities and run IDs remain on disk.
    throw new Error('Lonca could not confirm that its old Docker-container workspaces have stopped. Start Docker and run Lonca again. Saved workspaces have not been migrated.');
  }
}
