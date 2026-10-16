'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel) => (callback) => {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('term', {
  ready: () => ipcRenderer.send('term:ready'),
  start: (id, cwd, cols, rows, mode) => ipcRenderer.invoke('term:start', id, cwd, cols, rows, mode),
  write: (id, data) => ipcRenderer.send('term:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  stop: (id) => ipcRenderer.send('term:stop', id),
  pickFolder: (id) => ipcRenderer.invoke('term:pick-folder', id),
  openFolder: (cwd) => ipcRenderer.send('term:open-folder', cwd),
  forgetRecent: (cwd) => ipcRenderer.send('term:forget-recent', cwd),
  recheck: () => ipcRenderer.send('term:recheck'),
  newProject: (id, name) => ipcRenderer.invoke('term:new-project', id, name),
  openShell: (cwd) => ipcRenderer.send('term:open-shell', cwd),
  openNode: () => ipcRenderer.send('term:open-node'),
  /** 끌어다 놓은 파일의 실제 경로 — 터미널에 경로를 붙여 넣는 데 쓴다 */
  pathOf: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  onState: subscribe('term:state'),
  onData: subscribe('term:data'),
  onExit: subscribe('term:exit'),
  onFocus: subscribe('term:focus'),
});
