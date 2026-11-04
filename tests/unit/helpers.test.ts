import { describe, expect, it } from 'vitest';
import { isClaudeCredential } from '../../server/store.ts';
import { normalizeCheck, parseNameStatus, parseNumstat, safeAttachmentName, safeRelativePath } from '../../server/inspect.ts';
import { pickWorkspaceName } from '../../server/names.ts';
import { normalizeRemoteUrl, parseGithubOwner, repoNameFromUrl, stripUrlCredentials } from '../../server/projects.ts';
import { describeClaudeSignIn, describeCodexSignIn, parseClaudeStatus, parseCodexCatalog, parseCodexStatus } from '../../server/system.ts';
import { KeyedQueue, slugify } from '../../server/util.ts';

describe('paths from clients', () => {
  it('keeps them inside the workspace', () => {
    expect(safeRelativePath('src/a.ts')).toBe('src/a.ts');
    expect(safeRelativePath('/src/a.ts')).toBe('src/a.ts');
    expect(safeRelativePath('')).toBe('.');
    expect(safeRelativePath('a/../b')).toBe('b');
    expect(() => safeRelativePath('../secret')).toThrow();
    expect(() => safeRelativePath('a/../../secret')).toThrow();
  });

  it('strips directories from attachment names', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentName('C:\\Users\\me\\pic.png')).toBe('pic.png');
    expect(safeAttachmentName('.hidden')).toBe('hidden');
    expect(safeAttachmentName('...')).toBe('attachment');
    expect(safeAttachmentName('a;rm -rf.txt')).toBe('a_rm -rf.txt');
  });
});

describe('git output', () => {
  it('parses numstat, including renames and binary files', () => {
    const stats = parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\x005\t2\t\0old.ts\0new.ts\0');
    expect(stats.get('src/a.ts')).toEqual({ added: 3, removed: 1, binary: false });
    expect(stats.get('img.png')).toEqual({ added: 0, removed: 0, binary: true });
    expect(stats.get('new.ts')).toEqual({ added: 5, removed: 2, binary: false, oldPath: 'old.ts' });
  });

  it('parses name-status, including renames', () => {
    const statuses = parseNameStatus('M\0a.ts\0A\0b.ts\0D\0c.ts\0R100\0old.ts\0new.ts\0T\0d.ts\0');
    expect(Object.fromEntries(statuses)).toEqual({ 'a.ts': 'M', 'b.ts': 'A', 'c.ts': 'D', 'new.ts': 'R', 'd.ts': 'M' });
  });
});

describe('repository URLs', () => {
  it('accepts common GitHub forms and rejects everything else', () => {
    expect(normalizeRemoteUrl('owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(normalizeRemoteUrl(' https://github.com/owner/repo ')).toBe('https://github.com/owner/repo');
    expect(normalizeRemoteUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
    expect(normalizeRemoteUrl('ssh://git@github.com/owner/repo.git')).toBe('ssh://git@github.com/owner/repo.git');
    expect(() => normalizeRemoteUrl('not a url')).toThrow();
    expect(() => normalizeRemoteUrl('--upload-pack=evil')).toThrow();
    expect(() => normalizeRemoteUrl('ext::sh -c evil')).toThrow();
    expect(() => normalizeRemoteUrl('file:///etc')).toThrow();
  });

  it('keeps tokens out of remote URLs, where workspaces could read them', () => {
    expect(stripUrlCredentials('https://me:ghp_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(stripUrlCredentials('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(stripUrlCredentials('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(() => normalizeRemoteUrl('https://me:ghp_secret@github.com/a/b.git')).toThrow(/token/);
  });

  it('finds the owner and name', () => {
    expect(parseGithubOwner('git@github.com:itemir/lonca.git')).toBe('itemir');
    expect(parseGithubOwner('https://github.com/octocat/Hello-World.git')).toBe('octocat');
    expect(parseGithubOwner('https://gitlab.com/a/b.git')).toBeNull();
    expect(parseGithubOwner(null)).toBeNull();
    expect(repoNameFromUrl('git@github.com:itemir/lonca.git')).toBe('lonca');
    expect(repoNameFromUrl('https://github.com/a/b/')).toBe('b');
  });
});

describe('agent status', () => {
  it('reads Claude’s JSON status', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true);
    expect(parseClaudeStatus('{"loggedIn":false}')).toBe(false);
    expect(parseClaudeStatus('oops')).toBe(false);
  });

  it('reads Codex’s text status', () => {
    expect(parseCodexStatus('Logged in using ChatGPT\n', 0)).toBe(true);
    expect(parseCodexStatus('API key configured - sk-***\n', 0)).toBe(true);
    expect(parseCodexStatus('Not logged in\n', 0)).toBe(false);
    expect(parseCodexStatus('Not logged in\n', 1)).toBe(false);
  });

  it('describes how each agent is signed in, in plain words', () => {
    expect(describeClaudeSignIn('sk-ant-oat01-abcdefgh')).toMatchObject({ summary: 'Signed in with your Claude subscription', usesKey: false });
    expect(describeClaudeSignIn('sk-ant-api03-abcdefgh')).toMatchObject({ summary: 'Using an API key ending in efgh', usesKey: true });
    expect(describeClaudeSignIn(undefined)).toEqual({});
    expect(describeCodexSignIn(JSON.stringify({ OPENAI_API_KEY: 'sk-abcd1234' }))).toMatchObject({ summary: 'Using an API key ending in 1234', usesKey: true });
    const payload = Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url');
    expect(describeCodexSignIn(JSON.stringify({ tokens: { id_token: `h.${payload}.s` } })).summary).toBe('Signed in with ChatGPT as me@example.com');
    expect(describeCodexSignIn(JSON.stringify({ tokens: { id_token: 'nonsense' } })).summary).toBe('Signed in with ChatGPT');
    expect(describeCodexSignIn('not json').summary).toBe('Signed in with ChatGPT');
    expect(describeCodexSignIn(JSON.stringify({ OPENAI_API_KEY: { evil: true } })).summary).toBe('Signed in with ChatGPT');
  });

  it('offers only models the CLI lists, in its order', () => {
    const models = parseCodexCatalog(JSON.stringify({
      models: [
        { slug: 'b', display_name: 'B', visibility: 'list', priority: 2, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }] },
        { slug: 'hidden', visibility: 'hide', priority: 0 },
        { slug: 'a', display_name: 'A', visibility: 'list', priority: 1, default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }] },
      ],
    }));
    expect(models).toEqual([
      { id: 'a', label: 'A', efforts: ['high', 'max'], defaultEffort: 'high' },
      { id: 'b', label: 'B', efforts: ['low'], defaultEffort: 'low' },
    ]);
  });
});

describe('GitHub checks', () => {
  it('normalizes check runs and status contexts', () => {
    expect(normalizeCheck({ name: 'ci', status: 'IN_PROGRESS', conclusion: '' }).status).toBe('pending');
    expect(normalizeCheck({ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }).status).toBe('success');
    expect(normalizeCheck({ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' })).toEqual({ name: 'ci', status: 'failure', url: 'u' });
    expect(normalizeCheck({ context: 'old', state: 'PENDING' }).status).toBe('pending');
    expect(normalizeCheck({ context: 'old', state: 'SUCCESS', targetUrl: 'u' })).toEqual({ name: 'old', status: 'success', url: 'u' });
    expect(normalizeCheck({ name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' }).status).toBe('skipped');
  });
});

describe('small helpers', () => {
  it('picks unused city names', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const name = pickWorkspaceName(taken);
      expect(taken.has(name)).toBe(false);
      expect(name).toMatch(/^[a-z0-9-]+$/);
      taken.add(name);
    }
  });

  it('makes names safe for paths and Docker', () => {
    expect(slugify('Pirates_of_the_West!')).toBe('pirates-of-the-west');
    expect(slugify('***')).toBe('project');
  });

  it('runs one task per key at a time, surviving failures', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    let release = () => {};
    const first = queue.run('k', () => new Promise<void>((resolve) => {
      order.push('first');
      release = resolve;
    }));
    const second = queue.run('k', async () => {
      order.push('second');
      throw new Error('boom');
    });
    const third = queue.run('k', async () => order.push('third'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first']);
    release();
    await first;
    await expect(second).rejects.toThrow('boom');
    await third;
    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('saved Claude credentials', () => {
  it('accepts real ones and refuses the code a browser shows', () => {
    expect(isClaudeCredential(`sk-ant-oat01-${'c'.repeat(90)}`)).toBe(true);
    expect(isClaudeCredential(`sk-ant-api03-${'c'.repeat(90)}`)).toBe(true);
    expect(isClaudeCredential('BMp0bJmrftqKRaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBe(false);
    expect(isClaudeCredential('sk-ant-short')).toBe(false);
    expect(isClaudeCredential('')).toBe(false);
  });
});
