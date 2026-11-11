const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const yauzl = require('yauzl');
const exec = promisify(execFile);
const GiB = 2 ** 30;
let previous, gpuInfo, lastGpuRead = 0;
const capture = async (file, args) => (await exec(file, args, { timeout: 4000, maxBuffer: 1024 * 1024 })).stdout;
async function sampleResources() {
  const cpus = os.cpus();
  const total = cpus.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0);
  const idle = cpus.reduce((n, c) => n + c.times.idle, 0);
  const result = { sampled: Date.now(), totalMemory: os.totalmem(), availableMemory: os.freemem(), commitAvailable: null,
    cpu: previous && total > previous.total ? Math.max(0, Math.min(100, 100 * (1 - (idle - previous.idle) / (total - previous.total)))) : null,
    cpuName: cpus[0]?.model || '', gpus: [], unified: process.platform === 'darwin' && process.arch === 'arm64' };
  previous = { total, idle };
  if (process.platform === 'darwin') {
    try {
      const report = await capture('/usr/bin/memory_pressure', []);
      const free = report.match(/System-wide memory free percentage:\s*(\d+)%/i);
      // This includes reclaimable memory, unlike os.freemem(), which is too pessimistic on macOS.
      result.availableMemory = free ? result.totalMemory * Number(free[1]) / 100 : null;
    } catch { result.availableMemory = null; }
    if (Date.now() - lastGpuRead > 60000) {
      lastGpuRead = Date.now();
      try {
        const data = JSON.parse(await capture('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']));
        gpuInfo = (data.SPDisplaysDataType || []).map(g => ({ name: g.sppci_model || g._name || 'GPU', usage: null, memoryUsed: null, memoryTotal: null }));
      } catch { gpuInfo = []; }
    }
    result.gpus = gpuInfo || [];
  }
  return result;
}
function fromCounts(count, bands, workers) {
  const rest = [0, 9, 24, 45][bands];
  const baseBytes = count * (14 + rest) * 4;
  const shBytes = count * rest * 4;
  const resident = shBytes <= 2 * GiB ? shBytes : 2 * Math.min(128 * 2 ** 20, 4000000 * rest * 4);
  return { count, bands, baseBytes, lowBytes: baseBytes * 1.15 + count * 24 + 256 * 2 ** 20,
    highBytes: baseBytes * 1.65 + count * 64 + (256 + Math.min(workers, 8) * 64) * 2 ** 20,
    gpuBytes: bands ? resident + count * 12 + 64 * 2 ** 20 : 0 };
}
async function metadata(file) {
  if (/\.sog$/i.test(file)) return new Promise(resolve => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return resolve(null);
      let settled = false;
      const finish = value => { if (!settled) { settled = true; zip.close(); resolve(value); } };
      zip.on('error', () => finish(null)); zip.on('end', () => finish(null));
      zip.on('entry', entry => {
        if (entry.fileName !== 'meta.json') return zip.readEntry();
        if (entry.uncompressedSize > 2 ** 20) return finish(null);
        zip.openReadStream(entry, async (err, stream) => {
          if (err) return finish(null);
          try {
            const chunks = []; for await (const chunk of stream) chunks.push(chunk);
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const bands = data.shN?.bands || 0;
            finish(Number.isSafeInteger(data.count) && data.count > 0 && Number.isInteger(bands) && bands >= 0 && bands <= 3 ? { count: data.count, bands } : null);
          } catch { finish(null); }
        });
      }); zip.readEntry();
    });
  });
  let handle;
  try {
    handle = await fs.open(file, 'r');
    if (/\.splat$/i.test(file)) { const stat = await handle.stat(); return stat.size % 32 ? null : { count: stat.size / 32, bands: 0 }; }
    if (!/\.ply$/i.test(file)) return null;
    const buffer = Buffer.alloc(2 ** 20), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('ascii', 0, bytesRead), end = text.indexOf('end_header');
    if (!text.startsWith('ply\n') && !text.startsWith('ply\r\n') || end < 0) return null;
    const header = text.slice(0, end);
    if (/packed_position/.test(header)) return null;
    const count = Number(header.match(/element vertex (\d+)/)?.[1]);
    const rest = [...header.matchAll(/property float f_rest_\d+/g)].length;
    return Number.isSafeInteger(count) && count > 0 ? { count, bands: rest >= 45 ? 3 : rest >= 24 ? 2 : rest >= 9 ? 1 : 0 } : null;
  } catch { return null; } finally { await handle?.close(); }
}
async function estimateJob(request) {
  const settings = request.settings || {};
  if (!['sog', 'html'].includes(request.format) && (settings.keep ?? 100) === 100) return null;
  let count = 0, bands = 0, reduction = 0, upperBound = false;
  for (const input of request.inputs) {
    const data = await metadata(input.path); if (!data) return null;
    let sh = data.bands;
    for (const op of input.ops || []) {
      if (op.type === 'harmonics') sh = Math.min(sh, op.values[0]);
      else if (['box', 'sphere', 'nan'].includes(op.type)) upperBound = true;
    }
    count += data.count; bands = Math.max(sh, bands);
    reduction += data.count * (14 + [0, 9, 24, 45][sh]) * 8;
  }
  for (const op of request.ops || []) {
    if (op.type === 'harmonics') bands = Math.min(bands, op.values[0]);
    else if (['box', 'sphere', 'nan'].includes(op.type)) upperBound = true;
  }
  const estimate = fromCounts(Math.max(1, Math.round(count * (settings.keep ?? 100) / 100)), bands, settings.workers ?? 4);
  estimate.upperBound = upperBound;
  if (settings.keep < 100) {
    estimate.reductionBytes = reduction;
    estimate.lowBytes = Math.max(estimate.lowBytes, reduction + 256 * 2 ** 20);
    estimate.highBytes = Math.max(estimate.highBytes, reduction * 1.5 + 512 * 2 ** 20);
  }
  return estimate;
}
function assess(estimate, resources, device) {
  if (!estimate || !resources || Date.now() - resources.sampled > 15000) return [];
  const risks = [];
  if (resources.totalMemory > 0 && Number.isFinite(resources.availableMemory) && estimate.highBytes > resources.availableMemory * 0.88) risks.push('ram');
  if (Number.isFinite(resources.commitAvailable) && resources.commitAvailable >= 0 && estimate.lowBytes > resources.commitAvailable * 0.9) risks.push('commit');
  if (device !== 'cpu' && !resources.unified && estimate.gpuBytes && resources.gpus?.length && resources.gpus.every(g => g.memoryTotal > 0 && Number.isFinite(g.memoryUsed) && estimate.gpuBytes > (g.memoryTotal - g.memoryUsed) * 0.9)) risks.push('vram');
  return risks;
}
function classify(error) {
  const text = String(error?.stack || error).toLowerCase();
  if (/enospc|disk full|not enough space/.test(text)) return { code: 'disk', title: 'diskTitle', advice: 'diskAdvice' };
  if (/gpu.*(out.of.memory|oom)|out.of.memory.*gpu|device.lost|no gpu adapter|webgpu|d3d12|vulkan|gpu device|maxstoragebufferbindingsize/.test(text)) return { code: 'gpu', title: 'gpuTitle', advice: 'gpuAdvice' };
  if (/array buffer allocation failed|invalid array length|heap out of memory|allocation failed|bad_alloc|cannot allocate memory|enomem/.test(text)) return { code: 'memory', title: 'memoryTitle', detail: 'memoryDetail', advice: 'memoryAdvice' };
  if (/eacces|eperm|permission denied|access.*denied|sharing violation/.test(text)) return { code: 'access', title: 'accessTitle', advice: 'accessAdvice' };
  if (/no gaussians|no points|zero gaussians|remove every gaussian|after filtering/.test(text)) return { code: 'empty', title: 'emptyTitle', advice: 'emptyAdvice' };
  if (/enoent|invalid.*(ply|header|file)|missing.*(property|column)|unexpected end|unsupported.*format/.test(text)) return { code: 'input', title: 'inputTitle', advice: 'inputAdvice' };
  return { code: 'unknown', title: 'failed', advice: 'unknownAdvice' };
}
module.exports = { sampleResources, estimateJob, metadata, fromCounts, assess, classify, GiB };
