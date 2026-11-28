const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const { DEFAULT_LANG, translate } = require('./i18n.cjs');

const FORMATS = {
  sog: { labelKey: 'app.formats.sog', suffix: '.sog', compressed: true },
  ply: { labelKey: 'app.formats.ply', suffix: '.ply' },
  compressed: { labelKey: 'app.formats.compressed', suffix: '.compressed.ply' },
  csv: { labelKey: 'app.formats.csv', suffix: '.csv' },
  html: { labelKey: 'app.formats.html', suffix: '.html', compressed: true },
  voxel: { labelKey: 'app.formats.voxel', suffix: '.voxel.zip' }
};
const OPERATIONS = {
  translate: { labelKey: 'app.ops.translate', flag: '--translate', fields: ['X', 'Y', 'Z'], defaults: [0, 0, 0] },
  rotate: { labelKey: 'app.ops.rotate', flag: '--rotate', fields: ['X', 'Y', 'Z'], defaults: [0, 0, 0] },
  scale: { labelKey: 'app.ops.scale', flag: '--scale', fields: ['factor'], defaults: [1] },
  nan: { labelKey: 'app.ops.nan', flag: '--filter-nan', fields: [], defaults: [] },
  harmonics: { labelKey: 'app.ops.harmonics', flag: '--filter-harmonics', fields: ['band'], defaults: [3] },
  box: { labelKey: 'app.ops.box', flag: '--filter-box', fields: ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'], defaults: [-10, -10, -10, 10, 10, 10] },
  sphere: { labelKey: 'app.ops.sphere', flag: '--filter-sphere', fields: ['X', 'Y', 'Z', 'radius'], defaults: [0, 0, 0, 10] }
};

function operations(ops, lang = DEFAULT_LANG) {
  if (!Array.isArray(ops) || ops.length > 100) throw new Error(translate(lang, 'app.electron.invalidOpCount'));
  return ops.flatMap(op => {
    const spec = OPERATIONS[op?.type];
    if (!spec || !Array.isArray(op.values) || op.values.length !== spec.defaults.length || op.values.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(translate(lang, 'app.electron.invalidOpParams'));
    const values = op.values;
    if ((op.type === 'scale' || op.type === 'sphere') && values.at(-1) <= 0) throw new Error(translate(lang, 'app.electron.positiveScaleRadius'));
    if (op.type === 'harmonics' && (!Number.isInteger(values[0]) || values[0] < 0 || values[0] > 3)) throw new Error(translate(lang, 'app.electron.shRange03'));
    if (op.type === 'box' && values.slice(0, 3).some((v, i) => v > values[i + 3])) throw new Error(translate(lang, 'app.electron.invalidBoxRange'));
    return values.length ? [spec.flag, values.join(',')] : [spec.flag];
  });
}
function integer(value, min, max, fallback, lang = DEFAULT_LANG) {
  const v = value === undefined ? fallback : value;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(translate(lang, 'app.electron.sliderOutOfRange'));
  return v;
}
function normalize(request, lang = DEFAULT_LANG) {
  if (!request || !FORMATS[request.format]) throw new Error(translate(lang, 'app.electron.invalidOutputFormat'));
  if (!Array.isArray(request.inputs) || !request.inputs.length || request.inputs.length > 1000) throw new Error(translate(lang, 'app.electron.selectInputs'));
  const inputs = request.inputs.map(input => {
    if (!input || typeof input.path !== 'string' || !path.isAbsolute(input.path) || !/\.(ply|sog|ksplat|splat|spz)$/i.test(input.path)) throw new Error(translate(lang, 'app.electron.invalidInputFormat'));
    return { path: input.path, args: operations(input.ops || [], lang) };
  });
  const fmt = FORMATS[request.format];
  if (typeof request.output !== 'string' || !path.isAbsolute(request.output) || !request.output.toLowerCase().endsWith(fmt.suffix)) throw new Error(translate(lang, 'app.electron.invalidOutputPath'));
  const settings = request.settings || {};
  const device = settings.device || 'auto';
  if (!['auto', 'cpu', 'metal'].includes(device) || (request.format === 'voxel' && device === 'cpu')) throw new Error(translate(lang, 'app.electron.deviceUnsupported'));
  const voxel = Number(settings.voxel ?? 0.05), opacity = Number(settings.opacity ?? 0.1);
  if (!Number.isFinite(voxel) || voxel <= 0 || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error(translate(lang, 'app.electron.invalidVoxelParams'));
  return { inputs, output: path.resolve(request.output), format: request.format, fmt, ops: operations(request.ops || [], lang),
    overwrite: request.overwrite === true, keep: integer(settings.keep, 1, 100, 100, lang),
    iterations: integer(settings.iterations, 1, 100, 10, lang), effort: integer(settings.effort, -1, 9, -1, lang),
    workers: integer(settings.workers, 0, 16, 4, lang), device, voxel, opacity };
}
function engineArgs(job, args, reducing = false) {
  const all = ['--no-tty', '--memory', '--max-workers', String(job.workers)];
  if (job.device === 'cpu' || (reducing && job.format === 'voxel')) all.push('--gpu', 'cpu');
  else if (job.device === 'metal') all.push('--gpu-backend', 'metal');
  if (job.fmt.compressed) {
    all.push('--sh-iterations', String(job.iterations));
    if (job.effort >= 0) all.push('--webp-effort', String(job.effort));
  }
  if (job.format === 'voxel') all.push('--voxel-size', String(job.voxel), '--voxel-opacity', String(job.opacity));
  return [...all, ...args];
}
function processRun(runtime, args, signal, log, lang = DEFAULT_LANG) {
  signal?.throwIfAborted();
  const environment = { ...process.env, NO_COLOR: '1' };
  delete environment.NODE_OPTIONS; delete environment.NODE_PATH; delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'),
      [path.join(runtime, 'node_modules/@playcanvas/splat-transform/bin/cli.mjs'), ...args],
      { cwd: runtime, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const readers = [child.stdout, child.stderr].map(stream => readline.createInterface({ input: stream }));
    readers.forEach(reader => reader.on('line', line => { tail.push(line); if (tail.length > 80) tail.shift(); log(line); }));
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', reject);
    child.once('close', code => {
      signal?.removeEventListener('abort', cancel); readers.forEach(r => r.close());
      if (signal?.aborted) reject(new Error(translate(lang, 'app.status.canceled')));
      else if (code !== 0) reject(new Error(translate(lang, 'app.electron.engineFailed', { tail: tail.join('\n') })));
      else resolve();
    });
  });
}
async function convert(request, runtime, { signal, language = DEFAULT_LANG, status = () => {}, log = () => {} } = {}) {
  const job = normalize(request, language);
  signal?.throwIfAborted();
  const canonical = await Promise.all(job.inputs.map(i => fsp.realpath(i.path)));
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  let existing;
  try { existing = await fsp.realpath(job.output); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (canonical.some(p => same(p, existing || job.output))) throw new Error(translate(language, 'app.electron.cannotOverwriteSource'));
  if (existing && !job.overwrite) throw new Error(translate(language, 'app.electron.outputExists'));
  const staging = await fsp.mkdtemp(path.join(path.dirname(job.output), '.splat-convert-'));
  try {
    const output = path.join(staging, path.basename(job.output));
    const engineOutput = job.format === 'voxel' ? output.replace(/\.zip$/i, '.json') : output;
    const reduce = job.keep < 100, separate = reduce && job.format !== 'ply';
    const reduced = path.join(staging, 'reduced.ply');
    const args = job.inputs.flatMap(i => [i.path, ...i.args]);
    args.push(separate ? reduced : engineOutput, ...job.ops);
    if (reduce) args.push('--decimate', job.keep + '%', '--scratch-dir', staging);
    status(separate ? 'app.status.reducing' : 'app.status.converting');
    await processRun(runtime, engineArgs(job, args, reduce), signal, log, language);
    if (separate) {
      status('app.status.encoding');
      await processRun(runtime, engineArgs(job, [reduced, engineOutput]), signal, log, language);
    }
    if (job.format === 'voxel') {
      signal?.throwIfAborted(); status('app.status.packing');
      const zip = new yazl.ZipFile();
      const done = pipeline(zip.outputStream, fs.createWriteStream(output), { signal });
      for (const file of [engineOutput, engineOutput.replace(/\.json$/i, '.bin')]) zip.addFile(file, path.basename(file));
      zip.end(); await done;
    }
    signal?.throwIfAborted();
    const stat = await fsp.stat(output);
    if (stat.size === 0) throw new Error(translate(language, 'app.electron.emptyOutput'));
    if (job.overwrite) await fsp.rename(output, job.output);
    else { await fsp.link(output, job.output); await fsp.unlink(output); }
    return { output: job.output, size: stat.size };
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}
module.exports = { FORMATS, OPERATIONS, normalize, engineArgs, convert };
