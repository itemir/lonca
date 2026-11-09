import { describe, expect, it } from 'vitest';
import { BLOCKED_DESTINATIONS, allowRule, createArgs, execArgs, imageNamed, ownTemplateImages, parseSandboxList, parseTemplateList, removableImages, secretArgs, templateListIncludes, type SandboxSpec } from '../../server/sandbox.ts';

const spec: SandboxSpec = {
  name: 'lonca-app-amman',
  image: async () => 'lonca-sandbox:abc',
  env: [],
  mounts: ['/home/me/.lonca/projects/app/workspaces/amman'],
  agentState: '/home/me/.lonca/agent-state/w1',
  secrets: [],
  setup: () => ({ command: ['true'] }),
  network: 'internet',
};

describe('removing old templates', () => {
  const named = (id: string, repository: string, tag: string) => ({ id, repository: `docker.io/library/${repository}`, tag });
  const own = (id: string, tag = id) => named(id, 'lonca-sandbox', tag);
  const copy = (id: string, tag = `${id}-copy`) => named(id, 'sandbox-kit-assembled', tag);
  const base = { id: 'base', repository: 'docker.io/docker/sandbox-templates', tag: 'shell-docker' };

  it('reads the list, which may be empty', () => {
    expect(parseTemplateList('[{"id":"a","repository":"r","tag":"t","size":1}]')).toEqual([{ id: 'a', repository: 'r', tag: 't', size: 1 }]);
    expect(parseTemplateList('[]')).toEqual([]);
    expect(parseTemplateList('null')).toEqual([]);
    expect(parseTemplateList('')).toEqual([]);
  });

  it('finds the image a name points to, however the name is written', () => {
    const images = [own('now', 'tag'), copy('now'), base];
    expect(imageNamed(images, 'lonca-sandbox:tag')).toBe('now');
    expect(imageNamed(images, 'docker/sandbox-templates:shell-docker')).toBe('base');
    expect(imageNamed(images, 'lonca-sandbox:other')).toBeUndefined();
    expect(imageNamed(images, 'other:tag')).toBeUndefined();
  });

  it('counts as its own only what’s under Lonca’s name, not a copy or a second instance’s', () => {
    const images = [own('a'), own('b'), copy('a'), copy('orphan'), named('c', 'lonca-instance-sandbox', 'c'), named('d', 'my-template', '1'), base];
    expect(ownTemplateImages(images)).toEqual(['a', 'b']);
  });

  it('frees an image of Lonca’s, or one with only a copy’s name left', () => {
    const images = [own('old'), copy('old'), copy('replaced'), own('now'), copy('now')];
    expect(removableImages(images, ['old', 'replaced'], new Set(['now']))).toEqual(['old', 'replaced']);
  });

  it('keeps the current template and whatever a workspace’s VM was made from', () => {
    const images = [own('old'), copy('old'), copy('replaced'), own('now')];
    expect(removableImages(images, ['old', 'replaced', 'now'], new Set(['now', 'replaced', undefined]))).toEqual(['old']);
  });

  it('keeps anything something else has a name for, whatever else it has', () => {
    const images = [base, copy('base'), named('mine', 'my-template', '1'), copy('mine'), own('both'), named('both', 'my-template', '2'), named('other', 'lonca-instance-sandbox', 'x')];
    expect(removableImages(images, ['base', 'mine', 'both', 'other'], new Set())).toEqual([]);
  });

  it('ignores what’s already gone, and asks once about each image', () => {
    expect(removableImages([own('a'), copy('a')], ['a', 'a', 'gone'], new Set())).toEqual(['a']);
    expect(removableImages([], ['a'], new Set())).toEqual([]);
  });
});

describe('talking to the sbx CLI', () => {
  it('reads the sandbox list, which may be empty', () => {
    expect(parseSandboxList('[{"name":"a","status":"running"},{"name":"b","status":"stopped"},{"name":"c","status":"running (not responding)"}]'))
      .toEqual([{ name: 'a', running: true }, { name: 'b', running: false }, { name: 'c', running: true }]);
    expect(parseSandboxList('[]')).toEqual([]);
    expect(parseSandboxList('null')).toEqual([]);
    expect(parseSandboxList('')).toEqual([]);
    expect(parseSandboxList('[{"status":"running"}]')).toEqual([]);
  });

  it('matches an image and its tag together, rather than parts of unrelated templates', () => {
    const listed = 'lonca-custom:v1\nanother-project:v2\nlonca-custom:v20\n';
    expect(templateListIncludes(listed, 'lonca-custom:v1')).toBe(true);
    expect(templateListIncludes(listed, 'lonca-custom:v2')).toBe(false);
    expect(templateListIncludes(listed, 'custom:v1')).toBe(false);
    expect(templateListIncludes('', 'lonca-custom:v1')).toBe(false);
  });

  it('recognizes canonical Docker Hub names and implicit latest tags without confusing registry ports', () => {
    const listed = 'docker.io/library/lonca-sandbox:abc\ndocker.io/team/custom:latest\nlocalhost:5000/custom:latest\n';
    expect(templateListIncludes(listed, 'lonca-sandbox:abc')).toBe(true);
    expect(templateListIncludes(listed, 'index.docker.io/library/lonca-sandbox:abc')).toBe(true);
    expect(templateListIncludes(listed, 'team/custom')).toBe(true);
    expect(templateListIncludes(listed, 'localhost:5000/custom')).toBe(true);
    expect(templateListIncludes(listed, 'localhost:5000/custom:other')).toBe(false);
    expect(templateListIncludes(listed, 'another-registry.test/team/custom')).toBe(false);
  });

  it('creates a sandbox from the template, with the checkout first and nothing else of the host', () => {
    const args = createArgs(spec, 'lonca-sandbox:abc');
    expect(args.slice(0, 2)).toEqual(['run', '--detach']);
    expect(args[args.indexOf('--name') + 1]).toBe('lonca-app-amman');
    expect(args[args.indexOf('--template') + 1]).toBe('lonca-sandbox:abc');
    expect(args[args.indexOf('--pull') + 1]).toBe('never');
    expect(args[args.indexOf('--skills') + 1]).toBe('off');
    expect(args.slice(args.indexOf('shell'))).toEqual(['shell', ...spec.mounts, spec.agentState]);
  });

  it('gives the proxy a command to read a secret, for one sandbox, rather than the secret', () => {
    expect(secretArgs('box', { service: 'github', file: '/home/me/.lonca/boundary/github' })).toEqual([
      'secret', 'set', 'github', '--sandbox', 'box', '--command', "/bin/cat '/home/me/.lonca/boundary/github'", '--refresh', 'on-demand', '--no-verify', '--force',
    ]);
    expect(secretArgs('box', { hosts: ['a.example', 'b.example'], placeholder: 'stand-in', file: "/home/o'neil/.lonca/boundary/codex" })).toEqual([
      'secret', 'set-custom', '--host', 'a.example', '--host', 'b.example', '--placeholder', 'stand-in', '--sandbox', 'box', '--command', "/bin/cat '/home/o'\\''neil/.lonca/boundary/codex'", '--refresh', 'on-demand', '--no-verify',
    ]);
  });

  it('publishes ten ports on loopback, and sets limits only when asked', () => {
    expect(createArgs(spec, 'x')).not.toContain('--publish');
    expect(createArgs(spec, 'x')).not.toContain('--memory');
    const args = createArgs({ ...spec, firstPort: 20010, memoryGb: 2.5, cpus: 1.5 }, 'x');
    const published = args.filter((_, index) => args[index - 1] === '--publish');
    expect(published).toHaveLength(10);
    expect(published[0]).toBe('127.0.0.1:20010:20010');
    expect(published[9]).toBe('127.0.0.1:20019:20019');
    expect(args[args.indexOf('--memory') + 1]).toBe('2560m');
    expect(args[args.indexOf('--cpus') + 1]).toBe('2');
  });

  it('blocks the host and private networks unless the project opts in', () => {
    const denied = (network: SandboxSpec['network']) => {
      const args = createArgs({ ...spec, network }, 'x');
      return args.filter((_, index) => args[index - 1] === '--deny-network');
    };
    expect(denied('internet')).toEqual(BLOCKED_DESTINATIONS);
    for (const destination of ['localhost', 'host.docker.internal', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7']) {
      expect(BLOCKED_DESTINATIONS).toContain(destination);
    }
    expect(denied('host')).toEqual([]);
    expect(allowRule('internet')).toBe('**');
    expect(allowRule('host')).toBe('**,localhost');
  });

  it('keeps secrets off the command line, where any process could read them', () => {
    const { args, env } = execArgs('box', ['claude', '-p'], { env: ['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret', 'GH_TOKEN=gho_secret'], workdir: '/w' });
    expect(args.join(' ')).not.toContain('secret');
    expect(args).toContain('--env=CLAUDE_CODE_OAUTH_TOKEN');
    expect(args).toContain('--env=GH_TOKEN');
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret', GH_TOKEN: 'gho_secret' });
    expect(args.slice(-8)).toEqual(['box', '--', 'sh', '-c', 'exec "$@" </dev/null', 'sh', 'claude', '-p']);
    expect(args[args.indexOf('--workdir') + 1]).toBe('/w');
  });

  it('clears the placeholder key sbx plants, unless there’s a real one to use', () => {
    const flags = (env: string[]) => execArgs('box', ['claude', '-p'], { env }).args.filter((arg) => arg.startsWith('--env=ANTHROPIC_API_KEY'));
    expect(flags([])).toEqual(['--env=ANTHROPIC_API_KEY=']);
    expect(flags(['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret'])).toEqual(['--env=ANTHROPIC_API_KEY=']);
    const withKey = execArgs('box', ['claude', '-p'], { env: ['ANTHROPIC_API_KEY=sk-ant-api03-secret'] });
    expect(withKey.args.filter((arg) => arg.startsWith('--env=ANTHROPIC_API_KEY'))).toEqual(['--env=ANTHROPIC_API_KEY']);
    expect(withKey.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-secret');
  });

  it('passes each variable once, with the last value winning', () => {
    const { args, env } = execArgs('box', ['true'], { env: ['A=first', 'B=', 'A=second'] });
    expect(args.filter((arg) => arg.startsWith('--env=A'))).toHaveLength(2);
    expect(args.filter((arg) => arg === '--env=A')).toHaveLength(1);
    expect(env.A).toBe('second');
    expect(args).toContain('--env=B=');
  });

  it('won’t let a project’s variable take over what sbx itself runs on', () => {
    const { args, env } = execArgs('box', ['true'], { env: ['HOME=/elsewhere', 'PATH=/bin', 'DOCKER_HOST=tcp://x', 'SBX_NO_TELEMETRY=0'] });
    expect(env).toEqual({});
    expect(args).toContain('--env=HOME=/elsewhere');
    expect(args).toContain('--env=PATH=/bin');
    expect(args).toContain('--env=DOCKER_HOST=tcp://x');
  });

  it('gives a command nothing to read, unless there’s something to send', () => {
    // sbx gives every command a pipe for stdin, and rg, for one, reads that instead of the files.
    expect(execArgs('box', ['rg', 'hello'], {}).args.slice(-7)).toEqual(['--', 'sh', '-c', 'exec "$@" </dev/null', 'sh', 'rg', 'hello']);
    expect(execArgs('box', ['cat'], { interactive: true }).args.slice(-3)).toEqual(['box', '--', 'cat']);
  });

  it('asks for stdin only when there’s something to send', () => {
    expect(execArgs('box', ['true'], {}).args).not.toContain('--interactive');
    expect(execArgs('box', ['cat'], { interactive: true }).args).toContain('--interactive');
  });
});
