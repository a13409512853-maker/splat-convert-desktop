const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { claimPrompt } = require('../app/prompt.cjs');
const { normalize, engineArgs, FORMATS } = require('../app/runner.cjs');

const request = () => ({ format: 'sog', inputs: [{ path: path.resolve('test.ply'), ops: [] }], output: path.resolve('out.sog'), ops: [] });
test('star prompt is claimed once and remains claimed across module reloads', () => {
  const base = path.resolve(__dirname, '../.cache');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'splat-prompt-'));
  const marker = path.join(dir, 'nested', 'star-prompt-shown-v1');
  try {
    assert.equal(claimPrompt(marker), true);
    assert.equal(claimPrompt(marker), false);
    delete require.cache[require.resolve('../app/prompt.cjs')];
    assert.equal(require('../app/prompt.cjs').claimPrompt(marker), false);
    assert.ok(fs.readFileSync(marker, 'utf8').includes('T'));
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('all six original outputs are available', () => assert.equal(Object.keys(FORMATS).length, 6));
test('safe defaults preserve points and upstream settings', () => {
  const job = normalize(request());
  assert.equal(job.keep, 100); assert.equal(job.iterations, 10); assert.equal(job.workers, 4); assert.equal(job.effort, -1);
  assert.deepEqual(engineArgs(job, []).slice(-2), ['--sh-iterations', '10']);
});
test('reject invalid paths, arbitrary flags, numeric values and source types', () => {
  for (const mutate of [r => r.output = 'out.sog', r => r.inputs[0].path = path.resolve('untrusted.mjs'),
    r => r.settings = { keep: 0 }, r => r.settings = { effort: 10 },
    r => r.ops = [{ type: '--overwrite', values: [] }], r => r.ops = [{ type: 'scale', values: [-1] }],
    r => r.ops = [{ type: 'translate', values: [NaN, 0, 0] }],
    r => r.ops = [{ type: 'box', values: [1, 0, 0, 0, 1, 1] }]]) {
    const r = request(); mutate(r); assert.throws(() => normalize(r));
  }
});
test('ordered per-input and output actions, including negative values', () => {
  const r = request(); r.inputs[0].ops.push({ type: 'translate', values: [-1.5, 0, 0] });
  r.ops = [{ type: 'nan', values: [] }, { type: 'harmonics', values: [2] }];
  const job = normalize(r);
  assert.deepEqual(job.inputs[0].args, ['--translate', '-1.5,0,0']);
  assert.deepEqual(job.ops, ['--filter-nan', '--filter-harmonics', '2']);
});
test('voxel requires GPU and exposes physical thresholds', () => {
  const r = request(); r.format = 'voxel'; r.output = path.resolve('out.voxel.zip'); r.settings = { device: 'cpu' };
  assert.throws(() => normalize(r));
  r.settings = { device: 'metal', voxel: 0.02, opacity: 0.3 };
  const args = engineArgs(normalize(r), []);
  assert.ok(args.includes('metal')); assert.ok(args.includes('0.02')); assert.ok(args.includes('0.3'));
});
