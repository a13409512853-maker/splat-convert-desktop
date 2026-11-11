const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
async function main() {
  const directory = path.resolve(process.argv[2] || path.join(__dirname, '../dist'));
  const files = fs.readdirSync(directory).filter(name => /\.(zip|exe)$/.test(name)).sort();
  const lines = [];
  for (const name of files) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(directory, name))) hash.update(chunk);
    lines.push(hash.digest('hex') + '  ' + name);
  }
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  console.log('Wrote SHA256SUMS.txt for ' + lines.length + ' files');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
