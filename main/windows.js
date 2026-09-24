import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.cjs');
const REASSERT_TOP_MS = 2000;

/**
 * 每個螢幕一個全螢幕透明覆蓋視窗（罩該螢幕的 workArea，全域座標）。
 * 回傳 Map(displayId → win)。寵物模擬在主程序，視窗只負責畫。
 */
export function createOverlayWindows() {
  const wins = new Map();
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    const win = new BrowserWindow({
      x: a.x, y: a.y, width: a.width, height: a.height,
      transparent: true, frame: false, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    keepOnTop(win);
    win.loadFile(path.join(here, '..', 'renderer', 'overlay', 'index.html'), { search: `d=${d.id}` });
    win.once('ready-to-show', () => win.showInactive());
    wins.set(d.id, win);
  }
  return wins;
}

/** 目前顯示器布局（給模擬與 renderer 用），bounds 用 workArea。 */
export function displayLayout() {
  return screen.getAllDisplays().map((d) => ({ id: d.id, x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height }));
}

function keepOnTop(win) {
  const level = process.platform === 'win32' ? 'screen-saver' : 'floating';
  const reassert = () => { if (!win.isDestroyed()) win.setAlwaysOnTop(true, level); };
  win.on('blur', reassert);
  win.on('show', reassert);
  const timer = setInterval(reassert, REASSERT_TOP_MS);
  win.on('closed', () => clearInterval(timer));
}

export function createSettingsWindow() {
  const areaHeight = screen.getPrimaryDisplay().workArea.height;
  const win = new BrowserWindow({
    width: 560, height: Math.min(760, areaHeight - 40), minWidth: 480, minHeight: 480,
    title: '桌面小動物 設定',
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(here, '..', 'renderer', 'settings', 'index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}
