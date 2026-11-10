// Records the frames for the README's GIF: a throwaway Lonca on real Docker Sandboxes VMs, running
// the real CLIs against the scripted model in director.ts, with Chromium driven through one scene.
// Writes frames, timeline.json and the overlay to dist/demo, for make-gif.py. docs/development.md
// says how to run it.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Locator, type Page } from '@playwright/test';
import { Lonca, REAL_SANDBOX, REPO_ROOT, git, sandboxExecAsync, sleep, until } from '../../tests/support/harness.ts';
import { USER_ASK, setWorkspaceRoot, startDirector } from './director.ts';

if (!REAL_SANDBOX) {
  // Containers would make every caption about virtual machines untrue.
  console.error('Run this with LONCA_TEST_RUNTIME=sandbox, so the workspace is a real virtual machine.');
  process.exit(1);
}

const OUT = path.join(REPO_ROOT, 'dist', 'demo');
const FRAMES = path.join(OUT, 'frames');
const VIEW = { width: 1200, height: 740 };

type Frame = { file: string; t: number; scene: string; speed: number };
const timeline: Frame[] = [];
let scene = 'start';
let speed = 1;
let capturing = false;
const t0 = Date.now();

/** Marks where a scene starts, and how much faster than real time make-gif.py plays it from here. */
function mark(next: string, faster = 1): void {
  scene = next;
  speed = faster;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${scene} x${speed}`);
}

function makeLogbook(): string {
  // A short path, since the home page shows it. Only a folder this script made is ever removed.
  const parent = '/private/tmp/projects';
  if (fs.existsSync(parent) && !fs.existsSync(path.join(parent, '.lonca-demo'))) throw new Error(`${parent} exists and isn't the demo's`);
  fs.rmSync(parent, { recursive: true, force: true });
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, '.lonca-demo'), '');
  const dir = path.join(parent, 'logbook');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'));
  const files: Record<string, string> = {
    'README.md': '# Logbook\n\nA boat’s logbook: watches, positions and weather, in the browser.\n',
    'package.json': `${JSON.stringify({ name: 'logbook', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'index.html': '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Logbook</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <main id="log"></main>\n  <script type="module" src="src/logbook.js"></script>\n</body>\n</html>\n',
    'styles.css': ':root {\n  --paper: #fbf8f1;\n  --ink: #1d2733;\n}\n\nbody {\n  background: var(--paper);\n  color: var(--ink);\n  font: 16px/1.5 system-ui, sans-serif;\n}\n',
    'src/settings.js': "// Settings for the logbook: units and the vessel's name.\nexport const defaults = { units: 'nautical', vessel: 'Ruya' };\n\nexport function loadSettings(storage = localStorage) {\n  const saved = JSON.parse(storage.getItem('settings') ?? '{}');\n  return { ...defaults, ...saved };\n}\n\nexport function saveSettings(settings, storage = localStorage) {\n  storage.setItem('settings', JSON.stringify(settings));\n}\n",
    'src/logbook.js': "import { loadSettings } from './settings.js';\n\nconst settings = loadSettings();\ndocument.title = `${settings.vessel} · Logbook`;\n",
    'test/settings.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { loadSettings, saveSettings } from '../src/settings.js';\n\nfunction memory() {\n  const data = {};\n  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };\n}\n\ntest('starts with nautical units', () => {\n  assert.equal(loadSettings(memory()).units, 'nautical');\n});\n\ntest('remembers what was saved', () => {\n  const storage = memory();\n  saveSettings({ units: 'metric' }, storage);\n  assert.equal(loadSettings(storage).units, 'metric');\n});\n",
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'Start the logbook');
  return dir;
}

// Headless Chromium draws no pointer, so the page gets one, and a ring where it clicks. The panel
// sizes leave the terminal room for a credential on one line.
const PAGE_SETUP = `
try {
  localStorage.setItem('lonca.size.sidebar', '220');
  localStorage.setItem('lonca.size.right', '450');
} catch {}
addEventListener('DOMContentLoaded', () => {
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.5 L14.4 20.3 L11.3 13.7 L17.5 13.7 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(cursor.style, { position: 'fixed', left: '640px', top: '520px', zIndex: '2147483647', pointerEvents: 'none', transition: 'left .55s ease, top .55s ease', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' });
  document.body.appendChild(cursor);
  window.demoRipple = (x, y) => {
    const ring = document.createElement('div');
    Object.assign(ring.style, { position: 'fixed', left: (x - 14) + 'px', top: (y - 14) + 'px', width: '28px', height: '28px', borderRadius: '50%', border: '2px solid rgba(59,130,246,.85)', zIndex: '2147483646', pointerEvents: 'none', transition: 'transform .4s ease, opacity .4s ease' });
    document.body.appendChild(ring);
    requestAnimationFrame(() => { ring.style.transform = 'scale(1.7)'; ring.style.opacity = '0'; });
    setTimeout(() => ring.remove(), 450);
  };
});
`;

async function pointAt(page: Page, target: Locator): Promise<{ x: number; y: number }> {
  await target.waitFor({ state: 'visible', timeout: 120000 });
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 40);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 8 });
  await page.evaluate(`(() => {
    const cursor = document.getElementById('demo-cursor');
    if (cursor) { cursor.style.left = '${x - 4}px'; cursor.style.top = '${y - 2}px'; }
  })()`);
  await sleep(700);
  return { x, y };
}

async function click(page: Page, target: Locator): Promise<void> {
  const { x, y } = await pointAt(page, target);
  await page.evaluate(`window.demoRipple?.(${x}, ${y})`);
  await target.click();
  await sleep(300);
}

/** Screenshots as fast as Chromium takes them, until the scene's over. */
async function capture(page: Page): Promise<void> {
  let n = 0;
  while (capturing) {
    const t = Date.now() - t0;
    try {
      const png = await page.screenshot({ type: 'png', animations: 'allow', caret: 'initial' });
      const file = `${String(++n).padStart(5, '0')}.png`;
      fs.writeFileSync(path.join(FRAMES, file), png);
      timeline.push({ file, t, scene, speed });
    } catch (error) {
      console.log('screenshot failed:', String(error).slice(0, 120));
      await sleep(100);
    }
  }
}

function saveTimeline(): void {
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ view: VIEW, frames: timeline }, null, 1));
}

// Only what a recording makes is cleared, so a Python environment kept here for make-gif.py stays.
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
const director = await startDirector(43117, path.join(OUT, 'director.log'));
const repo = makeLogbook();
const lonca = new Lonca({ port: 47941, instance: 'demo', firstWorkspacePort: 47950 });
const browser = await chromium.launch();
let recorder: Promise<void> | undefined;
try {
  // The credential diagram, laid over the terminal scene by make-gif.py.
  const card = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
  await card.goto(`file://${path.join(import.meta.dirname, 'proxy-card.html')}`);
  await card.evaluate('document.fonts.ready');
  await card.screenshot({ path: path.join(OUT, 'overlay-proxy.png'), omitBackground: true });
  await card.close();

  await lonca.start();
  // Lonca names the computer after the git user when it starts, so a made-up one needs a restart.
  await lonca.api('PATCH', '/settings', { gitName: 'Sam', gitEmail: 'sam@example.com', branchPrefix: 'sam' });
  await lonca.stop();
  await lonca.start();
  await until('sign-in status', async () => (await lonca.api('GET', '/state')).system.agentsChecked, 180000, 1000);
  // Made-up credentials: the VM only ever sees placeholders for them, which is what the terminal shows.
  await lonca.api('PUT', '/profiles/claude/key', { key: 'sk-ant-oat01-demo-not-a-real-token' });
  await lonca.api('PUT', '/secrets/github', { token: 'gho_demo_not_a_real_token' });
  await lonca.api('PUT', '/profiles/codex/key', { key: 'sk-demo-key-that-is-not-a-real-one' });
  const project = await lonca.waitForProject((await lonca.api('POST', '/projects', { path: repo })).id);
  await lonca.api('PATCH', `/projects/${project.id}`, { settings: { network: 'host', env: { ANTHROPIC_BASE_URL: `http://host.docker.internal:${director.port}` } } });
  await until('the workspace template', async () => (await lonca.api('GET', '/state')).system.image?.state === 'ready', 20 * 60 * 1000, 3000);

  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
  await context.addInitScript(PAGE_SETUP);
  const page = await context.newPage();
  await page.goto(`${lonca.url}/?token=${lonca.token}`);
  await page.getByRole('button', { name: 'New workspace in logbook' }).waitFor({ state: 'attached' });
  await sleep(1500);

  capturing = true;
  recorder = capture(page);
  mark('create');
  await sleep(1200);
  await click(page, page.getByRole('button', { name: 'New workspace in logbook' }));
  await page.waitForURL(/\/w\//);
  const workspaceId = /\/w\/([^/?]+)/.exec(page.url())![1];
  mark('create', 2.5);
  const workspace = await lonca.waitForWorkspace(workspaceId);
  setWorkspaceRoot(workspace.path);
  // Codex takes its model from config.toml, so this points it at the director. Lonca doesn't rewrite it.
  void sandboxExecAsync(workspace.sandboxName, `cat > ~/.codex/config.toml <<EOF
cli_auth_credentials_store = "file"
model_provider = "demo"
[model_providers.demo]
name = "demo"
base_url = "http://host.docker.internal:${director.port}/v1"
wire_api = "responses"
supports_websockets = false
EOF`);
  mark('create');
  await sleep(1500);

  mark('ask');
  await click(page, page.getByRole('textbox', { name: 'Message' }));
  await page.keyboard.type(USER_ASK, { delay: 26 });
  await sleep(700);
  await page.keyboard.press('Enter');

  mark('spawn', 2.5);
  const tab = (label: string) => page.locator('.team-tab:not(.lead-tab)').filter({ hasText: label });
  await tab('Build').waitFor({ state: 'visible', timeout: 180000 });
  mark('spawn');
  await sleep(2000);

  const sessionOf = async (title: string) => (await lonca.api('GET', '/state')).sessions.find((session: { workspaceId: string; title: string }) => session.workspaceId === workspaceId && session.title === title);
  const finished = (title: string) => until(`${title} to finish`, async () => {
    const session = await sessionOf(title);
    return session?.status === 'idle' && session.lastOutcome === 'completed';
  }, 300000, 500);

  mark('build');
  await click(page, tab('Build').getByRole('button').first());
  mark('build', 3);
  await finished('Build');
  mark('build');
  await sleep(2000);

  mark('review');
  await click(page, page.locator('.lead-tab .tab-label'));
  mark('review', 3);
  await tab('Review').waitFor({ state: 'visible', timeout: 180000 });
  mark('review');
  await sleep(2000);
  await click(page, tab('Review').getByRole('button').first());
  mark('review', 3);
  await finished('Review');
  mark('review');
  await sleep(2500);

  mark('fix');
  await click(page, page.locator('.lead-tab .tab-label'));
  mark('fix', 4);
  await until('the Lead to finish', async () => {
    const lead = (await lonca.api('GET', '/state')).sessions.find((session: { workspaceId: string; role: string }) => session.workspaceId === workspaceId && session.role === 'lead');
    const said = JSON.stringify(await lonca.items(lead.id));
    return said.includes('ready for a pull request') && lead.status === 'idle' && lead.queue.length === 0;
  }, 300000, 500);
  mark('fix');
  await sleep(3500);

  mark('terminal');
  await click(page, page.locator('.xterm').first());
  await page.keyboard.type('env | grep TOKEN', { delay: 70 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(3000);
  mark('proxy');
  await sleep(6000);

  mark('changes');
  await click(page, page.getByRole('tab', { name: /Changes/ }));
  await sleep(1200);
  await click(page, page.locator('.change-row').filter({ hasText: 'settings.js' }).first());
  await sleep(3500);
  capturing = false;
  await recorder;
  saveTimeline();
  console.log(`${timeline.length} frames in ${OUT}`);
} catch (error) {
  console.error(error);
  capturing = false;
  await recorder?.catch(() => {});
  saveTimeline();
  fs.writeFileSync(path.join(OUT, 'server.log'), lonca.log);
  process.exitCode = 1;
} finally {
  await browser.close();
  await lonca.destroy().catch((error) => console.error('cleanup:', error));
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  await director.close();
}
