const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { root, cache, download, tree } = require('./prepare.cjs');

async function extractBundle(archive, directory) {
  const links = [];
  const modes = new Map();
  await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on('end', resolve); zip.on('error', reject);
      zip.on('entry', entry => {
        const dest = path.resolve(directory, entry.fileName);
        if (!dest.startsWith(path.resolve(directory) + path.sep)) return reject(new Error('Unsafe archive entry'));
        const mode = entry.externalFileAttributes >>> 16;
        modes.set(entry.fileName, mode);
        if (entry.fileName.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); zip.readEntry(); return; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.openReadStream(entry, async (err, stream) => {
          if (err) return reject(err);
          try {
            if ((mode & 0o170000) === 0o120000) {
              const chunks = []; for await (const chunk of stream) chunks.push(chunk);
              const target = Buffer.concat(chunks).toString('utf8');
              const resolved = path.resolve(path.dirname(dest), target);
              if (!resolved.startsWith(path.resolve(directory) + path.sep)) throw new Error('Unsafe symlink');
              links.push({ target, dest, resolved });
            } else { await pipeline(stream, fs.createWriteStream(dest)); if (process.platform !== 'win32') fs.chmodSync(dest, mode & 0o777); }
            zip.readEntry();
          } catch (e) { reject(e); }
        });
      });
      zip.readEntry();
    });
  });
  while (links.length) {
    let progress = false;
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i];
      if (!fs.existsSync(link.resolved)) continue;
      fs.symlinkSync(link.target, link.dest, fs.statSync(link.resolved).isDirectory() ? 'dir' : 'file');
      links.splice(i, 1); progress = true;
    }
    if (!progress) throw new Error('Unresolved symlinks in bundle: ' + links.map(l => l.dest).join(', '));
  }
  return modes;
}
async function tool() {
  if (process.env.RCODESIGN) return process.env.RCODESIGN;
  const base = 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/';
  const filename = 'apple-codesign-0.29.0-x86_64-pc-windows-msvc.zip';
  const archive = await download(base + filename, path.join(cache, filename));
  const sum = await download(base + filename + '.sha256', archive + '.sha256');
  const expected = fs.readFileSync(sum, 'utf8').trim().split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (actual !== expected) throw new Error('Signing tool checksum mismatch');
  const destination = path.join(cache, 'apple-codesign');
  if (!fs.existsSync(destination)) {
    const { extractZip } = require('./prepare.cjs');
    await extractZip(archive, destination);
  }
  const exe = tree(destination).find(f => f.name.endsWith('rcodesign.exe'));
  if (!exe) throw new Error('rcodesign not found');
  return exe.source;
}
async function signArchive(archive) {
  const directory = fs.mkdtempSync(path.join(cache, 'signing-'));
  try {
    const modes = await extractBundle(archive, directory);
    const app = path.join(directory, 'Splat Convert Desktop.app');
    const signer = await tool();
    const entitlement = path.join(root, 'scripts/entitlements.mac.plist');
    const scopes = ['Contents/MacOS/Electron', 'Contents/Resources/engine/node', ...['', ' (Renderer)', ' (GPU)', ' (Plugin)'].map(s => 'Contents/Frameworks/Electron Helper' + s + '.app/Contents/MacOS/Electron Helper' + s)];
    const signingArgs = scopes.flatMap(scope => ['--entitlements-xml-file', scope.replaceAll('/', path.sep) + ':' + entitlement]);
    const result = spawnSync(signer, ['sign', '--timestamp-url', 'none', '--entitlements-xml-file', entitlement, ...signingArgs, app], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Ad-hoc signing failed');
    const output = archive.replace('-unsigned.zip', '-adhoc.zip');
    const zip = new yazl.ZipFile();
    const done = pipeline(zip.outputStream, fs.createWriteStream(output));
    function add(folder, prefix = '') {
      for (const name of fs.readdirSync(folder)) {
        const full = path.join(folder, name), nameInZip = path.posix.join(prefix, name), stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) zip.addBuffer(Buffer.from(fs.readlinkSync(full).replaceAll('\\', '/')), nameInZip, { mode: 0o120777 });
        else if (stat.isDirectory()) add(full, nameInZip);
        else {
          const executable = /\/Contents\/MacOS\/|\/Helpers\/(chrome_crashpad_handler|app_shim_loader)$|\/Versions\/A\/Electron Framework$|\/Resources\/ShipIt$|\/Resources\/engine\/node$/.test('/' + nameInZip);
          zip.addFile(full, nameInZip, { mode: modes.get(nameInZip) || (executable ? 0o100755 : 0o100644) });
        }
      }
    }
    add(directory); zip.end(); await done;
    if (archive !== output) fs.unlinkSync(archive);
    console.log('Ad-hoc signed: ' + output);
    return output;
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}
module.exports = { signArchive };
if (require.main === module) signArchive(path.resolve(process.argv[2])).catch(e => { console.error(e); process.exitCode = 1; });
