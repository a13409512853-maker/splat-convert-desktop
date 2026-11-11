const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { convert, FORMATS, OPERATIONS } = require('./runner.cjs');
const { claimPrompt } = require('./prompt.cjs');
const REPOSITORY = 'https://github.com/a13409512853-maker/splat-convert-desktop';
app.setName('SplatConvertDesktop');
let window, active, quitting = false, lastOutput;
const granted = new Set();
const entry = pathToFileURL(path.join(__dirname, 'index.html')).href;
const runtime = path.join(process.resourcesPath, 'engine');
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame.url !== entry) throw new Error('Unauthorized window');
}
function handle(channel, fn) { ipcMain.handle(channel, (event, ...args) => { trusted(event); return fn(...args); }); }
async function describe(paths) {
  const results = [];
  for (const file of paths.slice(0, 1000)) {
    if (typeof file !== 'string' || !/\.(ply|sog|ksplat|splat|spz)$/i.test(file)) continue;
    try {
      const absolute = path.resolve(file), stat = await fs.stat(absolute);
      if (stat.isFile()) { granted.add(absolute); results.push({ path: absolute, name: path.basename(absolute), size: stat.size }); }
    } catch { }
  }
  return results;
}
handle('config', () => ({ formats: FORMATS, operations: OPERATIONS, repository: REPOSITORY }));
handle('choose-inputs', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters: [{ name: '高斯泼溅文件', extensions: ['ply', 'sog', 'ksplat', 'splat', 'spz'] }] });
  return result.canceled ? [] : describe(result.filePaths);
});
handle('dropped-inputs', paths => describe(Array.isArray(paths) ? paths : []));
handle('choose-output', async ({ format, suggested }) => {
  const spec = FORMATS[format];
  if (!spec) throw new Error('格式无效');
  const result = await dialog.showSaveDialog(window, { defaultPath: suggested, filters: [{ name: spec.name, extensions: [spec.suffix.slice(1)] }] });
  if (result.canceled) return null;
  return result.filePath.toLowerCase().endsWith(spec.suffix) ? result.filePath : result.filePath + spec.suffix;
});
handle('open-repository', () => shell.openExternal(REPOSITORY));
handle('show-output', () => { if (lastOutput) shell.showItemInFolder(lastOutput); });
handle('licenses', async () => {
  const file = path.join(runtime, 'THIRD-PARTY-LICENSES.txt');
  await shell.openPath(file);
});
handle('cancel', () => active?.abort());
handle('convert', async request => {
  if (active) throw new Error('已有转换任务在运行');
  if (!Array.isArray(request?.inputs) || request.inputs.some(i => !granted.has(i.path))) throw new Error('请重新选择源文件');
  active = new AbortController();
  try {
    try {
      await fs.access(request.output);
      const result = await dialog.showMessageBox(window, { type: 'warning', message: '覆盖已有输出文件？', detail: request.output,
        buttons: ['取消', '覆盖'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return { canceled: true };
      request.overwrite = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; request.overwrite = false; }
    const emit = (kind, text) => { if (!window.isDestroyed()) window.webContents.send('progress', { kind, text }); };
    const result = await convert(request, runtime, { signal: active.signal, status: text => emit('status', text), log: text => emit('log', text) });
    lastOutput = result.output;
    if (!quitting && claimPrompt(path.join(app.getPath('userData'), 'star-prompt-shown-v1'))) {
      const answer = await dialog.showMessageBox(window, { type: 'info', title: '转换成功，感谢使用',
        message: '第一次转换已完成！', detail: '如果这个工具帮到了你，欢迎到 GitHub 为项目点一个 Star（赞）。感谢支持。',
        buttons: ['关闭', '打开项目'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response === 1) await shell.openExternal(REPOSITORY).catch(() => {});
    }
    return result;
  } catch (error) { return { error: active.signal.aborted ? '已取消' : error.message }; }
  finally { active = null; if (quitting) app.quit(); }
});
app.whenReady().then(() => {
  window = new BrowserWindow({ width: 1100, height: 810, minWidth: 880, minHeight: 680,
    title: 'Splat Convert Desktop', backgroundColor: '#f5f8f7',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  window.on('close', e => { if (active) { e.preventDefault(); quitting = true; active.abort(); } });
  window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (active) { event.preventDefault(); quitting = true; active.abort(); } });
