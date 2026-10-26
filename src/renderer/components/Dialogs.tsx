import React, { useEffect, useMemo, useState } from 'react';
import type { Disk, Partition } from '../../shared/types';
import { fmt, MIB, GIB, alignDown, alignUp, clamp, usedFraction } from '../lib/format';

/* ------------------------------------------------------------------ shell */

interface ShellProps {
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  confirmDanger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

export function Dialog({ title, onClose, onConfirm, confirmLabel = 'Add to queue', confirmDanger, disabled, children }: ShellProps) {
  // Escape always closes; Enter confirms unless the user is mid-edit in a
  // text field, where Enter is more likely to mean "done typing".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Enter' && !disabled) {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onConfirm, disabled]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <div className="content">{children}</div>
        <div className="foot">
          <button onClick={onClose}>Cancel</button>
          <button className={confirmDanger ? 'danger' : 'primary'} onClick={onConfirm} disabled={disabled}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Bytes <-> MB text field, so users type round numbers instead of byte counts. */
function MbField({ label, value, onChange, min, max, hint }: {
  label: string; value: number; onChange: (bytes: number) => void;
  min: number; max: number; hint?: string;
}) {
  const mb = Math.round(value / MIB);
  return (
    <div className="field">
      <label>{label}</label>
      <div className="frow">
        <input
          type="number"
          value={mb}
          min={Math.floor(min / MIB)}
          max={Math.floor(max / MIB)}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            onChange(clamp(alignDown(v * MIB), min, max));
          }}
        />
        <div style={{ flex: 0, alignSelf: 'center', color: 'var(--text-3)', paddingLeft: 2 }}>MB</div>
      </div>
      <div className="hint">{fmt(value)}{hint ? ` — ${hint}` : ''}</div>
    </div>
  );
}

/* ------------------------------------------------------------- resize/move */

export interface ResizeResult { newOffset: number; newSize: number }

export function ResizeDialog({ disk, part, onClose, onConfirm }: {
  disk: Disk; part: Partition;
  onClose: () => void;
  onConfirm: (r: ResizeResult) => void;
}) {
  // The partition can only live inside the run of free space that touches it.
  const before = disk.free.find((f) => f.offset + f.size === part.offset);
  const after  = disk.free.find((f) => f.offset === part.offset + part.size);
  const regionStart = before ? before.offset : part.offset;
  const regionEnd   = after ? after.offset + after.size : part.offset + part.size;

  const used = part.volume ? part.volume.size - part.volume.sizeRemaining : 0;
  // Leave the filesystem some slack; NTFS in particular will not shrink to the
  // exact byte count of its data.
  const minSize = Math.min(part.size, Math.max(MIB, alignUp(used * 1.04 + 32 * MIB)));

  const [offset, setOffset] = useState(part.offset);
  const [size, setSize] = useState(part.size);

  const maxSize = alignDown(regionEnd - offset);
  const maxOffset = alignDown(regionEnd - size);

  // Windows takes tens of seconds to work out how far a big NTFS volume can
  // shrink online, so the limits arrive after the dialog opens.
  const [limits, setLimits] = useState<{ min?: number; max?: number } | 'loading' | 'failed'>(
    part.supportedSizeMin !== undefined ? { min: part.supportedSizeMin, max: part.supportedSizeMax } : 'loading');
  useEffect(() => {
    if (limits !== 'loading') return;
    let live = true;
    window.pf.supportedSize(disk.number, part.partitionNumber)
      .then((r) => { if (live) setLimits(r); })
      .catch(() => { if (live) setLimits('failed'); });
    return () => { live = false; };
  }, [disk.number, part.partitionNumber, limits]);
  const checking = limits === 'loading';
  const known = typeof limits === 'object' ? limits : {};
  const onlineMin = known.min;
  // No reported limits means Windows will not resize it online at all.
  const noOnline = !checking && (known.min === undefined || known.max === undefined);
  const needsOffline = offset !== part.offset
    || (!checking && size !== part.size && (noOnline || (onlineMin !== undefined && size < onlineMin)));

  const total = regionEnd - regionStart;
  const pct = (b: number) => (total > 0 ? (b / total) * 100 : 0);
  const uf = usedFraction(part) ?? 0;

  const changed = offset !== part.offset || size !== part.size;

  return (
    <Dialog
      title={`Resize or move ${part.driveLetter ? `${part.driveLetter}:` : `partition ${part.partitionNumber}`}`}
      onClose={onClose}
      disabled={!changed || size < minSize || checking}
      onConfirm={() => onConfirm({ newOffset: offset, newSize: size })}
    >
      <div className="sizer">
        <div className="track">
          <div className="fill" style={{ left: `${pct(offset - regionStart)}%`, width: `${pct(size)}%` }}>
            <div className="used" style={{ width: `${uf * 100}%` }} />
          </div>
          <div className="lbl">{fmt(size)}</div>
        </div>
      </div>
      <div className="field">
        <input
          type="range"
          min={minSize} max={maxSize} step={MIB}
          value={size}
          onChange={(e) => setSize(clamp(alignDown(Number(e.target.value)), minSize, maxSize))}
        />
        <div className="hint" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>min {fmt(minSize)}</span><span>max {fmt(maxSize)}</span>
        </div>
      </div>

      <div className="frow">
        <MbField label="Free space before" value={offset - regionStart}
                 min={0} max={Math.max(0, maxOffset - regionStart)}
                 onChange={(b) => setOffset(clamp(regionStart + b, regionStart, maxOffset))} />
        <MbField label="Partition size" value={size} min={minSize} max={maxSize}
                 onChange={(b) => setSize(clamp(b, minSize, maxSize))} />
      </div>
      <div className="field">
        <label>Free space after</label>
        <input type="text" readOnly value={fmt(Math.max(0, regionEnd - offset - size))} />
      </div>

      {part.volume && (
        <div className="note info">
          <span>{part.volume.fileSystem} volume holding {fmt(used)}. It cannot shrink below roughly {fmt(minSize)}.</span>
        </div>
      )}
      {checking && (
        <div className="note info">
          <span>Asking Windows how far this volume can be resized while mounted… this can take up to a minute on a large drive.</span>
        </div>
      )}
      {needsOffline && (
        <div className="note warn">
          <span>
            {offset !== part.offset
              ? 'Moving the start of a partition means relocating its data. '
              : noOnline
                ? 'Windows does not support resizing this volume while it is mounted. '
                : `Windows will only shrink this volume to ${fmt(onlineMin ?? 0)} while it is mounted. `}
            PartitionForge will carry this out during a restart, before Windows loads.
          </span>
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ create */

export interface CreateResult {
  offset: number; size: number; fileSystem: string; label: string; driveLetter: string | null;
}

const FILESYSTEMS = ['NTFS', 'exFAT', 'FAT32', 'ReFS', 'unformatted'];

export function CreateDialog({ disk, region, takenLetters, onClose, onConfirm }: {
  disk: Disk;
  region: { offset: number; size: number };
  takenLetters: string[];
  onClose: () => void;
  onConfirm: (r: CreateResult) => void;
}) {
  const maxSize = alignDown(region.offset + region.size) - alignUp(region.offset);
  const [size, setSize] = useState(maxSize);
  const [fileSystem, setFs] = useState('NTFS');
  const [label, setLabel] = useState('');
  const [letter, setLetter] = useState<string>('auto');

  const free = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((c) => !takenLetters.includes(c));
  const fat32TooBig = fileSystem === 'FAT32' && size > 32 * GIB;

  return (
    <Dialog
      title={`New partition on disk ${disk.number}`}
      onClose={onClose}
      disabled={size < MIB}
      onConfirm={() => onConfirm({
        offset: alignUp(region.offset),
        size,
        fileSystem,
        label,
        driveLetter: letter === 'auto' ? (free[0] ?? null) : letter === 'none' ? null : letter,
      })}
    >
      <div className="sizer">
        <div className="track">
          <div className="fill" style={{ left: 0, width: `${(size / maxSize) * 100}%` }} />
          <div className="lbl">{fmt(size)} of {fmt(maxSize)}</div>
        </div>
      </div>
      <div className="field">
        <input type="range" min={MIB} max={maxSize} step={MIB} value={size}
               onChange={(e) => setSize(clamp(alignDown(Number(e.target.value)), MIB, maxSize))} />
      </div>

      <div className="frow">
        <MbField label="Size" value={size} min={MIB} max={maxSize} onChange={setSize} />
        <div className="field">
          <label>File system</label>
          <select value={fileSystem} onChange={(e) => setFs(e.target.value)}>
            {FILESYSTEMS.map((f) => <option key={f} value={f}>{f === 'unformatted' ? 'Leave unformatted' : f}</option>)}
          </select>
        </div>
      </div>

      <div className="frow">
        <div className="field">
          <label>Volume label</label>
          <input type="text" value={label} maxLength={32} placeholder="New Volume"
                 onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="field">
          <label>Drive letter</label>
          <select value={letter} onChange={(e) => setLetter(e.target.value)}>
            <option value="auto">Assign automatically{free[0] ? ` (${free[0]}:)` : ''}</option>
            <option value="none">Do not assign</option>
            {free.map((c) => <option key={c} value={c}>{c}:</option>)}
          </select>
        </div>
      </div>

      {disk.partitionStyle === 'MBR' && disk.partitions.length >= 4 && (
        <div className="note danger">
          <span>This MBR disk already has four primary partitions. Convert it to GPT before adding another.</span>
        </div>
      )}
      {fat32TooBig && (
        <div className="note warn">
          <span>Windows will not create a FAT32 volume larger than 32 GB. PartitionForge will format this one during a restart instead.</span>
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ format */

export function FormatDialog({ part, onClose, onConfirm }: {
  part: Partition;
  onClose: () => void;
  onConfirm: (r: { fileSystem: string; label: string; quick: boolean }) => void;
}) {
  const [fileSystem, setFs] = useState(part.volume?.fileSystem || 'NTFS');
  const [label, setLabel] = useState(part.volume?.label ?? '');
  const [quick, setQuick] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const name = part.driveLetter ? `${part.driveLetter}:` : part.volume?.label || `partition ${part.partitionNumber}`;
  const used = part.volume ? part.volume.size - part.volume.sizeRemaining : 0;

  return (
    <Dialog
      title={`Format ${name}`}
      onClose={onClose}
      confirmDanger
      confirmLabel="Add to queue"
      disabled={confirmText.trim().toUpperCase() !== 'FORMAT'}
      onConfirm={() => onConfirm({ fileSystem, label, quick })}
    >
      <div className="note danger">
        <span>Formatting erases everything on {name}{used > 0 ? `, including the ${fmt(used)} currently stored there` : ''}. There is no undo.</span>
      </div>
      <div className="frow">
        <div className="field">
          <label>File system</label>
          <select value={fileSystem} onChange={(e) => setFs(e.target.value)}>
            {FILESYSTEMS.filter((f) => f !== 'unformatted').map((f) => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Volume label</label>
          <input type="text" value={label} maxLength={32} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} style={{ width: 'auto' }} />
          Quick format
        </label>
        <div className="hint">A full format writes zeros across the whole volume and takes far longer, but reports bad sectors.</div>
      </div>
      <div className="field">
        <label>Type <span className="mono">FORMAT</span> to confirm</label>
        <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------- small text fields */

export function LabelDialog({ part, onClose, onConfirm }: {
  part: Partition; onClose: () => void; onConfirm: (label: string) => void;
}) {
  const [label, setLabel] = useState(part.volume?.label ?? '');
  return (
    <Dialog title="Change volume label" onClose={onClose} onConfirm={() => onConfirm(label)}>
      <div className="field">
        <label>Volume label</label>
        <input type="text" value={label} maxLength={32} autoFocus onChange={(e) => setLabel(e.target.value)} />
        <div className="hint">FAT volumes store at most 11 characters; exFAT stores 15.</div>
      </div>
    </Dialog>
  );
}

export function LetterDialog({ part, takenLetters, onClose, onConfirm }: {
  part: Partition; takenLetters: string[];
  onClose: () => void; onConfirm: (letter: string | null) => void;
}) {
  const [letter, setLetter] = useState<string>(part.driveLetter ?? 'none');
  const free = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    .filter((c) => !takenLetters.includes(c) || c === part.driveLetter);
  return (
    <Dialog title="Change drive letter" onClose={onClose}
            onConfirm={() => onConfirm(letter === 'none' ? null : letter)}>
      <div className="field">
        <label>Drive letter</label>
        <select value={letter} onChange={(e) => setLetter(e.target.value)}>
          <option value="none">Remove the drive letter</option>
          {free.map((c) => <option key={c} value={c}>{c}:</option>)}
        </select>
        <div className="hint">Programs holding open files or shortcuts on this volume will need updating.</div>
      </div>
    </Dialog>
  );
}

export function ConvertDialog({ disk, onClose, onConfirm }: {
  disk: Disk; onClose: () => void; onConfirm: (to: 'GPT' | 'MBR') => void;
}) {
  const to = disk.partitionStyle === 'GPT' ? 'MBR' : 'GPT';
  return (
    <Dialog title={`Convert disk ${disk.number} to ${to}`} onClose={onClose}
            confirmDanger={to === 'MBR'} onConfirm={() => onConfirm(to)}>
      <div className="field">
        <div style={{ color: 'var(--text-2)', lineHeight: 1.6 }}>
          Disk {disk.number} currently uses a <b>{disk.partitionStyle}</b> partition table.
          Converting rewrites the table in place and keeps the {disk.partitions.length} existing partition(s).
        </div>
      </div>
      {to === 'MBR' && (
        <div className="note danger">
          <span>MBR cannot address beyond 2 TB or hold more than four primary partitions. On a {fmt(disk.size)} disk, space past the 2 TB mark becomes unreachable.</span>
        </div>
      )}
      {(disk.isSystem || disk.isBoot) && (
        <div className="note danger">
          <span>This disk boots the machine. After converting you must also switch the firmware between UEFI and legacy BIOS mode, or Windows will not start.</span>
        </div>
      )}
      <div className="note info">
        <span>The table is rewritten during a restart, before Windows loads.</span>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({ title, body, confirmWord, danger, onClose, onConfirm }: {
  title: string; body: React.ReactNode; confirmWord?: string; danger?: boolean;
  onClose: () => void; onConfirm: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <Dialog title={title} onClose={onClose} onConfirm={onConfirm} confirmDanger={danger}
            disabled={!!confirmWord && text.trim().toUpperCase() !== confirmWord}>
      <div className={`note ${danger ? 'danger' : 'info'}`}><span>{body}</span></div>
      {confirmWord && (
        <div className="field">
          <label>Type <span className="mono">{confirmWord}</span> to confirm</label>
          <input type="text" value={text} autoFocus onChange={(e) => setText(e.target.value)} />
        </div>
      )}
    </Dialog>
  );
}

export function WipeDialog({ part, onClose, onConfirm }: {
  part: Partition; onClose: () => void; onConfirm: (passes: number) => void;
}) {
  const [passes, setPasses] = useState(1);
  const name = part.driveLetter ? `${part.driveLetter}:` : `partition ${part.partitionNumber}`;
  const [text, setText] = useState('');
  return (
    <Dialog title={`Securely wipe ${name}`} onClose={onClose} confirmDanger
            disabled={text.trim().toUpperCase() !== 'WIPE'}
            onConfirm={() => onConfirm(passes)}>
      <div className="note danger">
        <span>Every addressable sector of {name} ({fmt(part.size)}) is overwritten. This destroys its contents; SSD remapped cells and snapshots may retain copies.</span>
      </div>
      <div className="field">
        <label>Passes</label>
        <select value={passes} onChange={(e) => setPasses(Number(e.target.value))}>
          <option value={1}>1 — single zero pass</option>
          <option value={3}>3 — random, random, zero</option>
          <option value={7}>7 — seven passes</option>
        </select>
        <div className="hint">On SSDs, wear levelling means even a full overwrite cannot guarantee every stored copy is gone. Use the drive's own secure-erase for that.</div>
      </div>
      <div className="field">
        <label>Type <span className="mono">WIPE</span> to confirm</label>
        <input type="text" value={text} autoFocus onChange={(e) => setText(e.target.value)} />
      </div>
    </Dialog>
  );
}
