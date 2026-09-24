// sandbox 下的 preload 必須是 CommonJS。只暴露白名單，不把 ipcRenderer 整個丟出去。
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('pet', {
  // overlay（多螢幕：每視窗一個 drawer，模擬在主程序）
  getActivePets: invoke('pets:active'),
  overlayInit: () => ipcRenderer.invoke('overlay:init', Number(new URLSearchParams(location.search).get('d'))),
  onDraw: on('overlay:draw'),
  petMouse: (type) => ipcRenderer.send('overlay:mouse', type),
  showPetMenu: () => ipcRenderer.send('overlay:menu'),
  onPetsChanged: on('pets:changed'),
  getState: invoke('state:get'),
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
