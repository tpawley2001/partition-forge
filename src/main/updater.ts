import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { CH } from '../shared/ipc';
import type { UpdateState } from '../shared/ipc';

// Updates come from GitHub Releases (electron-builder.yml `publish`).
// PF_UPDATE_URL points a build at a generic feed (a directory holding
// latest.yml and the installer) instead, for testing.
//
// A disk tool must not restart itself at a bad moment, so nothing installs on
// its own: updates download in the background and wait for the user to press
// Restart, and the main process refuses that while a queue is executing or an
// offline job is staged (the upgrade's uninstall step clears PartitionForge's
// firmware boot entry, which would silently disarm the job).

const CHECK_EVERY_MS = 6 * 60 * 60_000;

let state: UpdateState = { status: 'idle', version: app.getVersion() };
let getWindow: () => BrowserWindow | null = () => null;

function set(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  getWindow()?.webContents.send(CH.updateStatus, state);
}

export const updatesEnabled = () =>
  app.isPackaged && process.platform === 'win32' && process.env.PF_MOCK !== '1';

export function getUpdateState(): UpdateState {
  return updatesEnabled() ? state : { ...state, status: 'disabled' };
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!updatesEnabled()) return getUpdateState();
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state;
  set({ status: 'checking', error: undefined });
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', error: (e as Error).message });
  }
  return state;
}

/** Quits and runs the downloaded installer silently, then relaunches. */
export function installUpdate(): void {
  if (state.status !== 'ready') throw new Error('No update has been downloaded.');
  // isSilent: the app is already elevated, so the per-machine installer runs
  // without a second UAC prompt. isForceRunAfter: reopen when it finishes.
  autoUpdater.quitAndInstall(true, true);
}

export function initUpdater(win: () => BrowserWindow | null) {
  getWindow = win;
  if (!updatesEnabled()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  if (process.env.PF_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.PF_UPDATE_URL });

  autoUpdater.on('update-not-available', () => set({ status: 'current', available: undefined }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', available: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', available: info.version, percent: 100 }));
  autoUpdater.on('error', (e) => set({ status: 'error', error: e?.message ?? String(e) }));

  setTimeout(() => { void checkForUpdates(); }, 10_000);
  setInterval(() => { void checkForUpdates(); }, CHECK_EVERY_MS).unref();
}
