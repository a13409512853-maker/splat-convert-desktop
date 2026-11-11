const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { convert } = require('../app/runner.cjs');
const { prepare, root } = require('../scripts/prepare.cjs');
async function main() {
  const runtime = await prepare(process.platform, process.arch);
  const folder = await fs.mkdtemp(path.join(root, '.cache', 'conversion-'));
  try {
    const ply = path.join(folder, '测试 样本.ply');
    const names = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
    const header = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 2048\n' + names.map(n => 'property float ' + n).join('\n') + '\nend_header\n');
    const data = Buffer.alloc(2048 * names.length * 4);
    for (let i = 0; i < 2048; i++) {
      const values = [(i % 32) * 0.03, Math.floor(i / 32) * 0.03, (i % 7) * 0.02, 0.1, 0.2, 0.3, 2, -3, -3, -3, 1, 0, 0, 0];
      values.forEach((n, j) => data.writeFloatLE(n, (i * names.length + j) * 4));
    }
    await fs.writeFile(ply, Buffer.concat([header, data]));
    const base = { inputs: [{ path: ply, ops: [{ type: 'translate', values: [-0.1, 0, 0] }] }], ops: [], settings: { device: 'cpu' } };
    for (const [format, suffix] of Object.entries({ sog: '.sog', ply: '.ply', compressed: '.compressed.ply', csv: '.csv', html: '.html' })) {
      const result = await convert({ ...base, format, output: path.join(folder, '输出' + suffix), settings: { device: 'cpu', keep: format === 'sog' ? 70 : 100 } }, runtime.directory);
      assert.ok(result.size > 0); console.log('PASS native conversion ' + format);
    }
    const protectedFile = path.join(folder, 'protected.sog'); await fs.writeFile(protectedFile, 'existing output');
    const cancel = new AbortController();
    await assert.rejects(convert({ ...base, format: 'sog', output: protectedFile, overwrite: true }, runtime.directory,
      { signal: cancel.signal, log: () => cancel.abort() }));
    assert.equal(await fs.readFile(protectedFile, 'utf8'), 'existing output');
    assert.equal((await fs.readdir(folder)).some(n => n.startsWith('.splat-convert-')), false);
    console.log('PASS cancellation preserves previous output and cleans staging');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
