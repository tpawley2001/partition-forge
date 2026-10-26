import { ipcMain, BrowserWindow, app } from 'electron';
import { CH } from '../shared/ipc';
import type { Disk, Operation } from '../shared/types';
import { listDisks, loadSupportedSize } from './storage/disks';
import { planOperations, simulate } from './storage/planner';
import { applyPlan, offlinePrecheck, collectOfflineResult, rebootNow } from './storage/ops';
import { isElevated } from './storage/powershell';
import { assertSnapshotUnchanged } from './storage/validation';
import { checkForUpdates, getUpdateState, installUpdate } from './updater';

/** Disks as last read from the machine; every plan is validated against this. */
let cache: Disk[] = [];
let applying = false;
// ESP prechecks and collection temporarily mount the same partition. Serialize
// those jobs with execution so one request cannot unmount another's files.
let storageTail: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = storageTail.then(work);
  storageTail = result.catch(() => {});
  return result;
}

async function refresh(): Promise<Disk[]> {
  cache = await listDisks();
  return cache;
}

function findPartition(disks: Disk[], diskNumber: number, partitionNumber: number) {
  return disks.find((d) => d.number === diskNumber)?.partitions.find((p) => p.partitionNumber === partitionNumber);
}

export function registerIpc(getWindow: () => BrowserWindow | null) {
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Untrusted IPC sender.');
    }
    return listener(event, ...args);
  });
  handle(CH.info, async () => ({
    version: app.getVersion(),
    platform: process.platform,
    elevated: await isElevated(),
    mock: process.env.PF_MOCK === '1' || process.platform !== 'win32',
  }));

  handle(CH.list, async () => applying ? cache : refresh());

  handle(CH.supportedSize, async (_e, diskNumber: unknown, partitionNumber: unknown) => {
    if (!Number.isInteger(diskNumber) || !Number.isInteger(partitionNumber)) throw new Error('Invalid partition.');
    const p = findPartition(cache, diskNumber as number, partitionNumber as number);
    if (!p) return { min: undefined, max: undefined };
    if (applying) return { min: p.supportedSizeMin, max: p.supportedSizeMax };
    return exclusive(() => loadSupportedSize(p));
  });

  handle(CH.plan, async (_e, ops: Operation[]) => planOperations(cache, ops));

  handle(CH.preview, async (_e, ops: Operation[]) => simulate(cache, ops));

  handle(CH.apply, async (_e, ops: Operation[]) => {
    if (process.env.PF_MOCK === '1' || process.platform !== 'win32') throw new Error('Sample data is read-only.');
    if (applying) throw new Error('An operation is already in progress.');
    applying = true;
    return exclusive(async () => { try {
      // Re-read the machine first: the queue was built against a snapshot that
      // may be minutes old, and the planner's collision checks are only as good
      // as the layout they run against.
      const before = cache;
      const disks = await refresh();
      assertSnapshotUnchanged(before, disks, ops);
      // Resize limits are not in the disk list; read them fresh for every
      // partition the queue resizes so the online/offline decision uses
      // today's layout, not whatever the dialog saw.
      for (const op of Array.isArray(ops) ? ops : []) {
        if (op?.kind !== 'resize' || op.target?.kind !== 'partition') continue;
        const p = findPartition(disks, op.target.diskNumber, op.target.partitionNumber);
        if (p && p.supportedSizeMin === undefined) await loadSupportedSize(p);
      }
      const plan = planOperations(disks, ops);
      if (plan.blockers.length) {
        return { ok: false, operations: plan.operations, message: plan.blockers[0], stagedOffline: false };
      }
      const result = await applyPlan(disks, plan, (e) => {
        getWindow()?.webContents.send(CH.progress, e);
      });
      try { await refresh(); } catch { result.message += ' Refresh failed; reload the disk list before continuing.'; }
      return result;
    } finally { applying = false; } });
  });

  handle(CH.precheck, async () => {
    if (process.env.PF_MOCK === '1' || process.platform !== 'win32') {
      return { canStage: false, reasons: ['Sample data is read-only; offline staging requires Windows.'], secureBoot: false, isUefi: false, espFound: false, espFree: 0, engineBytes: 0 };
    }
    return exclusive(() => offlinePrecheck());
  });
  handle(CH.collect, async () => {
    if (applying || process.env.PF_MOCK === '1') return null;
    return exclusive(() => collectOfflineResult());
  });
  handle(CH.updateState, async () => getUpdateState());
  handle(CH.updateCheck, async () => checkForUpdates());
  handle(CH.updateInstall, async () => {
    if (applying) throw new Error('Wait for the running operations to finish before updating.');
    // The upgrade replaces the firmware boot entry a staged job depends on.
    const pre = await exclusive(() => offlinePrecheck());
    if (pre.jobPending) throw new Error('An offline job is staged. Restart to let it finish, then update.');
    if (applying) throw new Error('Wait for the running operations to finish before updating.');
    installUpdate();
  });

  handle(CH.reboot, async () => {
    if (applying || process.platform !== 'win32' || process.env.PF_MOCK === '1') throw new Error('Restart is unavailable.');
    return rebootNow();
  });
}
