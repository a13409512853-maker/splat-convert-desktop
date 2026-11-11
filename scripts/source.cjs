const fs = require('node:fs');
const path = require('node:path');
const { root, tree, zipFiles } = require('./prepare.cjs');
async function main() {
  const files = [];
  for (const name of ['.github', 'app', 'docs', 'scripts', 'tests', 'windows']) {
    for (const file of tree(path.join(root, name))) files.push({ source: file.source, name: 'splat-convert-desktop/' + name + '/' + file.name });
  }
  for (const name of ['.gitignore', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD-PARTY-LICENSES.txt', 'README.md', 'RELEASING.md', 'CHANGELOG.md'])
    files.push({ source: path.join(root, name), name: 'splat-convert-desktop/' + name });
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist', `splat-convert-desktop-${require('../package.json').version}-source.zip`);
  await zipFiles(files, destination);
  console.log(destination + ' (' + files.length + ' files)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
