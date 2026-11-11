const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yauzl = require('yauzl');
const yazl = require('yazl');
const plist = require('plist');
const { pipeline } = require('node:stream/promises');
const { root, cache, ELECTRON, verifiedDownload, prepare, tree, zipFiles } = require('./prepare.cjs');
const version = require('../package.json').version;
async function macArchive(engine, arch) {
  const filename = `electron-v${ELECTRON}-darwin-${arch}.zip`;
  const source = await verifiedDownload(`https://github.com/electron/electron/releases/download/v${ELECTRON}/`, filename, 'SHASUMS256.txt', 'electron-');
  const output = path.join(root, 'dist', `Splat-Convert-Desktop-${version}-mac-${arch}-unsigned.zip`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const appPrefix = 'Splat Convert Desktop.app/Contents/';
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, fs.createWriteStream(output));
  const iconDir = path.join(root, 'app/icons');
  fs.mkdirSync(iconDir, { recursive: true });
  for (const icon of ['plus', 'minus', 'arrow-up', 'arrow-down', 'folder-open', 'play', 'square', 'github', 'pencil', 'star', 'x', 'cpu', 'memory-stick', 'monitor', 'microchip', 'languages']) {
    fs.copyFileSync(path.join(root, 'node_modules/lucide-static/icons', icon + '.svg'), path.join(iconDir, icon + '.svg'));
  }
  await new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true }, (error, input) => {
      if (error) return reject(error);
      input.on('error', reject); input.on('end', resolve);
      input.on('entry', entry => {
        let name = entry.fileName;
        if (name.startsWith('Electron.app/')) name = name.replace('Electron.app/', 'Splat Convert Desktop.app/');
        const mode = entry.externalFileAttributes >>> 16 || (name.endsWith('/') ? 0o40755 : 0o100644);
        if (name.endsWith('/')) { zip.addEmptyDirectory(name, { mode }); input.readEntry(); return; }
        input.openReadStream(entry, async (err, stream) => {
          if (err) return reject(err);
          if (name === appPrefix + 'Info.plist' || /Electron Helper[^/]*\.app\/Contents\/Info\.plist$/.test(name)) {
            try {
              const chunks = []; for await (const chunk of stream) chunks.push(chunk);
              const config = plist.parse(Buffer.concat(chunks).toString('utf8'));
              if (name === appPrefix + 'Info.plist') {
                Object.assign(config, { CFBundleName: 'Splat Convert Desktop', CFBundleDisplayName: 'Splat Convert Desktop',
                  CFBundleIdentifier: 'io.github.a13409512853-maker.splat-convert-desktop', CFBundleShortVersionString: version,
                  CFBundleVersion: version, NSHighResolutionCapable: true, NSHumanReadableCopyright: 'MIT - a13409512853-maker; includes third-party open source software' });
                delete config.CFBundleURLTypes;
              } else {
                const helperName = name.match(/(Electron Helper[^/]*)\.app\/Contents\/Info\.plist$/)[1];
                config.CFBundleExecutable = helperName;
                config.CFBundleIdentifier = 'io.github.a13409512853-maker.splat-convert-desktop.helper' + helperName.replace('Electron Helper', '').replace(/[^a-z]/gi, '').toLowerCase();
              }
              zip.addBuffer(Buffer.from(plist.build(config)), name, { mode });
              input.readEntry();
            } catch (e) { reject(e); }
          } else {
            zip.addReadStream(stream, name, { mode, size: entry.uncompressedSize });
            stream.on('end', () => input.readEntry()); stream.on('error', reject);
          }
        });
      });
      input.readEntry();
    });
  });
  for (const file of tree(path.join(root, 'app'))) zip.addFile(file.source, appPrefix + 'Resources/app/' + file.name);
  for (const module of ['yazl', 'buffer-crc32', 'yauzl', 'pend']) {
    for (const file of tree(path.join(root, 'node_modules', module))) zip.addFile(file.source, appPrefix + 'Resources/app/node_modules/' + module + '/' + file.name);
  }
  for (const file of tree(engine.directory)) zip.addFile(file.source, appPrefix + 'Resources/engine/' + file.name, {
    mode: file.name === 'node' ? 0o100755 : 0o100644
  });
  const license = fs.readFileSync(path.join(root, 'LICENSE'));
  zip.addBuffer(license, 'LICENSE.txt');
  zip.addFile(engine.license, 'THIRD-PARTY-LICENSES.txt');
  zip.end(); await done;
  // A native Mac build repairs the upstream signature after the app resources change.
  if (process.platform === 'darwin') {
    const stage = fs.mkdtempSync(path.join(cache, 'mac-sign-'));
    const run = (command, args) => { if (spawnSync(command, args, { stdio: 'inherit' }).status !== 0) throw new Error(command + ' failed'); };
    run('ditto', ['-x', '-k', output, stage]);
    const app = path.join(stage, 'Splat Convert Desktop.app');
    const entitlement = path.join(root, 'scripts/entitlements.mac.plist');
    for (const helper of ['', ' (Renderer)', ' (GPU)', ' (Plugin)'])
      run('codesign', ['--force', '--sign', '-', '--entitlements', entitlement, path.join(app, 'Contents/Frameworks/Electron Helper' + helper + '.app')]);
    run('codesign', ['--force', '--sign', '-', '--entitlements', entitlement, path.join(app, 'Contents/Resources/engine/node')]);
    run('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlement, app]);
    run('codesign', ['--verify', '--deep', '--strict', app]);
    fs.unlinkSync(output);
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, output]);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.renameSync(output, output.replace('-unsigned.zip', '-adhoc.zip'));
  }
  console.log(output);
}
async function main() {
  const platform = process.argv[2] || process.platform, arch = process.argv[3] || process.arch;
  if (!((platform === 'win32' && arch === 'x64') || (platform === 'darwin' && ['arm64', 'x64'].includes(arch)))) throw new Error('Unsupported platform');
  const engine = await prepare(platform, arch);
  if (platform === 'win32') {
    await zipFiles(tree(engine.directory), path.join(cache, 'engine-win32-x64.zip'));
    if (spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'windows/Build.ps1')], { stdio: 'inherit' }).status !== 0) throw new Error('Windows build failed');
  } else await macArchive(engine, arch);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
