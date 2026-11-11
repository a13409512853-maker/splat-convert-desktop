const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const yazl = require('yazl');
const yauzl = require('yauzl');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, '.cache');
const NODE = '22.23.2';
const ELECTRON = '45.3.0';

function response(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'splat-convert-desktop-build' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(response(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}: ${url}`)); }
      resolve(res);
    });
    req.setTimeout(120000, () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}
async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temporary = dest + '.part';
  for (let attempt = 0; ; attempt++) {
    try {
      console.log(`Download ${path.basename(dest)}`);
      await pipeline(await response(url), fs.createWriteStream(temporary));
      fs.renameSync(temporary, dest);
      return dest;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (attempt >= 2) throw error;
    }
  }
}
function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}
async function verifiedDownload(base, filename, sumsName, prefix = '') {
  const sums = await download(base + sumsName, path.join(cache, prefix + sumsName));
  const record = fs.readFileSync(sums, 'utf8').split(/\r?\n/).map(x => x.trim().split(/\s+/)).find(x => x[1]?.replace(/^\*/, '') === filename);
  if (!record || !/^[0-9a-f]{64}$/i.test(record[0])) throw new Error('Missing official checksum for ' + filename);
  const dest = await download(base + filename, path.join(cache, filename));
  if ((await digest(dest)) !== record[0].toLowerCase()) {
    fs.rmSync(dest, { force: true });
    throw new Error('Checksum mismatch: ' + filename);
  }
  return dest;
}
function entries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const result = [];
      zip.on('error', reject);
      zip.on('entry', entry => { result.push(entry); zip.readEntry(); });
      zip.on('end', () => resolve(result));
      zip.readEntry();
    });
  });
}
async function extractZip(file, directory) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        const output = path.resolve(directory, entry.fileName);
        if (!output.startsWith(path.resolve(directory) + path.sep)) { zip.close(); return reject(new Error('Unsafe ZIP path')); }
        if (entry.fileName.endsWith('/')) { fs.mkdirSync(output, { recursive: true }); zip.readEntry(); return; }
        fs.mkdirSync(path.dirname(output), { recursive: true });
        zip.openReadStream(entry, async (err, stream) => {
          if (err) return reject(err);
          try { await pipeline(stream, fs.createWriteStream(output)); zip.readEntry(); } catch (e) { reject(e); }
        });
      });
      zip.readEntry();
    });
  });
}
async function nodeRuntime(platform, arch) {
  const tag = platform === 'win32' ? 'win' : platform;
  const filename = `node-v${NODE}-${tag}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const file = await verifiedDownload(`https://nodejs.org/dist/v${NODE}/`, filename, 'SHASUMS256.txt', 'node-');
  const directory = path.join(cache, 'node-extracted-' + tag + '-' + arch);
  const runtime = path.join(directory, `node-v${NODE}-${tag}-${arch}`);
  if (!fs.existsSync(path.join(runtime, platform === 'win32' ? 'node.exe' : 'bin/node'))) {
    fs.mkdirSync(directory, { recursive: true });
    if (platform === 'win32') await extractZip(file, directory);
    else {
      const archiveRoot = `node-v${NODE}-${tag}-${arch}`;
      const result = spawnSync('tar', ['-xzf', file, '-C', directory, archiveRoot + '/bin/node', archiveRoot + '/LICENSE'], { stdio: 'inherit' });
      if (result.status !== 0) throw new Error('Could not extract Node runtime');
    }
  }
  return { node: path.join(runtime, platform === 'win32' ? 'node.exe' : 'bin/node'), license: path.join(runtime, 'LICENSE') };
}
function fileList(platform) {
  const list = [
    '@playcanvas/splat-transform/package.json', '@playcanvas/splat-transform/bin/cli.mjs',
    '@playcanvas/splat-transform/dist/cli.mjs', '@playcanvas/splat-transform/dist/worker.mjs',
    '@playcanvas/splat-transform/dist/spz-e5Ws0702.js', '@playcanvas/splat-transform/lib/webp.wasm',
    'webgpu/package.json', 'webgpu/index.js'
  ];
  if (platform === 'win32') list.push(...['dawn.node', 'dxcompiler.dll', 'd3dcompiler_47.dll'].map(n => `webgpu/dist/win32-x64/${n}`));
  else list.push('webgpu/dist/darwin-universal/dawn.node');
  return list;
}
async function notices(runtime) {
  const licensePaths = ['@playcanvas/splat-transform/LICENSE', 'playcanvas/LICENSE', '@adobe/spz/LICENSE', 'webgpu/LICENSE.md', 'yazl/LICENSE', 'buffer-crc32/LICENSE', 'lucide-static/LICENSE',
    'webgpu/dist/win32-x64/dxcompiler-LICENSE.TXT', 'webgpu/dist/win32-x64/dxcompiler-ThirdPartyNotices.txt'];
  const parts = [
    'Splat Convert Desktop - third-party notices',
    'Splat Transform 3.10.3 and bundled PlayCanvas engine: https://github.com/playcanvas/splat-transform',
    'Node.js ' + NODE, fs.readFileSync(runtime.license, 'utf8')
  ];
  for (const name of licensePaths) parts.push(name, fs.readFileSync(path.join(root, 'node_modules', name), 'utf8'));
  const libwebp = await download('https://raw.githubusercontent.com/webmproject/libwebp/v1.6.0/COPYING', path.join(cache, 'libwebp-COPYING'));
  parts.push('libwebp (upstream WebP codec)', fs.readFileSync(libwebp, 'utf8'));
  const dest = path.join(cache, 'THIRD-PARTY-LICENSES.txt');
  fs.writeFileSync(dest, parts.join('\n\n'));
  return dest;
}
async function prepare(platform, arch) {
  const runtime = await nodeRuntime(platform, arch);
  const license = await notices(runtime);
  const directory = path.join(cache, 'engine-' + platform + '-' + arch);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(runtime.node, path.join(directory, platform === 'win32' ? 'node.exe' : 'node'));
  for (const name of fileList(platform)) {
    const dest = path.join(directory, 'node_modules', name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, 'node_modules', name), dest);
  }
  fs.copyFileSync(license, path.join(directory, 'THIRD-PARTY-LICENSES.txt'));
  return { directory, license };
}
function tree(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name), source = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...tree(source, name));
    else result.push({ name, source });
  }
  return result;
}
async function zipFiles(files, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, fs.createWriteStream(output));
  for (const file of files) zip.addFile(file.source, file.name, { mode: file.mode || 0o100644 });
  zip.end();
  await done;
}
module.exports = { root, cache, NODE, ELECTRON, download, verifiedDownload, prepare, tree, zipFiles, entries, extractZip };
if (require.main === module) prepare(process.argv[2] || process.platform, process.argv[3] || process.arch).catch(e => { console.error(e); process.exitCode = 1; });
