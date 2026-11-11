const fs = require('node:fs');
const path = require('node:path');

function claimPrompt(marker) {
  let fd;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fd = fs.openSync(marker, 'wx', 0o600);
    fs.writeFileSync(fd, new Date().toISOString());
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
module.exports = { claimPrompt };
