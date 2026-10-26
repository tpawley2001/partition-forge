import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInfo, PfApi, PrecheckInfo, UpdateState } from '../shared/ipc';
import type { Disk, ExecResult, Operation, Partition, Plan, ProgressEvent } from '../shared/types';
import { DiskCard } from './components/DiskCard';
import type { Selection } from './components/DiskMap';
import { OpQueue } from './components/OpQueue';
import {
  ConfirmDialog, ConvertDialog, CreateDialog, FormatDialog,
  LabelDialog, LetterDialog, ResizeDialog, WipeDialog,
} from './components/Dialogs';
import { IconDisk, IconRefresh, IconShield, IconWarn } from './components/Icons';
import { fmt } from './lib/format';

declare global { interface Window { pf: PfApi } }

type DialogState =
  | { kind: 'resize'; disk: Disk; part: Partition }
  | { kind: 'create'; disk: Disk; region: { offset: number; size: number } }
  | { kind: 'format'; disk: Disk; part: Partition }
  | { kind: 'label'; disk: Disk; part: Partition }
  | { kind: 'letter'; disk: Disk; part: Partition }
  | { kind: 'convert'; disk: Disk }
  | { kind: 'delete'; disk: Disk; part: Partition }
  | { kind: 'wipe'; disk: Disk; part: Partition }
  | null;

let seq = 0;
const nextId = () => `op-${Date.now().toString(36)}-${seq++}`;

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [disks, setDisks] = useState<Disk[]>([]);
  const [preview, setPreview] = useState<Disk[]>([]);
  const [ops, setOps] = useState<Operation[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [precheck, setPrecheck] = useState<PrecheckInfo | null>(null);
  const [staged, setStaged] = useState(false);
  const [update, setUpdate] = useState<UpdateState | null>(null);

  /* ------------------------------------------------------------- loading */

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await window.pf.listDisks();
      setDisks(d);
      setPreview(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    window.pf.getInfo().then(setInfo).catch(() => {});
    window.pf.getUpdateState().then(setUpdate).catch(() => {});
    const offUpdate = window.pf.onUpdateState(setUpdate);
    refresh();
    const off = window.pf.onProgress(setProgress);

    // If the machine just came back from an offline run, say how it went.
    window.pf.collectOffline().then((r) => {
      if (!r) return;
      if (r.found) {
        const failed = (r.results ?? []).filter((x) => x.status === 'failed');
        setResult({
          ok: !r.aborted,
          operations: [],
          stagedOffline: false,
          message: r.aborted
            ? `The offline run stopped early: ${failed[0]?.error ?? 'an operation failed.'}`
            : `The offline run finished: ${(r.results ?? []).length} operation(s) completed.`,
        });
      } else if (r.jobPending) {
        setStaged(true);
        setResult({
          ok: false, operations: [], stagedOffline: true,
          message: 'Work is still staged for the next restart — the machine has not booted into the offline engine yet.',
        });
      }
    }).catch(() => {});

    return () => { off(); offUpdate(); };
  }, [refresh]);

  /* -------------------------------------------------- planning / preview */

  useEffect(() => {
    let cancelled = false;
    if (!ops.length) { setPlan(null); setPreview(disks); return; }
    setPlan(null);
    (async () => {
      try {
        const [p, pv] = await Promise.all([window.pf.plan(ops), window.pf.preview(ops)]);
        if (cancelled) return;
        setPlan(p);
        setPreview(pv);
        // If anything is headed for the reboot, find out now whether this
        // machine can stage it at all (Secure Boot, ESP space, …).
        if (p.requiresReboot && !precheck) {
          window.pf.offlinePrecheck().then((r) => { if (!cancelled) setPrecheck(r); }).catch(() => {});
        }
      } catch (e) {
        if (!cancelled) { setPlan(null); setError((e as Error).message); }
      }
    })();
    return () => { cancelled = true; };
  }, [ops, disks, precheck]);

  const takenLetters = useMemo(() => {
    const src = preview.length ? preview : disks;
    return src.flatMap((d) => d.partitions.map((p) => p.driveLetter).filter(Boolean) as string[]);
  }, [preview, disks]);

  /* ------------------------------------------------------------ helpers */

  const addOp = (op: Omit<Operation, 'id' | 'status' | 'engine'>) => {
    if (busy || staged || loading) return;
    setPlan(null);
    setOps((cur) => [...cur, { ...op, id: nextId(), status: 'pending', engine: 'online' }]);
    setResult(null);
    setDialog(null);
  };

  // Actions operate on the previewed layout, so a second change stacks onto the
  // first rather than fighting it.
  const selDisk = useMemo(
    () => (sel ? (preview.find((d) => d.number === sel.diskNumber) ?? null) : null),
    [sel, preview]);
  const selPart = useMemo(() => {
    if (!sel || !selDisk || sel.kind !== 'partition') return null;
    return selDisk.partitions.find((p) => p.partitionNumber === sel.partitionNumber) ?? null;
  }, [sel, selDisk]);
  const selFree = useMemo(() => {
    if (!sel || !selDisk || sel.kind !== 'free') return null;
    return selDisk.free.find((f) => f.offset === sel.offset) ?? null;
  }, [sel, selDisk]);

  const nameOf = (p: Partition) =>
    p.driveLetter ? `${p.driveLetter}:` : p.volume?.label ? `"${p.volume.label}"` : `partition ${p.partitionNumber}`;

  const open = (kind: NonNullable<DialogState>['kind']) => {
    if (busy || staged || loading) return;
    if (!selDisk) return;
    if (kind === 'create' && selFree) return setDialog({ kind, disk: selDisk, region: selFree });
    if (kind === 'convert') return setDialog({ kind, disk: selDisk });
    if (selPart) setDialog({ kind, disk: selDisk, part: selPart } as DialogState);
  };

  const apply = async () => {
    if (busy || staged || loading || !plan || plan.blockers.length) return;
    setBusy(true); setResult(null); setProgress(null);
    try {
      const r = await window.pf.apply(ops);
      setResult(r);
      setStaged(r.stagedOffline);
      // A failed batch may still have changed the disk. Rebuild from the
      // refreshed layout instead of replaying successful/destructive entries.
      setOps([]);
      await refresh();
    } catch (e) {
      setOps([]);
      setResult({ ok: false, operations: [], message: (e as Error).message, stagedOffline: false });
    } finally {
      setBusy(false); setProgress(null);
      // A failed staging attempt can leave the ESP state changed; re-check.
      setPrecheck(null);
    }
  };

  const installUpdate = () => {
    if (busy || staged || ops.length) return;
    window.pf.installUpdate().catch((e) => setError((e as Error).message));
  };

  /* ------------------------------------------------------------- render */

  const canAct = !!selPart && !busy && !staged && !loading && !!disks.find(d => d.number === sel?.diskNumber)?.partitions.some(p => p.partitionNumber === selPart.partitionNumber);
  const rawDisk = !!selDisk && selDisk.partitionStyle === 'RAW';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <IconDisk />
          PartitionForge
          <span className="ver">{info?.version ? `v${info.version}` : ''}</span>
        </div>

        <button className="ghost sm" onClick={refresh} disabled={busy || loading || ops.length > 0}
                title={ops.length ? 'Clear the queue before refreshing its disk snapshot' : 'Refresh disks'}>
          <IconRefresh className={loading ? 'spin' : ''} /> Refresh
        </button>

        <div style={{ width: 1, height: 22, background: 'var(--line)' }} />

        <button className="sm" disabled={!canAct || rawDisk} onClick={() => open('resize')}>Resize / Move</button>
        <button className="sm" disabled={!selFree || busy || staged || loading || rawDisk} onClick={() => open('create')}>Create</button>
        <button className="sm" disabled={!canAct || rawDisk} onClick={() => open('format')}>Format</button>
        <button className="sm" disabled={!canAct || rawDisk} onClick={() => open('label')}>Label</button>
        <button className="sm" disabled={!canAct || rawDisk} onClick={() => open('letter')}>Letter</button>
        <button className="sm" disabled={!canAct || rawDisk || selDisk?.partitionStyle !== 'MBR' || !!selPart?.isActive}
                title="Mark the selected partition active (MBR disks only)"
                onClick={() => selDisk && selPart && addOp({
                  kind: 'setActive',
                  target: { kind: 'partition', diskNumber: selDisk.number, partitionNumber: selPart.partitionNumber },
                  params: {},
                  description: `Mark ${nameOf(selPart)} as the active partition`,
                })}>Set Active</button>
        <button className="sm" disabled={!selDisk || busy || staged || loading} onClick={() => open('convert')}>
          Convert to {selDisk?.partitionStyle === 'GPT' ? 'MBR' : 'GPT'}
        </button>
        <button className="sm danger" disabled={!canAct || rawDisk} onClick={() => open('delete')}>Delete</button>
        <button className="sm danger" disabled={!canAct || rawDisk} onClick={() => open('wipe')}>Wipe</button>

        <div className="spacer" />

        {update?.status === 'downloading' && (
          <span className="badge" title="The update installs only when you choose to restart">
            Downloading v{update.available} — {update.percent ?? 0}%
          </span>
        )}
        {update?.status === 'ready' && (
          <button className="sm primary" onClick={installUpdate} disabled={busy || staged || ops.length > 0}
                  title={staged ? 'Restart to finish the staged offline job before updating'
                    : ops.length ? 'Apply or clear the queue before updating'
                    : 'Close PartitionForge, install the update and reopen'}>
            Restart to update to v{update.available}
          </button>
        )}
        {(update?.status === 'current' || update?.status === 'idle' || update?.status === 'error' || update?.status === 'checking') && (
          <button className="ghost sm" disabled={update.status === 'checking'}
                  onClick={() => { window.pf.checkForUpdates().then(setUpdate).catch(() => {}); }}
                  title={update.status === 'error' ? `Update check failed: ${update.error ?? ''}` : 'Check for a newer version'}>
            {update.status === 'checking' ? 'Checking…' : update.status === 'current' ? 'Up to date' : update.status === 'error' ? 'Update check failed' : 'Check for updates'}
          </button>
        )}

        {info?.mock && <span className="badge warn"><IconWarn /> Sample data</span>}
        {info && !info.mock && (
          <span className={`badge ${info.elevated ? 'ok' : 'danger'}`}>
            <IconShield /> {info.elevated ? 'Administrator' : 'Not elevated'}
          </span>
        )}
      </header>

      <div className="body">
        <main className="main">
          {error && <div className="note danger"><IconWarn /><span>{error}</span></div>}

          {!loading && !preview.length && (
            <div className="empty">No disks were reported by Windows.</div>
          )}

          {preview.map((d) => {
            const live = disks.find((x) => x.number === d.number) ?? d;
            const dirty = ops.some((o) => (o.target as { diskNumber: number }).diskNumber === d.number);
            return (
              <DiskCard
                key={d.number}
                disk={d}
                live={live}
                selection={sel}
                pending={dirty}
                onSelect={setSel}
                onOpen={(s) => {
                  if (busy || staged || loading) return;
                  setSel(s);
                  if (s.kind === 'free') {
                    const region = d.free.find(f => f.offset === s.offset);
                    if (region) setDialog({ kind: 'create', disk: d, region });
                  } else {
                    const part = d.partitions.find(p => p.partitionNumber === s.partitionNumber);
                    if (part && live.partitions.some(p => p.partitionNumber === part.partitionNumber)) setDialog({ kind: 'resize', disk: d, part });
                  }
                }}
              />
            );
          })}
        </main>

        <OpQueue
          ops={ops}
          plan={plan}
          busy={busy}
          progress={progress}
          result={result}
          precheck={precheck}
          onRemove={(id) => setOps((c) => c.filter((o) => o.id !== id))}
          onClear={() => { setOps([]); if (!staged) setResult(null); }}
          onApply={apply}
          onReboot={() => { window.pf.reboot().catch(e => setError((e as Error).message)); }}
        />
      </div>

      {/* ------------------------------------------------------- dialogs */}

      {dialog?.kind === 'resize' && (
        <ResizeDialog
          disk={dialog.disk} part={dialog.part}
          onClose={() => setDialog(null)}
          onConfirm={({ newOffset, newSize }) => {
            const p = dialog.part;
            const moved = newOffset !== p.offset;
            const resized = newSize !== p.size;
            const what = moved && resized ? 'Resize and move' : moved ? 'Move' : newSize > p.size ? 'Extend' : 'Shrink';
            addOp({
              kind: moved && !resized ? 'move' : 'resize',
              target: { kind: 'partition', diskNumber: dialog.disk.number, partitionNumber: p.partitionNumber },
              params: moved && !resized ? { newOffset } : { newSize, ...(moved ? { newOffset } : {}) },
              description: `${what} ${nameOf(p)} to ${fmt(newSize)}${moved ? ` at offset ${fmt(newOffset)}` : ''}`,
            });
          }}
        />
      )}

      {dialog?.kind === 'create' && (
        <CreateDialog
          disk={dialog.disk} region={dialog.region} takenLetters={takenLetters}
          onClose={() => setDialog(null)}
          onConfirm={(r) => addOp({
            kind: 'create',
            target: { kind: 'free', diskNumber: dialog.disk.number, offset: r.offset, size: r.size },
            params: r,
            description: `Create a ${fmt(r.size)} ${r.fileSystem === 'unformatted' ? 'unformatted' : r.fileSystem} partition on disk ${dialog.disk.number}${r.driveLetter ? ` as ${r.driveLetter}:` : ''}`,
          })}
        />
      )}

      {dialog?.kind === 'format' && (
        <FormatDialog
          part={dialog.part}
          onClose={() => setDialog(null)}
          onConfirm={(r) => addOp({
            kind: 'format',
            target: { kind: 'partition', diskNumber: dialog.disk.number, partitionNumber: dialog.part.partitionNumber },
            params: r,
            description: `Format ${nameOf(dialog.part)} as ${r.fileSystem}${r.label ? ` labelled "${r.label}"` : ''}`,
          })}
        />
      )}

      {dialog?.kind === 'label' && (
        <LabelDialog
          part={dialog.part}
          onClose={() => setDialog(null)}
          onConfirm={(label) => addOp({
            kind: 'label',
            target: { kind: 'partition', diskNumber: dialog.disk.number, partitionNumber: dialog.part.partitionNumber },
            params: { label },
            description: `Label ${nameOf(dialog.part)} "${label}"`,
          })}
        />
      )}

      {dialog?.kind === 'letter' && (
        <LetterDialog
          part={dialog.part} takenLetters={takenLetters}
          onClose={() => setDialog(null)}
          onConfirm={(driveLetter) => addOp({
            kind: 'letter',
            target: { kind: 'partition', diskNumber: dialog.disk.number, partitionNumber: dialog.part.partitionNumber },
            params: { driveLetter },
            description: driveLetter
              ? `Assign ${driveLetter}: to ${nameOf(dialog.part)}`
              : `Remove the drive letter from ${nameOf(dialog.part)}`,
          })}
        />
      )}

      {dialog?.kind === 'convert' && (
        <ConvertDialog
          disk={dialog.disk}
          onClose={() => setDialog(null)}
          onConfirm={(to) => addOp({
            kind: 'convertTable',
            target: { kind: 'disk', diskNumber: dialog.disk.number },
            params: { to },
            description: `Convert disk ${dialog.disk.number} to ${to}`,
          })}
        />
      )}

      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${nameOf(dialog.part)}`}
          danger
          confirmWord="DELETE"
          body={<>Deleting {nameOf(dialog.part)} ({fmt(dialog.part.size)}) discards its contents and returns the space to the disk as unallocated.</>}
          onClose={() => setDialog(null)}
          onConfirm={() => addOp({
            kind: 'delete',
            target: { kind: 'partition', diskNumber: dialog.disk.number, partitionNumber: dialog.part.partitionNumber },
            params: {},
            description: `Delete ${nameOf(dialog.part)} (${fmt(dialog.part.size)})`,
          })}
        />
      )}

      {dialog?.kind === 'wipe' && (
        <WipeDialog
          part={dialog.part}
          onClose={() => setDialog(null)}
          onConfirm={(passes) => addOp({
            kind: 'wipe',
            target: { kind: 'partition', diskNumber: dialog.disk.number, partitionNumber: dialog.part.partitionNumber },
            params: { passes },
            description: `Securely wipe ${nameOf(dialog.part)} — ${passes} pass${passes === 1 ? '' : 'es'}`,
          })}
        />
      )}
    </div>
  );
}
