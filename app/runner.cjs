const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');

const FORMATS = {
  sog: { name: 'SOG / SuperSplat 优化包', suffix: '.sog', compressed: true },
  ply: { name: 'PLY / 标准格式', suffix: '.ply' },
  compressed: { name: '压缩 PLY', suffix: '.compressed.ply' },
  csv: { name: 'CSV / 表格数据', suffix: '.csv' },
  html: { name: 'HTML / 内嵌查看器', suffix: '.html', compressed: true },
  voxel: { name: '体素 ZIP / 碰撞数据', suffix: '.voxel.zip' }
};
const OPERATIONS = {
  translate: { name: '平移', flag: '--translate', fields: ['X', 'Y', 'Z'], defaults: [0, 0, 0] },
  rotate: { name: '旋转（度）', flag: '--rotate', fields: ['X', 'Y', 'Z'], defaults: [0, 0, 0] },
  scale: { name: '等比缩放', flag: '--scale', fields: ['倍率'], defaults: [1] },
  nan: { name: '移除无效点', flag: '--filter-nan', fields: [], defaults: [] },
  harmonics: { name: '球谐阶数上限', flag: '--filter-harmonics', fields: ['阶数'], defaults: [3] },
  box: { name: '包围盒筛选', flag: '--filter-box', fields: ['最小 X', '最小 Y', '最小 Z', '最大 X', '最大 Y', '最大 Z'], defaults: [-10, -10, -10, 10, 10, 10] },
  sphere: { name: '球形范围筛选', flag: '--filter-sphere', fields: ['中心 X', '中心 Y', '中心 Z', '半径'], defaults: [0, 0, 0, 10] }
};
function operations(ops) {
  if (!Array.isArray(ops) || ops.length > 100) throw new Error('操作数量无效');
  return ops.flatMap(op => {
    const spec = OPERATIONS[op?.type];
    if (!spec || !Array.isArray(op.values) || op.values.length !== spec.defaults.length || op.values.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('操作参数无效');
    const values = op.values;
    if ((op.type === 'scale' || op.type === 'sphere') && values.at(-1) <= 0) throw new Error('倍率或半径必须大于零');
    if (op.type === 'harmonics' && (!Number.isInteger(values[0]) || values[0] < 0 || values[0] > 3)) throw new Error('球谐阶数必须在 0 到 3 之间');
    if (op.type === 'box' && values.slice(0, 3).some((v, i) => v > values[i + 3])) throw new Error('包围盒最小值大于最大值');
    return values.length ? [spec.flag, values.join(',')] : [spec.flag];
  });
}
function integer(value, min, max, fallback) {
  const v = value === undefined ? fallback : value;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error('滑块参数超出范围');
  return v;
}
function normalize(request) {
  if (!request || !FORMATS[request.format]) throw new Error('输出格式无效');
  if (!Array.isArray(request.inputs) || !request.inputs.length || request.inputs.length > 1000) throw new Error('请选择源文件');
  const inputs = request.inputs.map(input => {
    if (!input || typeof input.path !== 'string' || !path.isAbsolute(input.path) || !/\.(ply|sog|ksplat|splat|spz)$/i.test(input.path)) throw new Error('源文件格式无效');
    return { path: input.path, args: operations(input.ops || []) };
  });
  const fmt = FORMATS[request.format];
  if (typeof request.output !== 'string' || !path.isAbsolute(request.output) || !request.output.toLowerCase().endsWith(fmt.suffix)) throw new Error('输出路径或扩展名无效');
  const settings = request.settings || {};
  const device = settings.device || 'auto';
  if (!['auto', 'cpu', 'metal'].includes(device) || (request.format === 'voxel' && device === 'cpu')) throw new Error('计算设备不支持此输出');
  const voxel = Number(settings.voxel ?? 0.05), opacity = Number(settings.opacity ?? 0.1);
  if (!Number.isFinite(voxel) || voxel <= 0 || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('体素参数无效');
  return { inputs, output: path.resolve(request.output), format: request.format, fmt, ops: operations(request.ops || []),
    overwrite: request.overwrite === true, keep: integer(settings.keep, 1, 100, 100),
    iterations: integer(settings.iterations, 1, 100, 10), effort: integer(settings.effort, -1, 9, -1),
    workers: integer(settings.workers, 0, 16, 4), device, voxel, opacity };
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
function processRun(runtime, args, signal, log) {
  signal?.throwIfAborted();
  const environment = { ...process.env, NO_COLOR: '1' };
  delete environment.NODE_OPTIONS; delete environment.NODE_PATH; delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'),
      [path.join(runtime, 'node_modules/@playcanvas/splat-transform/bin/cli.mjs'), ...args],
      { cwd: runtime, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const readers = [child.stdout, child.stderr].map(stream => readline.createInterface({ input: stream }));
    readers.forEach(reader => reader.on('line', line => { tail.push(line); if (tail.length > 6) tail.shift(); log(line); }));
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', reject);
    child.once('close', code => {
      signal?.removeEventListener('abort', cancel); readers.forEach(r => r.close());
      if (signal?.aborted) reject(new Error('已取消'));
      else if (code !== 0) reject(new Error('引擎转换失败：\n' + tail.join('\n')));
      else resolve();
    });
  });
}
async function convert(request, runtime, { signal, status = () => {}, log = () => {} } = {}) {
  const job = normalize(request);
  signal?.throwIfAborted();
  const canonical = await Promise.all(job.inputs.map(i => fsp.realpath(i.path)));
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  let existing;
  try { existing = await fsp.realpath(job.output); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (canonical.some(p => same(p, existing || job.output))) throw new Error('不能覆盖源文件，请另选输出文件名');
  if (existing && !job.overwrite) throw new Error('输出已存在');
  const staging = await fsp.mkdtemp(path.join(path.dirname(job.output), '.splat-convert-'));
  try {
    const output = path.join(staging, path.basename(job.output));
    const engineOutput = job.format === 'voxel' ? output.replace(/\.zip$/i, '.json') : output;
    const reduce = job.keep < 100, separate = reduce && job.format !== 'ply';
    const reduced = path.join(staging, 'reduced.ply');
    const args = job.inputs.flatMap(i => [i.path, ...i.args]);
    args.push(separate ? reduced : engineOutput, ...job.ops);
    if (reduce) args.push('--decimate', job.keep + '%', '--scratch-dir', staging);
    status(separate ? '阶段 1 / 2：精简高斯点…' : '正在转换…');
    await processRun(runtime, engineArgs(job, args, reduce), signal, log);
    if (separate) {
      status('阶段 2 / 2：编码输出…');
      await processRun(runtime, engineArgs(job, [reduced, engineOutput]), signal, log);
    }
    if (job.format === 'voxel') {
      signal?.throwIfAborted(); status('正在打包体素…');
      const zip = new yazl.ZipFile();
      const done = pipeline(zip.outputStream, fs.createWriteStream(output), { signal });
      for (const file of [engineOutput, engineOutput.replace(/\.json$/i, '.bin')]) zip.addFile(file, path.basename(file));
      zip.end(); await done;
    }
    signal?.throwIfAborted();
    const stat = await fsp.stat(output);
    if (stat.size === 0) throw new Error('未生成有效输出');
    if (job.overwrite) await fsp.rename(output, job.output);
    else { await fsp.link(output, job.output); await fsp.unlink(output); }
    return { output: job.output, size: stat.size };
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}
module.exports = { FORMATS, OPERATIONS, normalize, engineArgs, convert };
