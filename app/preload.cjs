const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  config: () => ipcRenderer.invoke('config'),
  chooseInputs: () => ipcRenderer.invoke('choose-inputs'),
  droppedInputs: files => ipcRenderer.invoke('dropped-inputs', files.map(file => webUtils.getPathForFile(file))),
  chooseOutput: options => ipcRenderer.invoke('choose-output', options),
  convert: request => ipcRenderer.invoke('convert', request),
  cancel: () => ipcRenderer.invoke('cancel'),
  openRepository: () => ipcRenderer.invoke('open-repository'),
  showOutput: () => ipcRenderer.invoke('show-output'),
  licenses: () => ipcRenderer.invoke('licenses'),
  onProgress: fn => ipcRenderer.on('progress', (_, data) => fn(data))
});
