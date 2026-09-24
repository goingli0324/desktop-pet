import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } from 'electron';
import { createOverlayWindows, createSettingsWindow, displayLayout } from './windows.js';
import { createSimulation } from './simulation.js';
import * as store from './pets-store.js';
import * as secrets from './secrets.js';
import { generateSpriteSheet, GeminiError } from './gemini.js';
import { log, logDir } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let overlays = new Map();   // displayId → BrowserWindow
let settingsWin = null;
let tray = null;
let sim = null;
let simTimer = null;
let lastTick = 0;
let ignoreState = new Map(); // displayId → 目前是否穿透（避免每幀重設）
const FRAME_MS = 1000 / 60;

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
  sim = createSimulation({ getDisplays: displayLayout, getScale: () => store.readSettings().scale, isPaused: () => store.readSettings().paused });
  sim.setPets(store.loadActivePets());
  buildOverlays();
  createTray();
  registerIpc();
  startLoop();
  const rebuild = () => buildOverlays();
  screen.on('display-metrics-changed', rebuild);
  screen.on('display-added', rebuild);
  screen.on('display-removed', rebuild);
  // 首次啟動：系統匣是唯一入口，非工程師不會知道，所以自動開一次設定頁
  if (!fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) { store.updateSettings({}); openSettings(); }
}

/** 依目前顯示器重建覆蓋視窗集合（首次與顯示器增減／解析度變更時）。 */
function buildOverlays() {
  for (const win of overlays.values()) if (!win.isDestroyed()) win.destroy();
  overlays = createOverlayWindows();
  ignoreState = new Map();
  for (const id of overlays.keys()) ignoreState.set(id, true);
}

function startLoop() {
  lastTick = Date.now();
  clearInterval(simTimer);
  simTimer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    if (!sim) return;
    sim.setCursor(screen.getCursorScreenPoint());
    sim.tick(dt);
    const lists = sim.renderLists();
    const hovered = sim.hoveredActor();
    const dragging = sim.isDragging();
    for (const [id, win] of overlays) {
      if (win.isDestroyed()) continue;
      const items = lists[id] || [];
      // 該視窗是否有游標壓著的寵物（或拖曳中）→ 決定穿透
      const cursor = screen.getCursorScreenPoint();
      const wantIgnore = dragging ? false : !(hovered && items.some((it) => it.grabTarget));
      const grab = !!(hovered && items.some((it) => it.grabTarget));
      if (ignoreState.get(id) !== wantIgnore) { win.setIgnoreMouseEvents(wantIgnore, { forward: true }); ignoreState.set(id, wantIgnore); }
      win.webContents.send('overlay:draw', { items, grab });
    }
  }, FRAME_MS);
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
  const list = store.loadActivePets();
  if (sim) sim.setPets(list);
  broadcast('pets:changed', list);
}

function registerIpc() {
  // overlay（多螢幕 drawer）
  ipcMain.handle('pets:active', () => store.loadActivePets());
  ipcMain.handle('state:get', () => store.readSettings());
  ipcMain.handle('overlay:init', (_e, displayId) => {
    const d = displayLayout().find((x) => x.id === displayId) || displayLayout()[0];
    return { display: d };
  });
  ipcMain.on('overlay:mouse', (_e, type) => {
    if (!sim) return;
    if (type === 'down') sim.startDrag();
    else if (type === 'up') sim.endDrag();
  });
  ipcMain.on('overlay:menu', (event) => {
    if (sim && !sim.hoveredActor()) return; // 只有壓在寵物上按右鍵才出選單
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
