import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.cjs');

/** 全螢幕透明覆蓋層：寵物住在這裡。預設點擊穿透，renderer 游標壓到寵物時才關穿透。 */
export function createOverlayWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false, // 點寵物不搶焦點；mac/win 都仍收得到滑鼠事件
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  keepOnTop(win);
  win.loadFile(path.join(here, '..', 'renderer', 'overlay', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

/**
 * Windows 上的置頂視窗在失焦後常被之後啟用的視窗蓋過（electron#20933、#23614、#31536），
 * 尤其搭配 focusable:false。對策：失焦時與每 2 秒重新宣告一次置頂；setAlwaysOnTop 不會搶焦點。
 * macOS 不需要，但重複設定同一層級無副作用，所以不分平台。
 */
const REASSERT_TOP_MS = 2000;
function keepOnTop(win) {
  const level = process.platform === 'win32' ? 'screen-saver' : 'floating';
  const reassert = () => { if (!win.isDestroyed() && !win.isAlwaysOnTop()) win.setAlwaysOnTop(true, level); else if (!win.isDestroyed() && process.platform === 'win32') win.setAlwaysOnTop(true, level); };
  win.on('blur', reassert);
  win.on('show', reassert);
  const timer = setInterval(reassert, REASSERT_TOP_MS);
  win.on('closed', () => clearInterval(timer));
}

/** 讓覆蓋層永遠貼齊主螢幕 work area（接外接螢幕、改工作列位置時）。 */
export function fitOverlayToWorkArea(win) {
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
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
