'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel) => (callback) => {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('hub', {
  getState: () => ipcRenderer.invoke('hub:get-state'),
  getVersion: () => ipcRenderer.invoke('hub:get-version'),
  selectService: (id) => ipcRenderer.send('hub:select-service', id),
  selectTerminal: (id) => ipcRenderer.send('hub:select-terminal', id),
  setServiceMode: (id, mode) => ipcRenderer.send('hub:service-mode', id, mode),
  accountMenu: (id, x, y) => ipcRenderer.send('hub:account-menu', id, x, y),
  splitMenu: (x, y) => ipcRenderer.send('hub:split-menu', x, y),
  nav: (action) => ipcRenderer.send('hub:nav', action),
  newChat: (id) => ipcRenderer.send('hub:new-chat', id),
  newChatAll: () => ipcRenderer.send('hub:new-chat-all'),
  checkUpdate: () => ipcRenderer.send('hub:check-update'),
  installUpdate: () => ipcRenderer.send('hub:install-update'),
  toggleLayout: () => ipcRenderer.send('hub:toggle-layout'),
  toggleBroadcast: () => ipcRenderer.send('hub:toggle-broadcast'),
  setOverlay: (on) => ipcRenderer.send('hub:set-overlay', on),
  zoom: (dir) => ipcRenderer.send('hub:zoom', dir),
  setBarHeight: (h) => ipcRenderer.send('hub:bar-height', h),
  setComposerHeight: (h) => ipcRenderer.send('hub:composer-height', h),
  setTargets: (ids) => ipcRenderer.send('hub:set-targets', ids),
  openSettings: (section) => ipcRenderer.send('hub:open-settings', section),
  updateSettings: (patch) => ipcRenderer.send('hub:update-settings', patch),
  setShortcut: (id, combo) => ipcRenderer.invoke('hub:set-shortcut', id, combo),
  clearHistory: () => ipcRenderer.send('hub:clear-history'),
  renameAccount: (id, label) => ipcRenderer.send('hub:rename-account', id, label),
  accountAction: (action, id) => ipcRenderer.send('hub:account-action', action, id),
  openDataFolder: () => ipcRenderer.send('hub:open-data-folder'),
  toggleSidebar: () => ipcRenderer.send('hub:toggle-sidebar'),
  openHistory: (id, serviceId) => ipcRenderer.invoke('hub:open-history', id, serviceId),
  deleteHistory: (id) => ipcRenderer.send('hub:delete-history', id),
  setOrder: (ids) => ipcRenderer.send('hub:set-order', ids),
  moveService: (id, step) => ipcRenderer.send('hub:move-service', id, step),
  openWelcome: () => ipcRenderer.send('hub:open-welcome'),
  completeOnboarding: (ids) => ipcRenderer.send('hub:complete-onboarding', ids),
  broadcast: (text, ids, opts) => ipcRenderer.invoke('hub:broadcast', text, ids, opts),
  pickFiles: () => ipcRenderer.invoke('hub:pick-files'),
  saveTempFile: (name, bytes) => ipcRenderer.invoke('hub:save-temp-file', name, bytes),
  // 끌어다 놓은 File들의 실제 경로를 얻어 등록한다 (Electron 32+에서는 File.path 대신 webUtils).
  // 페이지가 만든 File(경로 없음)로는 임의 경로를 등록할 수 없다. 경로가 없는 항목은 null로 돌려준다.
  resolveFiles: async (files) => {
    const paths = [...files].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } });
    const infos = await ipcRenderer.invoke('hub:file-infos', paths.filter(Boolean));
    return paths.map((p) => (p && infos.find((i) => i.path.toLowerCase() === p.toLowerCase())) || null);
  },
  discardFiles: (paths) => ipcRenderer.send('hub:discard-files', paths),
  onState: subscribe('state'),
  onToast: subscribe('toast'),
  onOpenSettings: subscribe('open-settings'),
  onOpenWelcome: subscribe('open-welcome'),
  onFocusBroadcast: subscribe('focus-broadcast'),
});
