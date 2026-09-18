// sandbox 下的 preload 必須是 CommonJS。只暴露白名單，不把 ipcRenderer 整個丟出去。
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('pet', {
  // overlay
  getActivePets: invoke('pets:active'),
  getState: invoke('state:get'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('overlay:ignore-mouse', ignore),
  showPetMenu: () => ipcRenderer.send('overlay:menu'),
  onPetsChanged: on('pets:changed'),
  onStateChanged: on('state:changed'),
  // settings
  listPets: invoke('pets:list'),
  setPetCount: invoke('pets:setCount'),
  deletePet: invoke('pets:delete'),
  savePet: invoke('pets:save'),
  generateSheet: invoke('gemini:sheet'),
  getKeyStatus: invoke('key:status'),
  setKey: invoke('key:set'),
  clearKey: invoke('key:clear'),
  setScale: invoke('state:scale'),
  setPaused: invoke('state:paused'),
  openExternal: (url) => ipcRenderer.send('shell:open', url),
  openLogs: () => ipcRenderer.send('shell:logs'),
});
