const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fromCounts, assess, classify, estimateJob } = require('../app/health.cjs');
const { catalog, codes } = require('../app/i18n.cjs');

test('all seven languages have complete entries', () => {
  assert.equal(codes.length, 7);
  for (const [key, values] of Object.entries(catalog)) {
    assert.equal(values.length, codes.length, key);
    assert.ok(values.every(x => typeof x === 'string' && x.trim()), key);
  }
});
test('exact user error is classified without pretending to know hardware cause', () => {
  const diagnosis = classify(new Error('RangeError: Array buffer allocation failed\n at gatherSogLayers (cli.mjs:41448:20)'));
  assert.equal(diagnosis.code, 'memory');
  assert.equal(diagnosis.detail, 'memoryDetail');
  assert.equal(classify(new Error('ENOSPC')).code, 'disk');
  assert.equal(classify(new Error('GPU device lost: out of memory')).code, 'gpu');
  assert.equal(classify(new Error('new unexpected error')).code, 'unknown');
});
test('warn according to headroom, not file size or CPU utilization', () => {
  const estimate = fromCounts(34900000, 3, 4);
  assert.equal(estimate.baseBytes, 8236400000);
  const enough = { sampled: Date.now(), totalMemory: 64e9, availableMemory: 50e9, commitAvailable: 60e9, cpu: 100, gpus: [] };
  assert.deepEqual(assess(estimate, enough, 'cpu'), []);
  assert.ok(assess(estimate, { ...enough, availableMemory: 4e9 }, 'cpu').includes('ram'));
  assert.ok(assess(estimate, { ...enough, commitAvailable: 0 }, 'cpu').includes('commit'));
  assert.deepEqual(assess(estimate, { sampled: Date.now(), availableMemory: null }, 'auto'), []);
  assert.deepEqual(assess(estimate, { ...enough, availableMemory: 1, sampled: Date.now() - 20000 }, 'cpu'), []);
  assert.deepEqual(assess(estimate, { ...enough, unified: true, gpus: [{ memoryTotal: 1, memoryUsed: 1 }] }, 'auto'), []);
});
test('estimate honors SH and reduction stages with bounded metadata reads', async () => {
  const base = path.resolve(__dirname, '../.cache'); await fs.mkdir(base, { recursive: true });
  const folder = await fs.mkdtemp(path.join(base, 'metadata-'));
  try {
    const file = path.join(folder, 'large.ply');
    await fs.writeFile(file, 'ply\nformat binary_little_endian 1.0\nelement vertex 34900000\n' + Array.from({ length: 45 }, (_, i) => 'property float f_rest_' + i).join('\n') + '\nend_header\n');
    const request = { format: 'sog', inputs: [{ path: file, ops: [] }], ops: [], settings: { keep: 100, workers: 4 } };
    const full = await estimateJob(request); assert.equal(full.bands, 3);
    request.ops = [{ type: 'harmonics', values: [1] }];
    assert.ok((await estimateJob(request)).baseBytes < full.baseBytes);
    request.settings.keep = 50;
    assert.ok((await estimateJob(request)).reductionBytes > 0);
    request.format = 'ply'; request.settings.keep = 100;
    assert.equal(await estimateJob(request), null);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
