import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Session } from '../../shared/types.ts';
import type { SavedWorkspace } from '../../server/legacy.ts';
import { FAKE_SANDBOX, Lonca, docker, makeFixtureRepo, removeSandbox, until, sleep } from '../support/harness.ts';

// The Docker harness supplies an image for the old runtime as well as the new sbx facade.
it.runIf(FAKE_SANDBOX)('stops an old container writing to the checkout before migrating its saved run', async () => {
  const lonca = new Lonca({ port: 48452, instance: 'legacy-migration-test', firstWorkspacePort: 58500 });
  const fixture = makeFixtureRepo();
  const legacy = `${lonca.prefix}-old-container`;
  let oldCreated = false;
  try {
    await lonca.start();
    const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: fixture })).id);
    const created = await lonca.api('POST', `/projects/${project.id}/workspaces`, {});
    const workspace = await lonca.waitForWorkspace(created.workspace.id);
    const image = docker('inspect', '--format', '{{.Config.Image}}', workspace.sandboxName);
    await lonca.kill();
    removeSandbox(workspace.sandboxName);
    docker('run', '-d', '--init', '--name', legacy, '--label', `dev.lonca.instance=${lonca.prefix}`, '--label', 'dev.lonca.fake-sbx=0', '--user', 'agent', '--entrypoint', 'sleep', '-v', `${workspace.path}:${workspace.path}`, image, 'infinity');
    oldCreated = true;
    const heartbeat = path.join(workspace.path, 'legacy-heartbeat');
    docker('exec', '-d', legacy, 'bash', '-c', 'while :; do echo tick >> "$1"; sleep 1; done', 'legacy-job', heartbeat);
    await until('the legacy writer', () => fs.existsSync(heartbeat));
    const statePath = path.join(lonca.home, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { workspaces: SavedWorkspace[]; sessions: Session[] };
    const savedWorkspace = state.workspaces.find((entry) => entry.id === workspace.id)!;
    Object.assign(savedWorkspace, { runtime: 'container', containerName: legacy });
    delete (savedWorkspace as Partial<SavedWorkspace>).sandboxName;
    const session = state.sessions.find((entry) => entry.id === created.session.id)!;
    delete session.role;
    Object.assign(session, { status: 'running', activeRunId: 'old-run-id', hasMessages: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
    await lonca.start();
    // HTTP startup must not race the old writer. A later cleanup would be too late.
    expect(docker('inspect', '--format', '{{.State.Running}}', legacy)).toBe('false');
    const length = fs.readFileSync(heartbeat, 'utf8').length;
    await until('the old run to retire', async () => !(await lonca.session(session.id)).activeRunId);
    await sleep(1100);
    expect(fs.readFileSync(heartbeat, 'utf8').length).toBe(length);
    expect((await lonca.session(session.id)).status).toBe('idle');
  } finally {
    if (oldCreated) docker('rm', '-f', legacy);
    await lonca.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
