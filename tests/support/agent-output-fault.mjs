// Imported only by integration-test servers. Faults affect launch acknowledgments and followers,
// never the Docker daemon or the detached agent process being followed.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Transform } from 'node:stream';
import Container from 'dockerode/lib/container.js';

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

const exec = Container.prototype.exec;
Container.prototype.exec = function (options, ...rest) {
  if (options.Cmd?.includes('lonca-run') && fault()?.kind === 'launch-before') {
    record(fault(), 0);
    return Promise.reject(new Error('Injected rejected launch'));
  }
  if (options.Cmd?.includes('lonca-run') && fault()?.kind === 'launch') {
    const config = fault();
    return exec.call(this, options, ...rest).then((execution) => {
      const inspect = execution.inspect;
      execution.inspect = async function (...args) {
        await inspect.apply(this, args);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        record(config, 0);
        throw Object.assign(new Error('Injected failed launch acknowledgment'), { code: 'ECONNRESET' });
      };
      return execution;
    });
  }
  if (!options.Cmd?.includes('follow')) return exec.call(this, options, ...rest);
  const offset = Number(options.Cmd.at(-1));
  const config = fault();
  if (config?.kind === 'attach') {
    record(config, offset);
    return Promise.reject(Object.assign(new Error('Injected output attachment failure'), { code: 'ECONNRESET' }));
  }
  return exec.call(this, options, ...rest).then((execution) => {
    const start = execution.start;
    execution.start = function (...args) {
      return start.apply(this, args).then((stream) => {
        stream.on('data', () => {
          const current = fault();
          if (current?.kind === 'cut') { record(current, offset); stream.destroy(); }
        });
        if (!['no-output', 'no-receipt', 'wrong-length'].includes(config?.kind)) return stream;
        const filter = filterOutput(config, offset);
        let pending = Buffer.alloc(0);
        const filtered = new Transform({
          transform(chunk, _encoding, done) {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 8 && pending.length >= 8 + pending.readUInt32BE(4)) {
              const size = pending.readUInt32BE(4);
              const header = Buffer.from(pending.subarray(0, 8));
              const data = filter(header[0], pending.subarray(8, 8 + size));
              pending = pending.subarray(8 + size);
              if (data.length) {
                header.writeUInt32BE(data.length, 4);
                this.push(header);
                this.push(data);
              }
            }
            done();
          },
        });
        stream.on('error', (error) => filtered.destroy(error));
        stream.on('close', () => { if (!stream.readableEnded) filtered.destroy(); });
        filtered.on('close', () => stream.destroy());
        return stream.pipe(filtered);
      });
    };
    return execution;
  });
};

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
