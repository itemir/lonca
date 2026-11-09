import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { githubGitAuth } from '../../server/git-auth.ts';

const token = 'github_pat_fake_import_credential';
const remote = 'https://github.com/owner/private.git';

function credential(url: string, operation = 'fill') {
  const auth = githubGitAuth(remote, token);
  return spawnSync('git', [
    '-c', 'credential.helper=',
    // An existing host helper must not override or save Lonca's credential.
    '-c', 'credential.helper=!f() { echo host-helper-called >&2; echo username=host; echo password=host-token; }; f',
    ...auth.args, 'credential', operation,
  ], {
    input: `url=${url}\n\n`, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...auth.env },
  });
}

describe('GitHub import credentials', () => {
  it('supplies the saved credential through Git without putting it in command arguments', () => {
    const auth = githubGitAuth(remote, token);
    expect(auth.args.join(' ')).not.toContain(token);
    for (const url of [remote, 'https://github.com:443/owner/private.git']) {
      const result = credential(url);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('username=x-access-token\n');
      expect(result.stdout).toContain(`password=${token}\n`);
    }
  });

  it('leaves credentials for other hosts, protocols, and ports to the host', () => {
    for (const url of ['https://gitlab.com/o/r', 'https://github.com.example/o/r', 'http://github.com/o/r', 'https://github.com:8443/o/r']) {
      expect(githubGitAuth(url, token)).toEqual({ args: [], env: {} });
      const result = credential(url);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('password=host-token\n');
      expect(result.stdout).not.toContain(token);
    }
    expect(githubGitAuth(remote, undefined)).toEqual({ args: [], env: {} });
  });

  it('sends GitHub’s SSH addresses over HTTPS, so that the saved token is what’s used', () => {
    for (const ssh of ['git@github.com:owner/private.git', 'ssh://git@github.com/owner/private.git']) {
      const auth = githubGitAuth(ssh, token);
      expect(auth.env).toEqual({ LONCA_GITHUB_TOKEN: token });
      const rewritten = spawnSync('git', [...auth.args, 'ls-remote', '--get-url', ssh], {
        encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      expect(rewritten.stdout.trim(), rewritten.stderr).toBe('https://github.com/owner/private.git');
    }
    // Without a token, or for another host, this computer's own SSH is used.
    expect(githubGitAuth('git@github.com:owner/repo.git', undefined)).toEqual({ args: [], env: {} });
    expect(githubGitAuth('git@gitlab.com:owner/repo.git', token)).toEqual({ args: [], env: {} });
  });

  it('does not send the token to a credential store', () => {
    const result = credential(`${remote}\nusername=x-access-token\npassword=${token}`, 'approve');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('host-helper-called');
  });
});
