// Imported only by integration-test servers. Faults affect launch acknowledgments and followers,
// never Docker Sandboxes or the detached agent process being followed.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Transform } from 'node:stream';

const control = path.join(process.env.LONCA_HOME, 'output-fault.json');
const log = path.join(process.env.LONCA_HOME, 'output-faults.jsonl');
function fault() {
  try { return JSON.parse(fs.readFileSync(control, 'utf8')); } catch { return null; }
}
function record(config, offset) {
  fs.appendFileSync(log, `${JSON.stringify({ kind: config.kind, offset })}\n`);
  if (config.once) fs.rmSync(control, { force: true });
}
function filterOutput(config, offset) {
  let recorded = false;
  return (type, data) => {
    let changed = false;
    if (config?.kind === 'no-output' && type === 1 || config?.kind === 'no-receipt' && type === 2) {
      data = Buffer.alloc(0);
      changed = true;
    } else if (config?.kind === 'wrong-length' && type === 2 && /"end": (\d+)/.test(data.toString())) {
      data = Buffer.from(data.toString().replace(/"end": (\d+)/, (_, end) => `"end": ${Number(end) + 1}`));
      changed = true;
    }
    if (changed && !recorded) { record(config, offset); recorded = true; }
    return data;
  };
}

const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (args?.includes('lonca-run') && fault()?.kind === 'launch-before') {
    record(fault(), 0);
    return spawn.call(this, process.execPath, ['-e', 'process.exit(125)'], options);
  }
  if (args?.includes('lonca-run') && fault()?.kind === 'launch') {
    const config = fault();
    const child = spawn.call(this, file, args, options);
    const emit = child.emit;
    child.emit = function (event, ...values) {
      if (event !== 'close') return emit.call(this, event, ...values);
      setTimeout(() => { record(config, 0); emit.call(this, 'close', 125, null); }, 1000);
      return true;
    };
    return child;
  }
  if (!args?.includes('follow')) return spawn.call(this, file, args, options);
  const offset = Number(args.at(-1));
  const config = fault();
  if (config?.kind === 'attach') {
    record(config, offset);
    return spawn.call(this, process.execPath, ['-e', 'process.exit(125)'], options);
  }
  const child = spawn.call(this, file, args, options);
  child.stdout.on('data', () => {
    const current = fault();
    if (current?.kind === 'cut') {
      record(current, offset);
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
    }
  });
  const filter = filterOutput(config, offset);
  for (const [name, type] of [['stdout', 1], ['stderr', 2]]) {
    child[name] = child[name].pipe(new Transform({
      transform(chunk, _encoding, done) { done(null, filter(type, chunk)); },
    }));
  }
  return child;
};
syncBuiltinESMExports();
