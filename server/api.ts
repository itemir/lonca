import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import type { AgentId, AppState, Project, Session, Workspace } from '../shared/types.ts';
import { playbookFor, resetPlaybook, savePlaybook } from './agents/playbook.ts';
import { cancelQueued, createLead, createSession, deleteSession, flushQueue, interruptSession, publishSession, sendMessage } from './agents/runner.ts';
import { checkButtonCanStart, closeWorkspaceLead, holdWhenStopped, markRead, stopAgents, switchLead, tryAgain, warnOfOtherWriter } from './agents/team.ts';
import { projectCodexKey } from './boundary.ts';
import { execText } from './sandbox.ts';
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
  closeTerminal, closeTerminalWindow, createShell, listTerminals, restartShell, runSetupScript, stopSetupScript,
} from './terminals.ts';
import { sessionSnapshot } from './transcript.ts';
import { HttpError, errorMessage, newId } from './util.ts';
import {
  archiveWorkspace, configuredSetupScript, createWorkspace, deleteWorkspace, publishWorkspace, rebuildWorkspace, restoreWorkspace,
  applyCodexSetup, applyCodexSetupEverywhere, retryWorkspace, runningSandbox, startWorkspace, stopWorkspace,
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
  filesToCopy: z.array(z.string()),
  image: z.string(),
  network: z.enum(['internet', 'host']),
  memoryGb: z.number().min(0),
  cpus: z.number().min(0),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment variable names may only use letters, digits and underscores'), z.string()),
}).partial();

const leadChoiceSchema = z.object({ agent: z.enum(['claude', 'codex']), model: z.string().min(1), effort: z.string().min(1) });

const appSettingsSchema = z.object({
  branchPrefix: z.string().regex(/^[\w./-]*$/, 'Branch prefixes may only use letters, digits, dots, dashes and slashes'),
  gitName: z.string(),
  gitEmail: z.string(),
  defaultAgent: z.enum(['claude', 'codex']),
  defaultModel: z.string(),
  defaultEffort: z.string(),
  leadDefault: leadChoiceSchema,
  leadMaxAgents: z.number().int().min(1).max(8),
  notifications: z.boolean(),
}).partial();

// The whole file goes on the CLI's command line each turn, and that has limits.
const PLAYBOOK_LIMIT = 32 * 1024;
const playbookSchema = z.object({
  project: z.string().optional(),
  content: z.string().trim().min(1, 'A playbook can’t be empty. Reset it to go back to the template.').max(PLAYBOOK_LIMIT, 'That’s too long for a playbook. Keep it under 32 KB.')
    .refine((text) => !text.includes('\0'), 'A playbook can’t contain that character.'),
});

function playbookProject(id: unknown): Project | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  const project = getProject(id);
  if (!project) throw new HttpError(404, 'No such project');
  return project;
}

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
    const keyBefore = projectCodexKey(project);
    if (body.name) project.name = body.name;
    if (body.settings) project.settings = { ...project.settings, ...body.settings };
    publishProject(project);
    if (projectCodexKey(project) !== keyBefore) void applyCodexSetup(project);
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
      createLead(workspace, { agent: body.agent, model: body.model, effort: body.effort }),
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
    await rebuildWorkspace(workspaceParam(req));
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
    const sandbox = await runningSandbox(workspace);
    await execText(sandbox, ['bash', '-c', 'mkdir -p "$(dirname "$0")" && cat > "$0"', relative], {
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

  api.post('/workspaces/:id/lead', (req, res) => {
    res.status(201).json(createLead(workspaceParam(req)));
  });

  api.post('/workspaces/:id/lead/switch', express.json(), async (req, res) => {
    res.status(201).json(await switchLead(workspaceParam(req), parse(leadChoiceSchema, req.body)));
  });

  api.post('/workspaces/:id/agents/stop', async (req, res) => {
    await stopAgents(workspaceParam(req).id);
    res.status(204).end();
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

  api.delete('/terminals/:id/window', (req, res) => {
    closeTerminalWindow(String(req.params.id));
    res.status(204).end();
  });

  api.get('/workspaces/:id/scripts', async (req, res) => {
    const setup = await configuredSetupScript(workspaceParam(req));
    res.json({ setup: Boolean(setup.trim()) });
  });

  api.post('/workspaces/:id/scripts/setup', async (req, res) => {
    const workspace = workspaceParam(req);
    const script = await configuredSetupScript(workspace);
    if (!script.trim()) throw new HttpError(400, 'This project has no setup script yet');
    res.status(201).json(await runSetupScript(workspace, script));
  });

  api.delete('/workspaces/:id/scripts/setup', async (req, res) => {
    await stopSetupScript(workspaceParam(req));
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
    const changesModel = Boolean(body.model || body.effort || body.agent);
    const workspace = getWorkspace(session.workspaceId);
    if (session.closedAt) throw new HttpError(409, 'This Lead was closed. Its conversation can still be read.');
    if (session.role === 'lead' && body.title) throw new HttpError(409, 'The Lead’s tab keeps its name.');
    if (session.role === 'lead' && changesModel && workspace?.leadLockedAt) throw new HttpError(409, 'The Lead stays on this model for this workspace. For another model, start a new workspace.');
    if (session.role === 'agent' && changesModel) throw new HttpError(409, 'The Lead chose this agent’s model.');
    if (body.agent && body.agent !== session.agent) {
      // Each CLI keeps its own history, so a conversation can't change agents midway.
      if (session.hasMessages) throw new HttpError(409, 'This conversation has started. Open a new tab to use a different agent.');
      session.agent = body.agent;
      session.resumeId = null;
    }
    if (body.title) session.title = body.title;
    if (body.model) session.model = body.model;
    if (body.effort) session.effort = body.effort;
    if (session.role === 'lead' && changesModel && workspace) {
      // A pick for one workspace leaves the default alone.
      workspace.lead = { agent: session.agent, model: session.model, effort: session.effort };
      publishWorkspace(workspace);
    } else if (changesModel) {
      state.settings.defaultAgent = session.agent;
      state.settings.defaultModel = session.model;
      state.settings.defaultEffort = session.effort;
      publishSettings();
    }
    publishSession(session);
    res.json(session);
  });

  api.delete('/sessions/:id', async (req, res) => {
    const session = sessionParam(req);
    // Closing keeps a Lead's conversation, so a plain delete would be the wrong way to end one.
    if (session.role === 'lead' && !session.closedAt && session.hasMessages) throw new HttpError(409, 'Close a Lead instead of deleting it.');
    await deleteSession(session.id);
    res.status(204).end();
  });

  api.post('/sessions/:id/close', express.json(), async (req, res) => {
    const session = sessionParam(req);
    if (session.role !== 'lead') throw new HttpError(409, 'Only a Lead is closed this way.');
    await closeWorkspaceLead(session, parse(z.object({ stopAgents: z.boolean().default(false) }), req.body ?? {}).stopAgents);
    res.status(204).end();
  });

  api.post('/sessions/:id/read', (req, res) => {
    markRead(sessionParam(req));
    res.status(204).end();
  });

  api.post('/sessions/:id/retry', async (req, res) => {
    await tryAgain(sessionParam(req));
    res.status(204).end();
  });

  api.post('/sessions/:id/messages', express.json({ limit: '5mb' }), async (req, res) => {
    const body = parse(z.object({ text: z.string().min(1), attachments: z.array(attachmentSchema).default([]) }), req.body);
    const item = await sendMessage(String(req.params.id), body.text, body.attachments);
    warnOfOtherWriter(sessionParam(req));
    res.status(201).json(item);
  });

  api.delete('/sessions/:id/queue/:itemId', (req, res) => {
    cancelQueued(String(req.params.id), String(req.params.itemId));
    res.status(204).end();
  });

  api.post('/sessions/:id/queue/flush', async (req, res) => {
    checkButtonCanStart(sessionParam(req));
    await flushQueue(String(req.params.id));
    res.status(204).end();
  });

  api.post('/sessions/:id/interrupt', async (req, res) => {
    const session = getSession(String(req.params.id));
    // Neither a wake nor the Lead can restart what the user has stopped.
    if (session) holdWhenStopped(session);
    await interruptSession(String(req.params.id));
    res.status(204).end();
  });

  // Settings

  api.patch('/settings', express.json(), (req, res) => {
    state.settings = { ...state.settings, ...parse(appSettingsSchema, req.body) };
    publishSettings();
    res.json(state.settings);
  });

  api.get('/playbook', (req, res) => {
    res.json(playbookFor(playbookProject(req.query.project)));
  });

  api.put('/playbook', express.json({ limit: '256kb' }), (req, res) => {
    const { project, content } = parse(playbookSchema, req.body);
    const owner = playbookProject(project);
    savePlaybook(owner, content.endsWith('\n') ? content : `${content}\n`);
    res.json(playbookFor(owner));
  });

  api.delete('/playbook', (req, res) => {
    const owner = playbookProject(req.query.project);
    resetPlaybook(owner);
    res.json(playbookFor(owner));
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

  api.post('/agents/:agent/login', express.json(), async (req, res) => {
    const { method } = parse(z.object({ method: z.enum(['browser', 'device']).optional() }), req.body ?? {});
    res.status(201).json(await logins.start(agentParam(req), method));
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
    saveCodexApiKey(key);
    applyCodexSetupEverywhere();
    clearAgentRejected('codex');
    await refreshAgents();
    res.json({ verified: check === 'accepted' });
  });

  api.post('/agents/:agent/logout', async (req, res) => {
    const agent = agentParam(req);
    // Finishing one that's under way would sign back in.
    await logins.cancel(agent);
    if (agent === 'codex') {
      signOutCodex();
      applyCodexSetupEverywhere();
    } else {
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
