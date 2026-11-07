import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canRun } from '../../shared/lead.ts';
import { UNKNOWN_LIMIT_MS, autoSwitchTarget, continueOptions, isLimited, leadDefaultFor, leadMayUse, profileIdOf } from '../../shared/profiles.ts';
import type { ChatItem, NoticeItem, Profile, Project, Session, SystemStatus, UserItem, Workspace } from '../../shared/types.ts';
import type { ToolCall } from '../../server/agents/process.ts';

// Several sign-ins per provider: what reaches the proxy and a VM for each, which one a turn runs
// on, and when a conversation moves to another.

let home: string;
let store: typeof import('../../server/store.ts');
let boundary: typeof import('../../server/boundary.ts');
let system: typeof import('../../server/system.ts');
let profiles: typeof import('../../server/profiles.ts');
let runner: typeof import('../../server/agents/runner.ts');
let team: typeof import('../../server/agents/team.ts');

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const boundaryFile = (name: string) => path.join(home, 'boundary', name);
const project = (env: Record<string, string> = {}) => ({ id: 'project', settings: { env } }) as unknown as Project;
const notices = (id: string) => store.loadTranscript(id).filter((item): item is NoticeItem => item.type === 'notice').map((item) => item.text);

beforeEach(async () => {
  vi.resetModules();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-profiles-')));
  vi.stubEnv('LONCA_HOME', home);
  store = await import('../../server/store.ts');
  boundary = await import('../../server/boundary.ts');
  system = await import('../../server/system.ts');
  profiles = await import('../../server/profiles.ts');
  runner = await import('../../server/agents/runner.ts');
  team = await import('../../server/agents/team.ts');
});

afterEach(() => {
  store.flushTranscripts();
  store.flushState();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('what each sign-in gets', () => {
  it('starts with one per provider, which keeps what there was before there could be several', () => {
    expect(store.state.profiles).toEqual([
      { id: 'claude', agent: 'claude', name: '', createdAt: 0 },
      { id: 'codex', agent: 'codex', name: '', createdAt: 0 },
    ]);
    expect(boundary.placeholderFor({ id: 'claude', agent: 'claude' })).toBe('sk-ant-oat01-lonca-placeholder');
    expect(boundary.placeholderFor({ id: 'codex', agent: 'codex' })).toBe('oai-oat01-lonca-placeholder');
    expect(boundary.proxySecrets()).toEqual([
      { service: 'github', file: boundaryFile('github') },
      { hosts: ['api.anthropic.com'], placeholder: 'sk-ant-oat01-lonca-placeholder', file: boundaryFile('claude') },
      { hosts: ['chatgpt.com', 'api.openai.com'], placeholder: 'oai-oat01-lonca-placeholder', file: boundaryFile('codex') },
    ]);
  });

  it('gives a new one a placeholder and file of its own, none of which contains another', () => {
    const work = profiles.createProfile('claude', 'personal', 'work');
    const second = profiles.createProfile('claude', 'spare');
    const codex = profiles.createProfile('codex', 'personal', 'work');
    expect(work.id).toMatch(/^claude-[a-f0-9]{12}$/);
    expect(store.state.profiles.find((profile) => profile.id === 'claude')?.name).toBe('work');
    const secrets = boundary.proxySecrets().filter((secret) => 'placeholder' in secret) as { placeholder: string; file: string; hosts: string[] }[];
    expect(secrets.map((secret) => secret.file)).toEqual(['claude', 'codex', work.id, second.id, codex.id].map(boundaryFile));
    const placeholders = secrets.map((secret) => secret.placeholder);
    expect(new Set(placeholders).size).toBe(placeholders.length);
    for (const one of placeholders) for (const other of placeholders) if (one !== other) expect(one.includes(other)).toBe(false);
    expect(secrets.find((secret) => secret.file === boundaryFile(codex.id))?.hosts).toEqual(['chatgpt.com', 'api.openai.com']);
  });

  it('wants two named apart, and names the first one when the second is added', () => {
    expect(() => profiles.createProfile('claude', 'personal')).toThrow(/Name the Claude sign-in you already have/);
    expect(() => profiles.createProfile('claude', 'same', 'same')).toThrow(/different names/);
    profiles.createProfile('claude', 'personal', 'work');
    expect(() => profiles.createProfile('claude', 'Work')).toThrow(/already a Claude sign-in called Work/);
    expect(() => profiles.createProfile('claude', '   ')).toThrow(/Give the new sign-in a name/);
  });

  it('keeps a Claude credential where it always was for the first, and apart for the others', () => {
    const personal = profiles.createProfile('claude', 'personal', 'work');
    store.setClaudeCredential('claude', 'sk-ant-oat01-first-one');
    store.setClaudeCredential(personal.id, 'sk-ant-api03-second-one');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'));
    expect(saved).toEqual({ claudeToken: 'sk-ant-oat01-first-one', claudeTokens: { [personal.id]: 'sk-ant-api03-second-one' } });
    expect(fs.readFileSync(boundaryFile('claude'), 'utf8')).toBe('sk-ant-oat01-first-one');
    expect(fs.readFileSync(boundaryFile(personal.id), 'utf8')).toBe('sk-ant-api03-second-one');
    expect(fs.statSync(boundaryFile(personal.id)).mode & 0o777).toBe(0o600);
    store.setClaudeCredential(personal.id, undefined);
    expect(fs.existsSync(boundaryFile(personal.id))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'))).toEqual({ claudeToken: 'sk-ant-oat01-first-one' });
    // An id names a file, so nothing else is taken for one.
    expect(() => store.setClaudeCredential('../escape', 'x')).toThrow();
    expect(() => store.setBoundaryValue('../../escape', 'x')).toThrow();
    expect(() => store.setClaudeCredential('codex', 'x')).toThrow();
  });

  it('keeps each Codex login in a directory of its own, out of what any VM mounts', () => {
    const personal = profiles.createProfile('codex', 'personal', 'work');
    const token = jwt({ exp: 1800000000 });
    expect(system.adoptCodexLogin(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token } }), personal.id)).toBe(true);
    system.saveCodexApiKey('sk-the-first-ones-key', 'codex');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'helper-credentials', personal.id, 'auth.json'), 'utf8')).tokens.access_token).toBe(token);
    expect(fs.readFileSync(boundaryFile(personal.id), 'utf8')).toBe(token);
    expect(fs.readFileSync(boundaryFile('codex'), 'utf8')).toBe('sk-the-first-ones-key');
    system.describeProfiles();
    expect(system.system.profiles[personal.id]).toMatchObject({ signedIn: true, usesKey: false });
    expect(system.system.profiles.codex).toMatchObject({ signedIn: true, usesKey: true });
    system.signOutCodex(personal.id);
    expect(fs.existsSync(boundaryFile(personal.id))).toBe(false);
    expect(fs.readFileSync(boundaryFile('codex'), 'utf8')).toBe('sk-the-first-ones-key');
    expect(() => system.saveCodexApiKey('sk-x', 'claude')).toThrow();
  });

  it('forgets everything a removed sign-in held, and moves what was on it', async () => {
    const personal = profiles.createProfile('claude', 'personal', 'work');
    store.setClaudeCredential(personal.id, 'sk-ant-api03-going');
    const workspace = { id: 'w', projectId: 'project', name: 'prague', sandboxName: 'vm', status: 'creating', steps: [] } as unknown as Workspace;
    store.state.workspaces.push(workspace);
    const session = runner.createSession(workspace, { agent: 'claude', profileId: personal.id });
    store.state.settings.leadDefault = { ...store.state.settings.leadDefault, profileId: personal.id };
    // Not while something runs on it, which would lose its credentials partway.
    session.status = 'running';
    session.activeProfileId = personal.id;
    await expect(profiles.removeProfile(personal)).rejects.toThrow(/A conversation is running on Claude – personal/);
    session.status = 'idle';
    session.activeProfileId = undefined;
    session.hasMessages = true;
    await profiles.removeProfile(personal);
    expect(store.state.profiles.map((profile) => profile.id)).toEqual(['claude', 'codex']);
    expect(session.profileId).toBe('claude');
    expect(store.state.settings.leadDefault.profileId).toBe('claude');
    expect(store.claudeCredential(personal.id)).toBeUndefined();
    expect(fs.existsSync(boundaryFile(personal.id))).toBe(false);
    expect(notices(session.id)).toEqual(['Moved from Claude – personal to Claude – work because Claude – personal was removed.']);
    // The last one goes by signing out.
    await expect(profiles.removeProfile(store.state.profiles[0])).rejects.toThrow(/keeps at least one sign-in/);
  });

  it('keeps one when two are removed at once', async () => {
    const personal = profiles.createProfile('claude', 'personal', 'work');
    const results = await Promise.allSettled([profiles.removeProfile(store.state.profiles[0]), profiles.removeProfile(personal)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.state.profiles.filter((profile) => profile.agent === 'claude').map((profile) => profile.id)).toEqual([personal.id]);
  });

  it('won’t remove the first while a turn from before there could be several runs on it', async () => {
    const personal = profiles.createProfile('claude', 'personal', 'work');
    const workspace = { id: 'w', projectId: 'project', name: 'prague', sandboxName: 'vm', status: 'creating', steps: [] } as unknown as Workspace;
    store.state.workspaces.push(workspace);
    const session = runner.createSession(workspace, { agent: 'claude' });
    // Saved as running with no note of which, then moved, which only counts from its next turn.
    Object.assign(session, { status: 'running', profileId: personal.id, activeProfileId: undefined });
    await expect(profiles.removeProfile(store.state.profiles[0])).rejects.toThrow(/A conversation is running on Claude – work/);
  });

  it('drops what the proxy reads for a Claude sign-in once its token has gone, even after a sign-out cut short', async () => {
    const personal = profiles.createProfile('claude', 'personal', 'work');
    store.setClaudeCredential(personal.id, 'sk-ant-api03-signed-out');
    expect(fs.existsSync(boundaryFile(personal.id))).toBe(true);
    // As if signing out had saved the secrets and stopped before the proxy's file went.
    fs.writeFileSync(path.join(home, 'secrets.json'), '{}');
    store.flushState();
    vi.resetModules();
    store = await import('../../server/store.ts');
    expect(fs.existsSync(boundaryFile(personal.id))).toBe(false);
  });
});

describe('the environment of a turn', () => {
  let workspace: Workspace;
  let personal: Profile;
  beforeEach(() => {
    workspace = { id: 'w', projectId: 'project', name: 'prague', sandboxName: 'vm', status: 'creating', steps: [] } as unknown as Workspace;
    store.state.workspaces.push(workspace);
    personal = profiles.createProfile('claude', 'personal', 'work');
  });

  it('gives Claude the placeholder of the sign-in it runs on, in the variable for its kind', () => {
    store.setClaudeCredential('claude', 'sk-ant-oat01-subscription');
    store.setClaudeCredential(personal.id, 'sk-ant-api03-a-key');
    const first = runner.createSession(workspace, { agent: 'claude' });
    const second = runner.createSession(workspace, { agent: 'claude', profileId: personal.id });
    expect(first.profileId).toBe('claude');
    const env = (session: Session) => runner.turnEnv(session, project(), profileIdOf(session)).filter((entry) => /ANTHROPIC|CLAUDE_CODE_OAUTH/.test(entry));
    expect(env(first)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-lonca-placeholder']);
    expect(env(second)).toEqual([`ANTHROPIC_API_KEY=${boundary.placeholderFor(personal)}`]);
    // A signed-out one runs on nothing rather than on another sign-in.
    store.setClaudeCredential(personal.id, undefined);
    expect(env(second)).toEqual([]);
    // A project's own key comes after, so it's the one used.
    expect(runner.turnEnv(first, project({ ANTHROPIC_API_KEY: 'sk-own' }), 'claude').at(-1)).toBe('ANTHROPIC_API_KEY=sk-own');
    // Terminals and scripts get the default.
    expect(boundary.placeholderEnv()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-lonca-placeholder']);
    profiles.updateProfile(personal, { makeDefault: true });
    store.setClaudeCredential(personal.id, 'sk-ant-api03-a-key');
    expect(boundary.placeholderEnv()).toEqual([`ANTHROPIC_API_KEY=${boundary.placeholderFor(personal)}`]);
  });

  it('gives Codex its sign-in by environment, and the address for its kind, unless the project brings a key', () => {
    const codex = profiles.createProfile('codex', 'personal', 'work');
    system.adoptCodexLogin(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt({ exp: 1800000000 }) } }), codex.id);
    system.saveCodexApiKey('sk-a-key-for-the-first', 'codex');
    expect(boundary.codexTurn(codex, project())).toEqual({
      env: [`CODEX_API_KEY=${boundary.placeholderFor(codex)}`],
      config: ['-c', 'openai_base_url="https://chatgpt.com/backend-api/codex"'],
    });
    expect(boundary.codexTurn(store.state.profiles.find((profile) => profile.id === 'codex'), project())).toEqual({
      env: ['CODEX_API_KEY=oai-oat01-lonca-placeholder'],
      config: ['-c', 'openai_base_url="https://api.openai.com/v1"'],
    });
    for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY']) expect(boundary.codexTurn(codex, project({ [name]: 'sk-own' }))).toEqual({ env: [], config: [] });
    const session = runner.createSession(workspace, { agent: 'codex', profileId: codex.id });
    expect(runner.turnEnv(session, project(), codex.id)).toContain(`CODEX_API_KEY=${boundary.placeholderFor(codex)}`);
    expect(boundary.turnProfile('codex', codex.id, project())).toBe(codex.id);
    expect(boundary.turnProfile('codex', codex.id, project({ OPENAI_API_KEY: 'sk-own' }))).toBeUndefined();
  });

  it('puts the address on the command line of that process alone', async () => {
    const { codexAdapter } = await import('../../server/agents/codex.ts');
    const command = codexAdapter.command({
      session: { model: 'gpt-5.5', effort: 'low', resumeId: 'thread' }, systemPrompt: '', attachments: [],
      config: ['-c', 'openai_base_url="https://chatgpt.com/backend-api/codex"'],
    } as never);
    expect(command.slice(0, 4)).toEqual(['codex', 'exec', 'resume', 'thread']);
    expect(command.slice(-3)).toEqual(['-c', 'openai_base_url="https://chatgpt.com/backend-api/codex"', '-']);
    // Nothing that's a credential goes there, only placeholders' names and addresses.
    expect(command.join(' ')).not.toMatch(/sk-|oat01/);
  });
});

describe('where a conversation can go at a limit', () => {
  const profile = (id: string, agent: 'claude' | 'codex', autoSwitch?: boolean): Profile => ({ id, agent, name: id, createdAt: 0, autoSwitch });
  const list = [profile('claude', 'claude'), profile('claude-aaaaaaaaaaaa', 'claude', true), profile('claude-bbbbbbbbbbbb', 'claude', true), profile('codex', 'codex', true)];
  const status = (statuses: SystemStatus['profiles']) => ({ profiles: statuses, agentsChecked: true }) as unknown as SystemStatus;
  const ready = { signedIn: true };

  it('only moves to one the user chose, that’s signed in, of the same provider, and not at a limit itself', () => {
    const all = status({ claude: ready, 'claude-aaaaaaaaaaaa': ready, 'claude-bbbbbbbbbbbb': ready, codex: ready });
    expect(autoSwitchTarget(list, all, 'claude', 'claude')?.id).toBe('claude-aaaaaaaaaaaa');
    expect(autoSwitchTarget(list, all, 'claude', 'claude-aaaaaaaaaaaa')?.id).toBe('claude-bbbbbbbbbbbb');
    // The first isn't one the user chose.
    expect(autoSwitchTarget([list[0], list[1]], all, 'claude', 'claude-aaaaaaaaaaaa')).toBeUndefined();
    const now = Date.now();
    const busy = status({
      claude: ready, 'claude-aaaaaaaaaaaa': { signedIn: true, limitedAt: now - 1000, limitResetsAt: now + 60000 }, 'claude-bbbbbbbbbbbb': { signedIn: true, rejected: true }, codex: ready,
    });
    expect(autoSwitchTarget(list, busy, 'claude', 'claude', now)).toBeUndefined();
    expect(autoSwitchTarget(list, status({ claude: ready, 'claude-aaaaaaaaaaaa': { signedIn: false }, 'claude-bbbbbbbbbbbb': ready }), 'claude', 'claude')?.id).toBe('claude-bbbbbbbbbbbb');
    // A limit that's over doesn't count, and one with no end counts for a while.
    expect(isLimited({ signedIn: true, limitedAt: now - 1000, limitResetsAt: now - 1 }, now)).toBe(false);
    expect(isLimited({ signedIn: true, limitedAt: now - 1000 }, now)).toBe(true);
    expect(isLimited({ signedIn: true, limitedAt: now - UNKNOWN_LIMIT_MS - 1 }, now)).toBe(false);
  });

  it('offers every other signed-in one by hand, whether or not it was chosen for moving by itself', () => {
    const now = Date.now();
    const options = continueOptions(list, status({
      claude: ready, 'claude-aaaaaaaaaaaa': { signedIn: true, limitedAt: now }, 'claude-bbbbbbbbbbbb': ready, codex: ready,
    }), 'claude', 'claude-bbbbbbbbbbbb', now);
    expect(options.available.map((entry) => entry.id)).toEqual(['claude']);
    expect(options.limited.map((entry) => entry.id)).toEqual(['claude-aaaaaaaaaaaa']);
  });

  it('lets a Lead use its own, another provider’s default, and the ones the user allowed', () => {
    const lead = { agent: 'claude', profileId: 'claude-aaaaaaaaaaaa' } as Session;
    const mine = [...list.slice(0, 2), profile('claude-bbbbbbbbbbbb', 'claude'), profile('codex', 'codex'), profile('codex-cccccccccccc', 'codex')];
    expect(mine.filter((entry) => leadMayUse(lead, entry, mine)).map((entry) => entry.id)).toEqual(['claude-aaaaaaaaaaaa', 'codex']);
    expect(leadDefaultFor(lead, 'claude', mine)).toBe('claude-aaaaaaaaaaaa');
    expect(leadDefaultFor(lead, 'codex', mine)).toBe('codex');
  });

  it('runs on the sign-in a conversation names, and one from before there were several on the first', () => {
    const system = status({ claude: ready, 'claude-aaaaaaaaaaaa': { signedIn: false } });
    expect(canRun({ agent: 'claude' } as Session, system, undefined)).toBe(true);
    expect(canRun({ agent: 'claude', profileId: 'claude-aaaaaaaaaaaa' } as Session, system, undefined)).toBe(false);
    expect(canRun({ agent: 'claude', profileId: 'claude-gone' } as Session, system, undefined)).toBe(false);
    expect(canRun({ agent: 'claude', profileId: 'claude-aaaaaaaaaaaa' } as Session, system, project({ ANTHROPIC_API_KEY: 'sk-own' }))).toBe(true);
  });
});

describe('moving a conversation', () => {
  let workspace: Workspace;
  let personal: Profile;
  let session: Session;
  const ready = () => {
    store.setClaudeCredential('claude', 'sk-ant-oat01-first');
    store.setClaudeCredential(personal.id, 'sk-ant-oat01-second');
    system.describeProfiles();
  };

  beforeEach(() => {
    // Keep accepted work queued: nothing starts in a workspace that's still being created.
    workspace = { id: 'w', projectId: 'project', name: 'prague', sandboxName: 'vm', status: 'creating', steps: [] } as unknown as Workspace;
    store.state.projects.push({ id: 'project', name: 'Project', slug: 'project', settings: { env: {} } } as unknown as Project);
    store.state.workspaces.push(workspace);
    personal = profiles.createProfile('claude', 'personal', 'work');
    session = runner.createSession(workspace, { agent: 'claude' });
  });

  it('keeps the conversation, says so in it, and only to another of the same provider’s that can run', async () => {
    ready();
    session.hasMessages = true;
    await expect(team.moveToProfile(session, 'codex')).rejects.toThrow(/can’t read another provider’s/);
    await expect(team.moveToProfile(session, 'claude-000000000000')).rejects.toThrow(/removed/);
    store.setClaudeCredential(personal.id, undefined);
    system.describeProfiles();
    await expect(team.moveToProfile(session, personal.id)).rejects.toThrow(/isn’t signed in/);
    ready();
    session.resumeId = 'conversation';
    await team.moveToProfile(session, personal.id);
    expect(session).toMatchObject({ profileId: personal.id, resumeId: 'conversation' });
    expect(notices(session.id)).toEqual(['Moved from Claude – work to Claude – personal.']);
  });

  it('applies to the next turn when one is running, and says why at a limit', async () => {
    ready();
    session.hasMessages = true;
    session.status = 'running';
    await team.moveToProfile(session, personal.id);
    expect(notices(session.id).at(-1)).toBe('Moved from Claude – work to Claude – personal. The turn under way finishes on the one it started on.');
    session.status = 'idle';
    Object.assign(session, { lastOutcome: 'limit', limitProfileId: personal.id });
    await team.moveToProfile(session, 'claude');
    expect(notices(session.id).at(-1)).toBe('Moved from Claude – personal to Claude – work because Claude – personal reached its usage limit.');
  });

  it('takes a Lead’s sign-in with the workspace, whatever its model is locked to', async () => {
    ready();
    const lead = runner.createLead(workspace);
    Object.assign(workspace, { leadLockedAt: Date.now() });
    await team.moveToProfile(lead, personal.id);
    expect(workspace.lead).toMatchObject({ agent: 'claude', profileId: personal.id });
    // Nothing to say in a conversation that hasn't started.
    expect(notices(lead.id)).toEqual([]);
  });

  describe('by itself at a usage limit', () => {
    const atLimit = () => {
      Object.assign(session, { hasMessages: true, lastOutcome: 'limit', limitProfileId: 'claude', held: true });
      store.state.profileLimits = { claude: { at: Date.now() } };
      system.describeProfiles();
    };
    const queued = () => session.queue.map((id) => store.loadTranscript(session.id).find((item) => item.id === id)) as UserItem[];

    beforeEach(() => {
      ready();
      session.hasMessages = true;
    });

    it('carries on, on a sign-in the user chose, and records that it did', async () => {
      personal.autoSwitch = true;
      atLimit();
      store.appendTranscript(session.id, [{ id: 'asked', ts: 1, type: 'user', text: 'THE REQUEST' } as ChatItem]);
      store.flushTranscript(session.id);
      await team.limitReached(session, 'claude');
      expect(session).toMatchObject({ profileId: personal.id, lastOutcome: undefined, held: false });
      expect(notices(session.id)).toEqual(['Lonca moved this to Claude – personal because Claude – work reached its usage limit. You chose this in Settings.']);
      expect(queued()).toHaveLength(1);
      expect(queued()[0]).toMatchObject({ from: 'lonca', summary: 'Trying again' });
      expect(queued()[0].text).toContain('THE REQUEST');
    });

    it('stays put when nothing is allowed or ready, and never for a project’s own key', async () => {
      atLimit();
      await team.limitReached(session, 'claude');
      expect(session).toMatchObject({ profileId: 'claude', lastOutcome: 'limit', held: true });
      personal.autoSwitch = true;
      store.state.profileLimits = { ...store.state.profileLimits, [personal.id]: { at: Date.now(), resetsAt: Date.now() + 60000 } };
      system.describeProfiles();
      await team.limitReached(session, 'claude');
      expect(session.profileId).toBe('claude');
      store.state.profileLimits = { claude: { at: Date.now() } };
      system.describeProfiles();
      store.state.projects[0].settings.env = { ANTHROPIC_API_KEY: 'sk-own' };
      await team.limitReached(session, 'claude');
      expect(session.profileId).toBe('claude');
      store.state.projects[0].settings.env = {};
      session.userStopped = true;
      await team.limitReached(session, 'claude');
      expect(session.profileId).toBe('claude');
      expect(notices(session.id)).toEqual([]);
    });

    it('stays put once someone pressed Stop, even if the limit came just before', async () => {
      personal.autoSwitch = true;
      atLimit();
      await team.limitReached(session, 'claude', true);
      expect(session).toMatchObject({ profileId: 'claude', lastOutcome: 'limit', held: true });
      expect(notices(session.id)).toEqual([]);
    });

    it('stays at its limit when carrying on can’t be saved, so it still says so and the Lead hears', async () => {
      personal.autoSwitch = true;
      const agent = runner.createSession(workspace, { role: 'agent', agent: 'claude', work: { job: 'analyze' } });
      Object.assign(agent, { hasMessages: true, lastOutcome: 'limit', limitProfileId: 'claude', held: true, work: { job: 'analyze', unreported: true } });
      store.state.profileLimits = { claude: { at: Date.now() } };
      system.describeProfiles();
      // Only the message that would carry it on fails to save, once.
      const append = fs.appendFileSync;
      let failed = false;
      const failing = vi.spyOn(fs, 'appendFileSync').mockImplementation(((...args: Parameters<typeof fs.appendFileSync>) => {
        if (!failed && String(args[1]).includes('Continue where you left off')) {
          failed = true;
          throw new Error('ENOSPC: no space left on device');
        }
        return append(...args);
      }) as typeof fs.appendFileSync);
      try {
        await expect(team.limitReached(agent, 'claude')).rejects.toThrow(/could not be saved/);
      } finally {
        failing.mockRestore();
      }
      expect(agent).toMatchObject({ profileId: personal.id, lastOutcome: 'limit', limitProfileId: 'claude', held: true, queue: [], work: { unreported: true } });
    });

    it('lets a Lead move its agent only where it may, and says so in the agent’s conversation', async () => {
      const lead = runner.createLead(workspace);
      const agent = runner.createSession(workspace, { role: 'agent', agent: 'claude', work: { job: 'analyze' } });
      Object.assign(agent, { hasMessages: true, lastOutcome: 'limit', limitProfileId: 'claude', held: true });
      const call = (args: Record<string, unknown>, id = 'a'): ToolCall => ({ id: id.repeat(32), tool: 'retry_agent', args: { id: agent.id, ...args } });
      const refused = await team.handleToolCall(lead, call({ sign_in: personal.id }));
      expect(refused).toMatchObject({ failed: true, text: expect.stringContaining('hasn\'t allowed you to use Claude – personal') });
      expect(agent.profileId).toBe('claude');
      personal.autoSwitch = true;
      const moved = await team.handleToolCall(lead, call({ sign_in: personal.id }, 'b'));
      expect(moved.failed).toBeFalsy();
      expect(agent.profileId).toBe(personal.id);
      expect(notices(agent.id)).toEqual(['The Lead moved this from Claude – work to Claude – personal because Claude – work reached its usage limit.']);
      const status = await team.handleToolCall(lead, { id: 'c'.repeat(32), tool: 'team_status', args: {} });
      expect(status.text).toContain(`- ${personal.id}: Claude – personal (allowed): ready`);
      expect(status.text).toContain('- claude: Claude – work (yours): ready');
    });

    it('starts a Lead’s agent on the Lead’s sign-in unless it asks for another it may use', async () => {
      store.state.profiles.find((profile) => profile.id === 'codex')!.name = '';
      const lead = runner.createLead(workspace, { profileId: personal.id });
      expect(lead.profileId).toBe(personal.id);
      const spawn = (args: Record<string, unknown>, id: string): ToolCall => ({ id: id.repeat(32), tool: 'spawn_agent', args: { label: 'A', model: 'claude-sonnet-5-5', job: 'analyze', task: 'x', ...args } });
      await team.handleToolCall(lead, spawn({}, 'd'));
      const first = store.state.sessions.find((entry) => entry.role === 'agent')!;
      expect(first.profileId).toBe(personal.id);
      const refused = await team.handleToolCall(lead, spawn({ sign_in: 'claude' }, 'e'));
      expect(refused.text).toContain('hasn\'t allowed you to use Claude – work');
      const wrong = await team.handleToolCall(lead, spawn({ sign_in: 'codex' }, 'f'));
      expect(wrong.text).toContain('codex is one of Codex’s sign-ins, and this model needs one of Claude’s.');
    });
  });
});
