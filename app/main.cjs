const { app, BrowserWindow, dialog, ipcMain, shell, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { convert, FORMATS, OPERATIONS } = require('./runner.cjs');
const { claimPrompt } = require('./prompt.cjs');
const { sampleResources, estimateJob, assess, classify, GiB } = require('./health.cjs');
const { catalog, codes, translate } = require('./i18n.cjs');
const REPOSITORY = 'https://github.com/a13409512853-maker/splat-convert-desktop';
app.setName('SplatConvertDesktop');
let window, active, quitting = false, lastOutput;
let language = 'en', resourcePromise, lastResources;
const t = key => translate(language, key);
const languageFile = () => path.join(app.getPath('userData'), 'language.txt');
async function resources() {
  if (lastResources && Date.now() - lastResources.sampled < 1500) return lastResources;
  if (!resourcePromise) resourcePromise = sampleResources().then(result => lastResources = result).finally(() => resourcePromise = null);
  return resourcePromise;
}
function estimateText(estimate, state) {
  if (!estimate) return '';
  const gb = value => (value / GiB).toFixed(2) + ' GiB';
  return estimate.count.toLocaleString() + ' · SH ' + estimate.bands + (estimate.upperBound ? ' · ' + t('upperBound') : '') + '\n' +
    t('baseMemory') + ': ' + gb(estimate.baseBytes) + '\n' + t('estimatedMemory') + ': ' + gb(estimate.lowBytes) + ' – ' + gb(estimate.highBytes) + '\n' +
    t('available') + ': ' + (Number.isFinite(state?.availableMemory) ? gb(state.availableMemory) : t('unknown')) + '\n\n' + t('estimateNote');
}
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
handle('config', () => ({ formats: FORMATS, operations: OPERATIONS, repository: REPOSITORY, catalog, language }));
handle('resources', resources);
handle('language', async code => {
  if (!codes.includes(code)) return;
  language = code;
  try { await fs.mkdir(path.dirname(languageFile()), { recursive: true }); await fs.writeFile(languageFile(), code); } catch { }
});
handle('choose-inputs', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters: [{ name: t('inputs'), extensions: ['ply', 'sog', 'ksplat', 'splat', 'spz'] }] });
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
  let estimate, state;
  try {
    require('./runner.cjs').normalize(request);
    try {
      await fs.access(request.output);
      const result = await dialog.showMessageBox(window, { type: 'warning', message: t('overwrite'), detail: request.output,
        buttons: [t('cancel'), t('ok')], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return { canceled: true };
      request.overwrite = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; request.overwrite = false; }
    const emit = (kind, text) => { if (!window.isDestroyed()) window.webContents.send('progress', { kind, text }); };
    emit('status', 'preflight');
    estimate = await estimateJob(request); active.signal.throwIfAborted();
    state = await resources(); active.signal.throwIfAborted();
    const risks = assess(estimate, state, request.settings?.device || 'auto');
    if (risks.length) {
      const decision = await dialog.showMessageBox(window, { type: 'warning', title: t('resourceWarning'), message: t('resourceWarning'),
        detail: estimateText(estimate, state) + '\n\n' + t('memoryAdvice') + (risks.includes('vram') ? '\n' + t('gpuAdvice') : ''),
        buttons: [t('adjust'), t('continue')], defaultId: 0, cancelId: 0 });
      if (decision.response !== 1) return { canceled: true };
    }
    active.signal.throwIfAborted();
    const result = await convert(request, runtime, { signal: active.signal, status: text => emit('status', text), log: text => emit('log', text) });
    lastOutput = result.output;
    if (!quitting && claimPrompt(path.join(app.getPath('userData'), 'star-prompt-shown-v1'))) {
      const answer = await dialog.showMessageBox(window, { type: 'info', title: t('starTitle'),
        message: t('starTitle'), detail: t('starMessage'),
        buttons: [t('close'), t('openProject')], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response === 1) await shell.openExternal(REPOSITORY).catch(() => {});
    }
    return result;
  } catch (error) {
    if (active.signal.aborted) return { canceled: true };
    const diagnosis = classify(error);
    const detail = [t(diagnosis.detail || diagnosis.title), t(diagnosis.advice), estimateText(estimate, state)].filter(Boolean).join('\n\n');
    const raw = 'Splat Convert Desktop 1.2.0\n' + process.platform + ' / ' + process.arch + '\n' + detail + '\n\n' + error.stack;
    if (!quitting) {
      let response;
      do {
        response = await dialog.showMessageBox(window, { type: 'error', title: t('failed'), message: t(diagnosis.title), detail,
          buttons: [t('adjust'), t('viewLog'), t('copy')], defaultId: 0, cancelId: 0 });
        if (response.response === 2) clipboard.writeText(raw);
      } while (response.response === 2);
      if (response.response === 1) window.webContents.send('progress', { kind: 'focus-log' });
    }
    return { error: error.message, diagnostic: diagnosis.code };
  }
  finally { active = null; if (quitting) app.quit(); }
});
app.whenReady().then(async () => {
  try { const code = (await fs.readFile(languageFile(), 'utf8')).trim(); if (codes.includes(code)) language = code; }
  catch { const code = app.getLocale().slice(0, 2); language = codes.includes(code) ? code : 'en'; }
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
