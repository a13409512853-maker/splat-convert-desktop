const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const plist = require('plist');
async function inspect(file) {
  const files = new Map();
  await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('end', resolve); zip.on('error', reject);
    zip.on('entry', entry => {
      files.set(entry.fileName, { mode: entry.externalFileAttributes >>> 16, size: entry.uncompressedSize });
      const read = /Contents\/(Info.plist|MacOS\/Electron)$|Electron Helper[^/]*\.app\/Contents\/Info\.plist$|Resources\/engine\/node$|Resources\/app\/(main.cjs|node_modules\/yazl\/index.js)$/.test(entry.fileName);
      if (!read) return zip.readEntry();
      zip.openReadStream(entry, async (err, stream) => {
        if (err) return reject(err);
        try {
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          files.get(entry.fileName).data = Buffer.concat(chunks); zip.readEntry();
        } catch (e) { reject(e); }
      });
    }); zip.readEntry();
  }));
  const base = 'Splat Convert Desktop.app/Contents/';
  const info = plist.parse(files.get(base + 'Info.plist').data.toString());
  assert.equal(info.CFBundleIdentifier, 'io.github.a13409512853-maker.splat-convert-desktop');
  assert.equal(info.LSMinimumSystemVersion, '13.0');
  assert.ok(files.has(base + 'Resources/app/node_modules/yazl/index.js'));
  assert.ok(files.has(base + 'Resources/app/node_modules/buffer-crc32/dist/index.cjs'));
  assert.ok(files.has(base + 'Resources/engine/node_modules/webgpu/dist/darwin-universal/dawn.node'));
  assert.ok(files.has(base + '_CodeSignature/CodeResources'));
  assert.match(files.get(base + 'Resources/app/main.cjs').data.toString(), /https:\/\/github.com\/a13409512853-maker\/splat-convert-desktop/);
  for (const name of ['MacOS/Electron', 'Resources/engine/node', 'Frameworks/Electron Framework.framework/Versions/A/Helpers/app_shim_loader',
    'Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler', 'Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'])
    assert.ok(files.get(base + name).mode & 0o111, name + ' executable permission');
  for (const helper of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const p = base + 'Frameworks/Electron Helper' + helper + '.app/Contents/';
    const config = plist.parse(files.get(p + 'Info.plist').data.toString());
    assert.ok(files.has(p + 'MacOS/' + config.CFBundleExecutable));
  }
  assert.equal(files.get(base + 'Frameworks/Electron Framework.framework/Versions/Current').mode & 0o170000, 0o120000);
  const cpu = file.includes('arm64') ? 0x100000c : 0x1000007;
  for (const name of ['MacOS/Electron', 'Resources/engine/node']) {
    const binary = files.get(base + name).data;
    assert.equal(binary.readUInt32LE(0), 0xfeedfacf);
    assert.equal(binary.readUInt32LE(4), cpu);
    let cursor = 32, signature;
    for (let i = 0; i < binary.readUInt32LE(16); i++) {
      const command = binary.readUInt32LE(cursor), length = binary.readUInt32LE(cursor + 4);
      if (command === 0x1d) signature = binary.subarray(binary.readUInt32LE(cursor + 8), binary.readUInt32LE(cursor + 8) + binary.readUInt32LE(cursor + 12));
      cursor += length;
    }
    assert.ok(signature, name + ' code signature');
    assert.equal(signature.readUInt32BE(0), 0xfade0cc0);
    let entitlement;
    for (let i = 0; i < signature.readUInt32BE(8); i++) {
      const offset = signature.readUInt32BE(16 + i * 8);
      if (signature.readUInt32BE(offset) === 0xfade7171) entitlement = signature.subarray(offset + 8, offset + signature.readUInt32BE(offset + 4)).toString();
    }
    assert.ok(entitlement?.includes('com.apple.security.cs.allow-jit'), name + ' JIT entitlement');
  }
  console.log('PASS macOS bundle structure, ' + (cpu === 0x100000c ? 'arm64' : 'x64') + ' architecture, dependencies, executable permissions, links and signature resources');
}
inspect(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
