import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../shared/types.ts';

let home: string;
let store: typeof import('../../server/store.ts');
let boundary: typeof import('../../server/boundary.ts');
let system: typeof import('../../server/system.ts');

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const project = (env: Record<string, string> = {}) => ({ settings: { env } }) as unknown as Project;
const boundaryFile = (name: string) => path.join(home, 'boundary', name);

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-boundary-'));
  vi.stubEnv('LONCA_HOME', home);
  vi.resetModules();
  store = await import('../../server/store.ts');
  boundary = await import('../../server/boundary.ts');
  system = await import('../../server/system.ts');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('what a virtual machine is given', () => {
  it('is a placeholder, in the variable for the kind of credential the proxy will add', () => {
    expect(boundary.placeholderEnv()).toEqual([]);
    store.updateSecrets({ claudeToken: 'sk-ant-oat01-real-sign-in' });
    expect(boundary.placeholderEnv()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-lonca-placeholder']);
    store.updateSecrets({ claudeToken: 'sk-ant-api03-real-key' });
    expect(boundary.placeholderEnv()).toEqual(['ANTHROPIC_API_KEY=sk-ant-oat01-lonca-placeholder']);
  });

  it('never goes to the whole machine: every secret names files outside what a VM mounts', () => {
    for (const secret of boundary.proxySecrets()) expect(secret.file.startsWith(path.join(fs.realpathSync(home), 'boundary'))).toBe(true);
  });
});

describe('what the proxy reads', () => {
  it('follows signing in and out, readable only by you', () => {
    store.updateSecrets({ claudeToken: 'sk-ant-oat01-real', githubToken: 'gho_real' });
    expect(fs.readFileSync(boundaryFile('claude'), 'utf8')).toBe('sk-ant-oat01-real');
    expect(fs.readFileSync(boundaryFile('github'), 'utf8')).toBe('gho_real');
    expect(fs.statSync(boundaryFile('github')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, 'boundary')).mode & 0o777).toBe(0o700);
    store.updateSecrets({ githubToken: '' });
    expect(fs.existsSync(boundaryFile('github'))).toBe(false);
    expect(fs.existsSync(boundaryFile('claude'))).toBe(true);
  });

  it('is filled in from sign-ins saved before there was a proxy', async () => {
    fs.writeFileSync(path.join(home, 'secrets.json'), JSON.stringify({ githubToken: 'gho_saved' }));
    vi.resetModules();
    await import('../../server/store.ts');
    expect(fs.readFileSync(boundaryFile('github'), 'utf8')).toBe('gho_saved');
  });
});

describe('Codex’s sign-in', () => {
  const oldLogin = () => path.join(home, 'credentials', 'codex', 'auth.json');
  const newLogin = () => path.join(home, 'helper-credentials', 'codex', 'auth.json');
  const login = (token: string) => JSON.stringify({ tokens: { access_token: jwt({ exp: 1800000000, token }) } });

  it('reads what to send and when it ends, and doesn’t trust the file', () => {
    expect(system.codexCredential(JSON.stringify({ OPENAI_API_KEY: 'sk-key' }))).toEqual({ value: 'sk-key' });
    expect(system.codexCredential('{"tokens":{"access_token":"not-a-jwt"}}')).toEqual({ value: 'not-a-jwt' });
    const token = jwt({ exp: 1800000000 });
    expect(system.codexCredential(JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: token } }))).toEqual({ value: token, expiresAt: 1800000000000 });
    expect(system.codexCredential(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-beside-it', tokens: { access_token: token } }))).toEqual({ value: token, expiresAt: 1800000000000 });
    for (const bad of ['', 'not json', '{}', '{"tokens":{"access_token":7}}', '{"OPENAI_API_KEY":{"evil":true}}']) expect(system.codexCredential(bad)).toBeNull();
  });

  it('moves out of the directory older workspaces have mounted, which stays for them', () => {
    fs.mkdirSync(path.dirname(oldLogin()), { recursive: true });
    fs.writeFileSync(oldLogin(), login('old-place'));
    system.moveCodexLogin();
    expect(fs.existsSync(oldLogin())).toBe(false);
    expect(fs.existsSync(path.join(home, 'credentials'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'helper-credentials', 'old-codex'))).toBe(false);
    expect(fs.statSync(newLogin()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(newLogin(), 'utf8')).tokens.access_token).toBe(JSON.parse(login('old-place')).tokens.access_token);
    expect(fs.readFileSync(boundaryFile('codex'), 'utf8')).toBe(JSON.parse(login('old-place')).tokens.access_token);
  });

  describe('with something an older workspace put in the old directory', () => {
    const key = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-on-this-computer' });
    let elsewhere: string;
    const elsewhereFile = () => path.join(elsewhere, 'auth.json');
    const oldDir = () => path.dirname(oldLogin());
    const plants: Record<string, () => void> = {
      'the directory as a link': () => fs.symlinkSync(elsewhere, oldDir()),
      'the file as a link': () => {
        fs.mkdirSync(oldDir());
        fs.symlinkSync(elsewhereFile(), oldLogin());
      },
      'the directory as a link to a file': () => fs.symlinkSync(elsewhereFile(), oldDir()),
      'the directory as a file': () => fs.writeFileSync(oldDir(), key),
      'the file as a directory': () => fs.mkdirSync(oldLogin(), { recursive: true }),
      'a link inside the directory': () => {
        fs.mkdirSync(oldDir());
        fs.symlinkSync(elsewhere, path.join(oldDir(), 'more'));
      },
      'the file as a pipe': () => {
        fs.mkdirSync(oldDir());
        execFileSync('mkfifo', [oldLogin()]);
      },
      'a file too big to be a login': () => {
        fs.mkdirSync(oldDir());
        fs.writeFileSync(oldLogin(), JSON.stringify({ OPENAI_API_KEY: 'sk-'.padEnd(70000, 'x') }));
      },
    };

    beforeEach(() => {
      elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'lonca-elsewhere-'));
      fs.writeFileSync(elsewhereFile(), key);
      fs.mkdirSync(path.join(home, 'credentials'));
    });
    afterEach(() => fs.rmSync(elsewhere, { recursive: true, force: true }));

    for (const [name, plant] of Object.entries(plants)) {
      for (const first of [true, false]) {
        it(`${name}, on ${first ? 'the first start' : 'a later start'}: starts, and touches nothing else`, () => {
          if (!first) {
            fs.mkdirSync(path.join(home, 'helper-credentials'));
            fs.writeFileSync(path.join(home, 'helper-credentials', 'moved'), '');
          }
          plant();
          system.moveCodexLogin();
          expect(fs.readFileSync(elsewhereFile(), 'utf8')).toBe(key);
          expect(fs.existsSync(newLogin())).toBe(false);
          expect(fs.existsSync(boundaryFile('codex'))).toBe(false);
          expect(fs.lstatSync(oldDir(), { throwIfNoEntry: false })).toBeUndefined();
          expect(fs.existsSync(path.join(home, 'helper-credentials', 'old-codex'))).toBe(false);
          expect(fs.existsSync(path.join(home, 'helper-credentials', 'moved'))).toBe(true);
        });
      }
    }

    it('picks a login up from where it was taken to, if the last start was stopped before saving it', () => {
      fs.mkdirSync(path.join(home, 'helper-credentials', 'old-codex'), { recursive: true });
      fs.writeFileSync(path.join(home, 'helper-credentials', 'old-codex', 'auth.json'), login('old-place'));
      system.moveCodexLogin();
      expect(fs.readFileSync(boundaryFile('codex'), 'utf8')).toBe(JSON.parse(login('old-place')).tokens.access_token);
      expect(fs.existsSync(path.join(home, 'helper-credentials', 'old-codex'))).toBe(false);
    });
  });

  it('finishes a move that was stopped partway, rather than deleting the only copy', () => {
    fs.mkdirSync(path.dirname(oldLogin()), { recursive: true });
    fs.writeFileSync(oldLogin(), login('old-place'));
    // What being stopped just after making the new directory leaves behind.
    fs.mkdirSync(path.dirname(newLogin()), { recursive: true });
    system.moveCodexLogin();
    expect(JSON.parse(fs.readFileSync(newLogin(), 'utf8')).tokens.access_token).toBe(JSON.parse(login('old-place')).tokens.access_token);
  });

  it('prefers the login it has moved over anything left in the old place', () => {
    fs.mkdirSync(path.dirname(newLogin()), { recursive: true });
    fs.writeFileSync(newLogin(), login('moved'));
    fs.mkdirSync(path.dirname(oldLogin()), { recursive: true });
    fs.writeFileSync(oldLogin(), login('left-behind'));
    system.moveCodexLogin();
    expect(fs.existsSync(oldLogin())).toBe(false);
    expect(JSON.parse(fs.readFileSync(newLogin(), 'utf8')).tokens.access_token).toBe(JSON.parse(login('moved')).tokens.access_token);
  });

  it('drops an API key kept beside a ChatGPT sign-in when it starts, and leaves one chosen on purpose', () => {
    const chatgpt = { auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-got-while-signing-in', tokens: { access_token: jwt({ exp: 1800000000 }), refresh_token: 'rt' } };
    fs.mkdirSync(path.dirname(newLogin()), { recursive: true });
    fs.writeFileSync(newLogin(), JSON.stringify(chatgpt));
    system.moveCodexLogin();
    expect(JSON.parse(fs.readFileSync(newLogin(), 'utf8'))).toEqual({ ...chatgpt, OPENAI_API_KEY: null });
    expect(fs.statSync(newLogin()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(boundaryFile('codex'), 'utf8')).toBe(chatgpt.tokens.access_token);

    const onPurpose = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-on-purpose' });
    fs.writeFileSync(newLogin(), onPurpose);
    system.moveCodexLogin();
    expect(fs.readFileSync(newLogin(), 'utf8')).toBe(onPurpose);
    expect(fs.readFileSync(boundaryFile('codex'), 'utf8')).toBe('sk-on-purpose');
  });

  it('keeps what a finished sign-in saved only if it’s a login, and the one it has if not', () => {
    const first = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: jwt({ exp: 1800000000, label: 'first' }), refresh_token: 'rt' } });
    expect(system.adoptCodexLogin(first)).toBe(true);
    for (const notALogin of ['', '{"auth_mode":"chatgpt","tokens":{"access_tok', '{}']) expect(system.adoptCodexLogin(notALogin)).toBe(false);
    expect(fs.readFileSync(newLogin(), 'utf8')).toBe(first);
    expect(fs.readFileSync(boundaryFile('codex'), 'utf8')).toBe(JSON.parse(first).tokens.access_token);
  });

  it('doesn’t believe anything an older workspace leaves there afterwards', () => {
    system.moveCodexLogin();
    fs.mkdirSync(path.dirname(oldLogin()), { recursive: true });
    fs.writeFileSync(oldLogin(), login('planted'));
    system.moveCodexLogin();
    expect(fs.existsSync(oldLogin())).toBe(false);
    expect(fs.existsSync(newLogin())).toBe(false);
    expect(fs.existsSync(boundaryFile('codex'))).toBe(false);
  });
});

describe('setting Codex up in a VM', () => {
  const run = ({ command, stdin }: { command: string[]; stdin?: string }) => execFileSync(command[0], command.slice(1), { input: stdin, env: { ...process.env, HOME: home } });
  const config = () => fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  const auth = () => JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  const CHATGPT = 'cli_auth_credentials_store = "file"\nopenai_base_url = "https://chatgpt.com/backend-api/codex"\n';
  const PLAIN = 'cli_auth_credentials_store = "file"\n';

  it('gives it a placeholder, at the address for a ChatGPT sign-in', () => {
    run(boundary.codexSetup(project()));
    expect(auth()).toEqual({ OPENAI_API_KEY: 'oai-oat01-lonca-placeholder' });
    expect(config()).toBe(CHATGPT);
  });

  it('follows a change to an API key and back, which needs the usual address', () => {
    run(boundary.codexSetup(project()));
    store.setBoundaryValue('codex', 'sk-real-key');
    run(boundary.codexSetup(project()));
    expect(config()).toBe(PLAIN);
    store.setBoundaryValue('codex', 'eyJ-a-sign-in');
    run(boundary.codexSetup(project()));
    expect(config()).toBe(CHATGPT);
  });

  it('uses a project’s own key at the usual address, and goes back when it’s gone', () => {
    for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY']) {
      run(boundary.codexSetup(project({ [name]: 'sk-own' })));
      expect(config()).toBe(PLAIN);
      expect(auth()).toEqual({ OPENAI_API_KEY: 'sk-own' });
      expect(boundary.codexSetup(project({ [name]: 'sk-own' })).command.join(' ')).not.toContain('sk-own');
      expect(fs.statSync(path.join(home, '.codex', 'auth.json')).mode & 0o777).toBe(0o600);
      run(boundary.codexSetup(project()));
      expect(config()).toBe(CHATGPT);
      expect(auth()).toEqual({ OPENAI_API_KEY: 'oai-oat01-lonca-placeholder' });
    }
  });

  it('replaces the config an older VM has, but not someone’s own', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), PLAIN);
    run(boundary.codexSetup(project()));
    expect(config()).toBe(CHATGPT);
    const own = 'model_provider = "mine"\n';
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), own);
    run(boundary.codexSetup(project()));
    expect(config()).toBe(own);
  });

  it('leaves files alone when they’re already right, so a CLI starting now can’t find them missing', () => {
    run(boundary.codexSetup(project()));
    const before = [fs.statSync(path.join(home, '.codex', 'auth.json')).ino, fs.statSync(path.join(home, '.codex', 'config.toml')).ino];
    run(boundary.codexSetup(project()));
    expect([fs.statSync(path.join(home, '.codex', 'auth.json')).ino, fs.statSync(path.join(home, '.codex', 'config.toml')).ino]).toEqual(before);
    expect(fs.readdirSync(path.join(home, '.codex')).sort()).toEqual(['auth.json', 'config.toml']);
  });

  it('drops a link to the old shared login without writing through it, and a login run by hand', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    const shared = path.join(home, 'shared.json');
    fs.writeFileSync(shared, 'old');
    fs.symlinkSync(shared, path.join(home, '.codex', 'auth.json'));
    run(boundary.codexSetup(project()));
    expect(fs.lstatSync(path.join(home, '.codex', 'auth.json')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(shared, 'utf8')).toBe('old');
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"tokens":{"access_token":"real"}}');
    run(boundary.codexSetup(project()));
    expect(auth()).toEqual({ OPENAI_API_KEY: 'oai-oat01-lonca-placeholder' });
  });
});
