import { app, BrowserWindow, dialog, shell } from 'electron';
import * as path from 'node:path';
import { registerIpc } from './ipc';
import { isElevated } from './storage/powershell';
import { initUpdater } from './updater';

let win: BrowserWindow | null = null;
const isDev = process.env.PF_DEV === '1';

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1115',
    show: false,
    title: 'PartitionForge',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.setMenuBarVisibility(false);

  // External links open in the user's browser, never inside the app frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  if (isDev && process.env.PF_VITE_URL) {
    win.loadURL(process.env.PF_VITE_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

// A second copy editing the same partition table at the same time is a good
// way to corrupt it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    registerIpc(() => win);
    createWindow();
    initUpdater(() => win);

    if (process.platform === 'win32' && !(await isElevated())) {
      dialog.showMessageBox(win!, {
        type: 'warning',
        title: 'Administrator rights required',
        message: 'PartitionForge is not running as administrator.',
        detail: 'Reading disks may work, but no change can be written. Close it and choose "Run as administrator".',
        buttons: ['OK'],
      });
    }
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
