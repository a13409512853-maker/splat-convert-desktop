'use strict';
const $ = id => document.getElementById(id);
let config, inputs = [], ops = [], selected = -1, busy = false, autoOutput = true, editing = -1;
const languages = ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'];
let language = 'zh', lastState = 'ready', lastResources, resourceBusy = false;
const t = key => config?.catalog?.[key]?.[Math.max(0, languages.indexOf(language))] || key;
const formatBytes = n => n >= 2 ** 30 ? (n / 2 ** 30).toFixed(2) + ' GB' : n >= 2 ** 20 ? (n / 2 ** 20).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
function currentOps() { return $('scope').value === '-1' ? ops : inputs[Number($('scope').value)]?.ops || ops; }
function status(text) { $('status').textContent = text; }
function state(key) { lastState = key; status(t(key)); }
function ready() { $('start').disabled = busy || !inputs.length || !$('output').value.trim(); }
function suggestion() {
  if (!autoOutput || !inputs.length) return;
  const first = inputs[0], dir = first.path.slice(0, Math.max(first.path.lastIndexOf('/'), first.path.lastIndexOf('\\')) + 1);
  const name = inputs.length > 1 ? 'combined' : first.name.replace(/(\.compressed)?\.[^.]+$/, '') + '-converted';
  $('output').value = dir + name + config.formats[$('format').value].suffix;
}
function renderFiles() {
  const previous = $('scope').value;
  $('file-list').replaceChildren(); $('scope').replaceChildren(new Option(t('merged'), '-1'));
  inputs.forEach((file, i) => {
    const row = document.createElement('tr'); row.classList.toggle('selected', i === selected); row.tabIndex = 0; row.title = file.path;
    const name = document.createElement('td'), size = document.createElement('td'); name.textContent = file.name; size.textContent = formatBytes(file.size);
    row.append(name, size);
    const pick = () => { selected = i; renderFiles(); $('scope').value = String(i); renderOps(); };
    row.addEventListener('click', pick); row.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
    $('file-list').append(row); $('scope').add(new Option(file.name, String(i)));
  });
  if ([...$('scope').options].some(o => o.value === previous)) $('scope').value = previous;
  $('total').textContent = inputs.length + ' ' + t('files') + (inputs.length ? ' · ' + formatBytes(inputs.reduce((n, f) => n + f.size, 0)) : '');
  renderOps(); suggestion(); ready();
}
function renderOps() {
  const list = $('operations'); list.replaceChildren();
  currentOps().forEach((op, i) => list.add(new Option(t(op.type) + (op.values.length ? '   ' + op.values.join(', ') : ''), String(i))));
}
function add(files) {
  if (busy) return;
  for (const file of files) if (!inputs.some(x => x.path === file.path)) inputs.push({ ...file, ops: [] });
  renderFiles();
}
function swap(list, index, offset) {
  const dest = index + offset;
  if (index < 0 || dest < 0 || dest >= list.length) return index;
  [list[index], list[dest]] = [list[dest], list[index]]; return dest;
}
function formatChanged() {
  const compressed = !!config.formats[$('format').value].compressed, voxel = $('format').value === 'voxel';
  document.querySelectorAll('.sog-setting').forEach(el => el.hidden = !compressed);
  document.querySelectorAll('.voxel-setting').forEach(el => el.hidden = !voxel);
  $('device-field').hidden = !compressed && !voxel;
  $('device').querySelector('[value=cpu]').disabled = voxel;
  if (voxel && $('device').value === 'cpu') $('device').value = 'auto';
  autoOutput = true; suggestion(); ready();
}
function fields(previous) {
  $('op-fields').replaceChildren(); $('op-error').textContent = '';
  const spec = config.operations[$('op-type').value];
  spec.fields.forEach((field, i) => {
    const label = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input');
    const type = $('op-type').value;
    text.textContent = type === 'scale' ? t('factor') : type === 'sphere' && i === 3 ? t('radius') : type === 'box' ? t(i < 3 ? 'min' : 'max') + ' ' + ['X','Y','Z'][i % 3] : ['X','Y','Z'][i] || field;
    input.value = previous?.[i] ?? spec.defaults[i]; input.required = true;
    if (type === 'harmonics') { input.type = 'range'; input.min = '0'; input.max = '3'; input.step = '1'; const update = () => text.textContent = t('band') + ': ' + input.value; input.addEventListener('input', update); update(); }
    else { input.type = 'number'; input.step = 'any'; }
    label.append(text, input); $('op-fields').append(label);
  });
}
function editOperation(edit) {
  editing = edit ? $('operations').selectedIndex : -1;
  if (edit && editing < 0) return;
  $('op-title').textContent = t(edit ? 'edit' : 'addOp');
  const op = editing >= 0 ? currentOps()[editing] : null;
  $('op-type').value = op?.type || 'translate'; fields(op?.values); $('operation-dialog').showModal();
}
async function begin() {
  if (busy) return;
  const suffix = config.formats[$('format').value].suffix;
  if (!$('output').value.toLowerCase().endsWith(suffix)) $('output').value += suffix;
  const settings = Object.fromEntries(['keep', 'iterations', 'effort', 'workers'].map(id => [id, Number($(id).value)]));
  settings.voxel = Number($('voxel').value) / 1000; settings.opacity = Number($('opacity').value) / 100;
  settings.device = $('device-field').hidden ? 'cpu' : $('device').value;
  const request = { format: $('format').value, output: $('output').value.trim(), inputs, ops, settings };
  busy = true; $('workspace').disabled = true; $('language').disabled = true; $('cancel').disabled = false; $('show-output').hidden = true;
  $('progress').removeAttribute('value'); $('log').textContent = ''; ready(); state('preflight');
  try {
    const result = await window.desktop.convert(request);
    if (result.error) { state('failed'); $('log').textContent += result.error + '\n'; }
    else if (result.canceled) state('canceled');
    else { state('done'); status(t('done') + ' · ' + formatBytes(result.size)); $('show-output').hidden = false; $('progress').value = 100; }
  } catch (error) { state('failed'); $('log').textContent += error.message + '\n'; }
  finally { busy = false; $('workspace').disabled = false; $('language').disabled = false; $('cancel').disabled = true; if (!$('progress').hasAttribute('value')) $('progress').value = 0; ready(); }
}
function translate() {
  document.documentElement.lang = language;
  document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  const format = $('format').value || 'sog', op = $('op-type').value || 'translate';
  $('format').replaceChildren(); $('op-type').replaceChildren();
  for (const id of Object.keys(config.formats)) $('format').add(new Option(t(id === 'voxel' ? 'voxelFormat' : id), id));
  for (const id of Object.keys(config.operations)) $('op-type').add(new Option(t(id), id));
  $('format').value = format; $('op-type').value = op;
  for (const [id, key] of Object.entries({ 'remove-file':'remove', 'file-up':'up', 'file-down':'down', 'add-op':'addOp', 'edit-op':'edit', 'remove-op':'remove', 'op-up':'up', 'op-down':'down', 'browse-output':'browse' })) {
    $(id).title = t(key); $(id).setAttribute('aria-label', t(key));
  }
  for (const id of ['keep','iterations','effort','workers','voxel','opacity']) $(id).dispatchEvent(new Event('input'));
  renderFiles(); state(lastState); paintResources(lastResources);
}
function paintResources(r) {
  const unavailable = t('unknown'), giB = n => (n / 2 ** 30).toFixed(1);
  const cpu = $('metric-cpu'), ram = $('metric-memory'), gpu = $('metric-gpu'), vram = $('metric-vram');
  cpu.querySelector('span').textContent = 'CPU ' + (Number.isFinite(r?.cpu) ? Math.round(r.cpu) + '%' : unavailable);
  ram.querySelector('span').textContent = t('memory') + ' ' + (r?.totalMemory > 0 && Number.isFinite(r.availableMemory) ? giB(r.totalMemory-r.availableMemory) + ' / ' + giB(r.totalMemory) + ' GiB' : unavailable);
  const g = r?.gpus?.[0];
  gpu.querySelector('span').textContent = 'GPU ' + (Number.isFinite(g?.usage) ? Math.round(g.usage) + '%' : unavailable);
  vram.querySelector('span').textContent = r?.unified ? t('unified') : t('vram') + ' ' + (g?.memoryTotal > 0 && Number.isFinite(g.memoryUsed) ? giB(g.memoryUsed)+' / '+giB(g.memoryTotal)+' GiB' : unavailable);
  ram.classList.toggle('pressure', r?.totalMemory > 0 && Number.isFinite(r.availableMemory) && r.availableMemory/r.totalMemory < 0.1);
  if (!r) return;
  const time = t('sample') + ': ' + new Date(r.sampled).toLocaleTimeString();
  cpu.title = r.cpuName + '\n' + time;
  ram.title = t('available') + ': ' + (Number.isFinite(r.availableMemory) ? giB(r.availableMemory)+' GiB' : unavailable) + '\n' + time;
  gpu.title = vram.title = (r.gpus || []).map(g => g.name).join('\n') + '\n' + t('gpuUnknown') + '\n' + time;
}
async function refreshResources() {
  if (resourceBusy) return; resourceBusy = true;
  try { lastResources = await window.desktop.resources(); paintResources(lastResources); } catch { paintResources(null); }
  finally { resourceBusy = false; }
}
async function init() {
  config = await window.desktop.config();
  language = languages.includes(config.language) ? config.language : 'zh'; $('language').value = language;
  $('language').addEventListener('change', () => { language = $('language').value; translate(); window.desktop.setLanguage(language); });
  $('repository').href = config.repository;
  $('repository').addEventListener('click', e => { e.preventDefault(); window.desktop.openRepository(); });
  $('add-files').addEventListener('click', async () => add(await window.desktop.chooseInputs()));
  $('remove-file').addEventListener('click', () => { if (selected >= 0) inputs.splice(selected, 1); selected = -1; renderFiles(); });
  for (const [id, offset] of [['file-up', -1], ['file-down', 1]]) $(id).addEventListener('click', () => { selected = swap(inputs, selected, offset); renderFiles(); });
  $('scope').addEventListener('change', renderOps);
  $('format').addEventListener('change', formatChanged);
  $('output').addEventListener('input', () => { autoOutput = false; ready(); });
  $('browse-output').addEventListener('click', async () => { const out = await window.desktop.chooseOutput({ format: $('format').value, suggested: $('output').value }); if (out) { $('output').value = out; autoOutput = false; ready(); } });
  $('add-op').addEventListener('click', () => editOperation(false)); $('edit-op').addEventListener('click', () => editOperation(true));
  $('operations').addEventListener('dblclick', () => editOperation(true));
  $('remove-op').addEventListener('click', () => { const i = $('operations').selectedIndex; if (i >= 0) currentOps().splice(i, 1); renderOps(); });
  for (const [id, offset] of [['op-up', -1], ['op-down', 1]]) $(id).addEventListener('click', () => { const i = swap(currentOps(), $('operations').selectedIndex, offset); renderOps(); $('operations').selectedIndex = i; });
  $('op-type').addEventListener('change', () => fields()); $('dismiss-op').addEventListener('click', () => $('operation-dialog').close());
  $('operation-form').addEventListener('submit', e => {
    e.preventDefault(); const type = $('op-type').value, values = [...$('op-fields').querySelectorAll('input')].map(x => Number(x.value));
    let error = values.some(x => !Number.isFinite(x)) ? t('numeric') : '';
    if (['scale', 'sphere'].includes(type) && values.at(-1) <= 0) error = t('numeric');
    if (type === 'box' && values.slice(0, 3).some((v, i) => v > values[i + 3])) error = t('numeric');
    if (error) { $('op-error').textContent = error; return; }
    const op = { type, values }; if (editing >= 0) currentOps()[editing] = op; else currentOps().push(op);
    renderOps(); $('operation-dialog').close();
  });
  for (const id of ['keep', 'iterations', 'effort', 'workers', 'voxel', 'opacity']) $(id).addEventListener('input', () => {
    let v = Number($(id).value); const output = document.querySelector('output[for=' + id + ']');
    output.textContent = id === 'keep' ? v + '%' : id === 'effort' && v === -1 ? t('default') : id === 'workers' && v === 0 ? t('serial') : id === 'voxel' ? String(v / 1000) : id === 'opacity' ? String(v / 100) : String(v);
  });
  $('start').addEventListener('click', begin);
  $('cancel').addEventListener('click', () => { $('cancel').disabled = true; state('canceling'); window.desktop.cancel(); });
  $('show-output').addEventListener('click', () => window.desktop.showOutput()); $('licenses').addEventListener('click', () => window.desktop.licenses());
  const drop = $('drop-zone');
  drop.addEventListener('dragover', e => { e.preventDefault(); if (!busy) drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', async e => { e.preventDefault(); drop.classList.remove('dragging'); if (!busy) add(await window.desktop.droppedInputs([...e.dataTransfer.files])); });
  document.addEventListener('dragover', e => e.preventDefault()); document.addEventListener('drop', e => e.preventDefault());
  window.desktop.onProgress(data => { if (data.kind === 'status') state(data.text); else if(data.kind === 'focus-log') $('log').focus(); else { const log = $('log'); log.textContent = (log.textContent + data.text + '\n').slice(-150000); log.scrollTop = log.scrollHeight; } });
  translate(); formatChanged(); refreshResources();
  const interval = setInterval(() => { if (!document.hidden) refreshResources(); }, 2000);
  window.addEventListener('beforeunload', () => clearInterval(interval));
}
init().catch(error => status(error.message));
