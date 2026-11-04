import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import type { AgentId, AppState, Project, Session, Workspace } from '../shared/types.ts';
import { cancelQueued, createSession, deleteSession, flushQueue, interruptSession, publishSession, sendMessage } from './agents/runner.ts';
import { execText } from './docker.ts';
import {
  getChanges, getChecks, getFileDiff, listDirectory, readWorkspaceFile, safeAttachmentName, searchFiles,
} from './inspect.ts';
import { publish } from './events.ts';
import {
  addProjectFromPath, addProjectFromUrl, listBranches, projectLifecycle, publishProject, removeProject,
} from './projects.ts';
import { logins } from './logins.ts';
import { flushState, getProject, getSession, getWorkspace, isClaudeCredential, saveState, secretsStatus, state, updateSecrets } from './store.ts';
import {
  checkClaudeCredential, checkCodexKey, checkSandboxes, clearAgentRejected, rebuildImage, refreshAgents, saveCodexApiKey, signOutCodex, system,
} from './system.ts';
import {
  closeTerminal, createShell, listTerminals, restartShell, runScript, stopScript,
} from './terminals.ts';
import { sessionSnapshot } from './transcript.ts';
import { HttpError, errorMessage, newId } from './util.ts';
import {
  archiveWorkspace, configuredSetupScript, createWorkspace, deleteWorkspace, publishWorkspace, recreateContainer, restoreWorkspace,
  retryWorkspace, runningContainer, startWorkspace, stopWorkspace,
} from './workspaces.ts';

const execFileAsync = promisify(execFile);

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

function projectParam(req: Request): Project {
  const project = getProject(String(req.params.id));
  if (!project) throw new HttpError(404, 'No such project');
  return project;
}

function workspaceParam(req: Request): Workspace {
  const workspace = getWorkspace(String(req.params.id));
  if (!workspace) throw new HttpError(404, 'No such workspace');
  return workspace;
}

function sessionParam(req: Request): Session {
  const session = getSession(String(req.params.id));
  if (!session) throw new HttpError(404, 'No such session');
  return session;
}

function agentParam(req: Request): AgentId {
  return parse(z.enum(['claude', 'codex']), req.params.agent);
}

const attachmentSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
  mime: z.string(),
});

/** Tokens copied out of a terminal can pick up line breaks where it wrapped them. */
const stripSpace = (secret: string) => secret.replace(/\s+/g, '');

const projectSettingsSchema = z.object({
  defaultBranch: z.string().min(1),
  setupScript: z.string(),
  runScript: z.string(),
  filesToCopy: z.array(z.string()),
  image: z.string(),
  network: z.enum(['internet', 'host']),
  memoryGb: z.number().min(0),
  cpus: z.number().min(0),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment variable names may only use letters, digits and underscores'), z.string()),
}).partial();

const appSettingsSchema = z.object({
  branchPrefix: z.string().regex(/^[\w./-]*$/, 'Branch prefixes may only use letters, digits, dots, dashes and slashes'),
  gitName: z.string(),
  gitEmail: z.string(),
  defaultAgent: z.enum(['claude', 'codex']),
  defaultModel: z.string(),
  defaultEffort: z.string(),
}).partial();

export function snapshot(me: AppState['me']): AppState {
  return {
    me,
    projects: state.projects,
    workspaces: state.workspaces,
    sessions: state.sessions,
    terminals: listTerminals(),
    logins: logins.states(),
    system,
    catalog: state.catalog,
    settings: state.settings,
    secrets: secretsStatus(),
  };
}

function publishSettings(): void {
  publish({ type: 'settings', settings: state.settings, secrets: secretsStatus() });
  saveState();
}

export function createApi(me: AppState['me']): Router {
  const api = Router();

  // What someone just asked for shouldn't be lost if the server stops a moment later.
  api.use((req, res, next) => {
    if (req.method !== 'GET') res.on('finish', flushState);
    next();
  });

  api.get('/state', (_req, res) => {
    res.json(snapshot(me));
  });

  // Projects

  api.post('/projects', express.json(), async (req, res) => {
    const body = parse(z.object({ url: z.string().optional(), path: z.string().optional() }), req.body);
    if (body.url) res.status(201).json(await addProjectFromUrl(body.url));
    else if (body.path) res.status(201).json(await addProjectFromPath(body.path));
    else throw new HttpError(400, 'Enter a repository URL or a local path');
  });

  api.patch('/projects/:id', express.json(), (req, res) => {
    const project = projectParam(req);
    const body = parse(z.object({ name: z.string().min(1).optional(), settings: projectSettingsSchema.optional() }), req.body);
    if (body.name) project.name = body.name;
    if (body.settings) project.settings = { ...project.settings, ...body.settings };
    publishProject(project);
    res.json(project);
  });

  api.delete('/projects/:id', async (req, res) => {
    await projectLifecycle.run(String(req.params.id), async () => {
      const project = projectParam(req);
      const workspaces = state.workspaces.filter((workspace) => workspace.projectId === project.id);
      // Keep the project locked until every teardown settles, even if one fails.
      const results = await Promise.allSettled(workspaces.map((workspace) => deleteWorkspace(workspace)));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      await removeProject(project);
    });
    res.status(204).end();
  });

  api.get('/projects/:id/branches', (req, res) => {
    res.json(listBranches(projectParam(req)));
  });

  api.post('/projects/:id/workspaces', express.json(), async (req, res) => {
    const project = projectParam(req);
    const body = parse(z.object({
      baseBranch: z.string().optional(),
      agent: z.enum(['claude', 'codex']).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      prompt: z.string().optional(),
    }), req.body ?? {});
    const created = await createWorkspace(project, { baseBranch: body.baseBranch }, (workspace) =>
      createSession(workspace, { agent: body.agent, model: body.model, effort: body.effort }),
    );
    if (body.prompt?.trim()) await sendMessage(created.session.id, body.prompt, []);
    res.status(201).json({ workspace: created.workspace, session: getSession(created.session.id) });
  });

  // Workspaces

  api.patch('/workspaces/:id', express.json(), (req, res) => {
    const workspace = workspaceParam(req);
    const body = parse(z.object({ title: z.string().min(1) }), req.body);
    workspace.title = body.title;
    publishWorkspace(workspace);
    res.json(workspace);
  });

  api.delete('/workspaces/:id', async (req, res) => {
    await deleteWorkspace(workspaceParam(req));
    res.status(204).end();
  });

  api.post('/workspaces/:id/retry', (req, res) => {
    retryWorkspace(workspaceParam(req));
    res.status(202).end();
  });

  api.post('/workspaces/:id/restore', (req, res) => {
    restoreWorkspace(workspaceParam(req));
    res.status(202).end();
  });

  api.post('/workspaces/:id/start', async (req, res) => {
    await startWorkspace(workspaceParam(req));
    res.status(204).end();
  });

  api.post('/workspaces/:id/stop', async (req, res) => {
    await stopWorkspace(workspaceParam(req));
    res.status(204).end();
  });

  api.post('/workspaces/:id/archive', async (req, res) => {
    await archiveWorkspace(workspaceParam(req));
    res.status(204).end();
  });

  api.post('/workspaces/:id/recreate', async (req, res) => {
    await recreateContainer(workspaceParam(req));
    res.status(204).end();
  });

  api.get('/workspaces/:id/files', async (req, res) => {
    res.json(await listDirectory(workspaceParam(req), String(req.query.path ?? '.')));
  });

  api.get('/workspaces/:id/file', async (req, res) => {
    res.json(await readWorkspaceFile(workspaceParam(req), String(req.query.path ?? '')));
  });

  api.get('/workspaces/:id/search', async (req, res) => {
    const mode = req.query.mode === 'content' ? 'content' : 'names';
    res.json(await searchFiles(workspaceParam(req), String(req.query.q ?? ''), mode));
  });

  api.get('/workspaces/:id/changes', async (req, res) => {
    res.json(await getChanges(workspaceParam(req)));
  });

  api.get('/workspaces/:id/diff', async (req, res) => {
    const diff = await getFileDiff(workspaceParam(req), String(req.query.path ?? ''), req.query.untracked === '1', String(req.query.oldPath ?? ''));
    res.type('text/plain').send(diff);
  });

  api.get('/workspaces/:id/checks', async (req, res) => {
    res.json(await getChecks(workspaceParam(req)));
  });

  api.post('/workspaces/:id/attachments', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
    const workspace = workspaceParam(req);
    const name = safeAttachmentName(String(req.query.name ?? 'attachment'));
    const body = req.body as Buffer;
    const relative = `.context/attachments/${newId()}/${name}`;
    const containerId = await runningContainer(workspace);
    await execText(containerId, ['bash', '-c', 'mkdir -p "$(dirname "$0")" && cat > "$0"', relative], {
      workdir: workspace.path,
      stdin: body,
    });
    res.status(201).json({
      name,
      path: relative,
      size: body.length,
      mime: req.headers['content-type'] || 'application/octet-stream',
    });
  });

  api.post('/workspaces/:id/sessions', express.json(), (req, res) => {
    const workspace = workspaceParam(req);
    const body = parse(z.object({
      agent: z.enum(['claude', 'codex']).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
    }), req.body ?? {});
    res.status(201).json(createSession(workspace, body));
  });

  // Scripts and terminals

  api.post('/workspaces/:id/terminals', async (req, res) => {
    res.status(201).json(await createShell(workspaceParam(req)));
  });

  api.post('/workspaces/:id/terminals/:terminalId/restart', async (req, res) => {
    await restartShell(workspaceParam(req), String(req.params.terminalId));
    res.status(204).end();
  });

  api.delete('/terminals/:id', async (req, res) => {
    await closeTerminal(String(req.params.id));
    res.status(204).end();
  });

  api.get('/workspaces/:id/scripts', async (req, res) => {
    const workspace = workspaceParam(req);
    const setup = await configuredSetupScript(workspace);
    res.json({ setup: Boolean(setup.trim()), run: Boolean(getProject(workspace.projectId)?.settings.runScript.trim()) });
  });

  api.post('/workspaces/:id/scripts/:kind', express.json(), async (req, res) => {
    const workspace = workspaceParam(req);
    const kind = parse(z.enum(['setup', 'run']), req.params.kind);
    const project = getProject(workspace.projectId);
    const script = kind === 'setup' ? await configuredSetupScript(workspace) : project?.settings.runScript;
    if (!script?.trim()) throw new HttpError(400, `This project has no ${kind} script yet`);
    res.status(201).json(await runScript(workspace, kind, script));
  });

  api.delete('/workspaces/:id/scripts/:kind', async (req, res) => {
    await stopScript(workspaceParam(req), parse(z.enum(['setup', 'run']), req.params.kind));
    res.status(204).end();
  });

  // Sessions

  api.get('/sessions/:id', (req, res) => {
    res.json(sessionSnapshot(String(req.params.id)));
  });

  api.patch('/sessions/:id', express.json(), (req, res) => {
    const session = sessionParam(req);
    const body = parse(z.object({
      title: z.string().min(1).optional(),
      agent: z.enum(['claude', 'codex']).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
    }), req.body);
    if (body.agent && body.agent !== session.agent) {
      // Each CLI keeps its own history, so a conversation can't change agents midway.
      if (session.hasMessages) throw new HttpError(409, 'This conversation has started. Open a new tab to use a different agent.');
      session.agent = body.agent;
      session.resumeId = null;
    }
    if (body.title) session.title = body.title;
    if (body.model) session.model = body.model;
    if (body.effort) session.effort = body.effort;
    if (body.model || body.effort || body.agent) {
      state.settings.defaultAgent = session.agent;
      state.settings.defaultModel = session.model;
      state.settings.defaultEffort = session.effort;
      publishSettings();
    }
    publishSession(session);
    res.json(session);
  });

  api.delete('/sessions/:id', async (req, res) => {
    await deleteSession(String(req.params.id));
    res.status(204).end();
  });

  api.post('/sessions/:id/messages', express.json({ limit: '5mb' }), async (req, res) => {
    const body = parse(z.object({ text: z.string().min(1), attachments: z.array(attachmentSchema).default([]) }), req.body);
    res.status(201).json(await sendMessage(String(req.params.id), body.text, body.attachments));
  });

  api.delete('/sessions/:id/queue/:itemId', (req, res) => {
    cancelQueued(String(req.params.id), String(req.params.itemId));
    res.status(204).end();
  });

  api.post('/sessions/:id/queue/flush', async (req, res) => {
    await flushQueue(String(req.params.id));
    res.status(204).end();
  });

  api.post('/sessions/:id/interrupt', async (req, res) => {
    await interruptSession(String(req.params.id));
    res.status(204).end();
  });

  // Settings

  api.patch('/settings', express.json(), (req, res) => {
    state.settings = { ...state.settings, ...parse(appSettingsSchema, req.body) };
    publishSettings();
    res.json(state.settings);
  });

  api.put('/secrets/claude', express.json(), async (req, res) => {
    const { token } = parse(z.object({ token: z.string() }), req.body);
    const credential = stripSpace(token);
    if (!isClaudeCredential(credential)) throw new HttpError(400, 'That isn’t a key. Keys and tokens start with sk-ant-.');
    const check = await checkClaudeCredential(credential);
    if (check === 'refused') throw new HttpError(400, 'Claude didn’t accept this key.');
    await logins.cancel('claude');
    updateSecrets({ claudeToken: credential });
    clearAgentRejected('claude');
    publishSettings();
    await refreshAgents();
    res.json({ verified: check === 'accepted' });
  });

  api.put('/secrets/github', express.json(), (req, res) => {
    const { token } = parse(z.object({ token: z.string() }), req.body);
    updateSecrets({ githubToken: stripSpace(token) });
    publishSettings();
    res.status(204).end();
  });

  // Only runs when the user asks to connect the `gh` login from this machine.
  api.post('/secrets/github/import', async (_req, res) => {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 15000 });
      updateSecrets({ githubToken: stdout.trim() });
    } catch (error) {
      throw new HttpError(400, `Could not read a token from the gh CLI: ${errorMessage(error)}`);
    }
    publishSettings();
    res.status(204).end();
  });

  api.post('/agents/:agent/login', async (req, res) => {
    res.status(201).json(await logins.start(agentParam(req)));
  });

  api.delete('/agents/:agent/login', async (req, res) => {
    await logins.cancel(agentParam(req));
    res.status(204).end();
  });

  api.post('/agents/:agent/login/code', express.json(), async (req, res) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    await logins.submitCode(agentParam(req), code);
    res.status(204).end();
  });

  api.get('/agents/:agent/login/output', (req, res) => {
    res.type('text/plain').send(logins.output(agentParam(req)));
  });

  api.put('/agents/codex/api-key', express.json(), async (req, res) => {
    const key = stripSpace(parse(z.object({ key: z.string() }), req.body).key);
    if (!/^sk-[\w-]{20,}$/.test(key)) throw new HttpError(400, 'That isn’t an API key. Keys start with sk-.');
    const check = await checkCodexKey(key);
    if (check === 'refused') throw new HttpError(400, 'OpenAI didn’t accept this key.');
    await logins.cancel('codex');
    await saveCodexApiKey(key);
    clearAgentRejected('codex');
    await refreshAgents();
    res.json({ verified: check === 'accepted' });
  });

  api.post('/agents/:agent/logout', async (req, res) => {
    const agent = agentParam(req);
    if (agent === 'codex') await signOutCodex();
    else {
      updateSecrets({ claudeToken: '' });
      publishSettings();
    }
    clearAgentRejected(agent);
    await refreshAgents();
    res.status(204).end();
  });

  api.post('/agents/refresh', async (_req, res) => {
    await refreshAgents();
    res.status(204).end();
  });

  api.post('/sandboxes/check', async (_req, res) => {
    await checkSandboxes();
    res.json(system.sandbox);
  });

  api.post('/image/rebuild', (_req, res) => {
    rebuildImage().catch((error) => console.error('image rebuild failed:', errorMessage(error)));
    res.status(202).end();
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'No such API route')));

  api.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status ?? 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: errorMessage(error) });
  });

  return api;
}
