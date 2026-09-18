import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } from 'electron';
import { createOverlayWindow, createSettingsWindow, fitOverlayToWorkArea } from './windows.js';
import * as store from './pets-store.js';
import * as secrets from './secrets.js';
import { generateSpriteSheet, GeminiError } from './gemini.js';
import { log, logDir } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let overlay = null;
let settingsWin = null;
let tray = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());
  app.whenReady().then(boot).catch((err) => { log('error', 'boot failed', { message: err.message, stack: err.stack }); app.quit(); });
}

// 兩個視窗都不該導覽或開新視窗：拖檔案進視窗會把頁面換成該檔，preload API 會跟著暴露（安全審查 M1）。
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

const ALLOWED_EXTERNAL_URLS = new Set(['https://aistudio.google.com/apikey']);

function boot() {
  store.ensureBuiltinPets();
  app.dock?.hide(); // 純 tray app，不佔 Dock
  overlay = createOverlayWindow();
  overlay.on('closed', () => { overlay = null; });
  createTray();
  registerIpc();
  screen.on('display-metrics-changed', () => fitOverlayToWorkArea(overlay));
  screen.on('display-added', () => fitOverlayToWorkArea(overlay));
  screen.on('display-removed', () => fitOverlayToWorkArea(overlay));
  // 首次啟動：系統匣是唯一入口，非工程師不會知道，所以自動開一次設定頁
  if (!fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) { store.updateSettings({}); openSettings(); }
}

// 視窗全關也不結束：這是常駐程式，只有 tray 的「結束」會退出。
app.on('window-all-closed', () => {});

function createTray() {
  const icon = nativeImage.createFromPath(path.join(here, '..', 'assets', 'tray.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('桌面小動物');
  refreshTrayMenu();
  tray.on('click', () => openSettings());
}

function refreshTrayMenu() {
  const { paused } = store.readSettings();
  const menu = Menu.buildFromTemplate([
    { label: '設定…', click: openSettings },
    { label: paused ? '繼續' : '暫停', click: () => setPaused(!paused) },
    { type: 'separator' },
    { label: '結束', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = createSettingsWindow();
  settingsWin.on('closed', () => { settingsWin = null; });
}

function setPaused(paused) {
  const next = store.updateSettings({ paused });
  broadcast('state:changed', next);
  refreshTrayMenu();
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcastActivePets() {
  broadcast('pets:changed', store.loadActivePets());
}

function registerIpc() {
  // overlay
  ipcMain.handle('pets:active', () => store.loadActivePets());
  ipcMain.handle('state:get', () => store.readSettings());
  ipcMain.on('overlay:ignore-mouse', (event, ignore) => {
    if (!overlay || event.sender !== overlay.webContents) return; // 只有覆蓋層能切穿透
    overlay.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('overlay:menu', (event) => {
    const { paused } = store.readSettings();
    Menu.buildFromTemplate([
      { label: '設定…', click: openSettings },
      { label: paused ? '繼續' : '暫停', click: () => setPaused(!paused) },
      { type: 'separator' },
      { label: '結束', click: () => app.quit() },
    ]).popup({ window: BrowserWindow.fromWebContents(event.sender) });
  });

  // settings
  ipcMain.handle('pets:list', () => ({ pets: store.listPets(), counts: store.readSettings().counts, maxTotal: store.MAX_TOTAL_PETS }));
  ipcMain.handle('pets:setCount', (_e, id, n) => { const s = store.setPetCount(String(id), n); broadcastActivePets(); return s.counts; });
  ipcMain.handle('pets:delete', (_e, id) => {
    const wasActive = (store.readSettings().counts[String(id)] || 0) > 0;
    store.deletePet(String(id));
    if (wasActive) broadcastActivePets(); // 刪沒在用的，桌面上的不要重生
    return store.readSettings().counts;
  });
  ipcMain.handle('pets:save', (_e, pet) => { const meta = store.savePet(pet); store.setPetCount(meta.id, 1); broadcastActivePets(); return meta.id; });
  ipcMain.handle('gemini:sheet', async (_e, image) => {
    try {
      return { ok: true, ...(await generateSpriteSheet(secrets.readKey(), image)) };
    } catch (err) {
      if (!(err instanceof GeminiError)) log('error', 'gemini unexpected', { message: err.message, stack: err.stack });
      return { ok: false, code: err.code || 'UNKNOWN', message: err.message };
    }
  });
  ipcMain.handle('key:status', () => ({ hasKey: secrets.hasKey(), hint: secrets.keyHint() }));
  ipcMain.handle('key:set', (_e, key) => { secrets.writeKey(key); return { hasKey: true, hint: secrets.keyHint() }; });
  ipcMain.handle('key:clear', () => { secrets.clearKey(); return { hasKey: false, hint: null }; });
  ipcMain.handle('state:scale', (_e, scale) => {
    const s = Math.min(1.5, Math.max(0.2, Number(scale) || 0.55));
    const next = store.updateSettings({ scale: s });
    broadcast('state:changed', next);
    return next;
  });
  ipcMain.handle('state:paused', (_e, paused) => { setPaused(!!paused); return store.readSettings(); });
  ipcMain.on('shell:open', (_e, url) => { if (ALLOWED_EXTERNAL_URLS.has(String(url))) shell.openExternal(String(url)); });
  ipcMain.on('shell:logs', () => shell.openPath(logDir()));
}
