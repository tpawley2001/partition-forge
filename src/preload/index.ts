import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/ipc';
import type { PfApi, UpdateState } from '../shared/ipc';
import type { Operation, ProgressEvent } from '../shared/types';

// contextIsolation stays on: the renderer never gets ipcRenderer itself, only
// this fixed set of calls.
const api: PfApi = {
  getInfo:         () => ipcRenderer.invoke(CH.info),
  listDisks:       () => ipcRenderer.invoke(CH.list),
  supportedSize: (diskNumber: number, partitionNumber: number) => ipcRenderer.invoke(CH.supportedSize, diskNumber, partitionNumber),
  plan:      (ops: Operation[]) => ipcRenderer.invoke(CH.plan, ops),
  preview:   (ops: Operation[]) => ipcRenderer.invoke(CH.preview, ops),
  apply:     (ops: Operation[]) => ipcRenderer.invoke(CH.apply, ops),
  offlinePrecheck: () => ipcRenderer.invoke(CH.precheck),
  collectOffline:  () => ipcRenderer.invoke(CH.collect),
  reboot:          () => ipcRenderer.invoke(CH.reboot),
  onProgress: (cb: (e: ProgressEvent) => void) => {
    const listener = (_: unknown, e: ProgressEvent) => cb(e);
    ipcRenderer.on(CH.progress, listener);
    return () => { ipcRenderer.off(CH.progress, listener); };
  },
  getUpdateState:  () => ipcRenderer.invoke(CH.updateState),
  checkForUpdates: () => ipcRenderer.invoke(CH.updateCheck),
  installUpdate:   () => ipcRenderer.invoke(CH.updateInstall),
  onUpdateState: (cb: (s: UpdateState) => void) => {
    const listener = (_: unknown, s: UpdateState) => cb(s);
    ipcRenderer.on(CH.updateStatus, listener);
    return () => { ipcRenderer.off(CH.updateStatus, listener); };
  },
};

contextBridge.exposeInMainWorld('pf', api);
