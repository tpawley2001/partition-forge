import React from 'react';
import type { Disk } from '../../shared/types';
import { DiskMap, diskItems, type Selection } from './DiskMap';
import { fmt, fsClass, partLabel, usedFraction } from '../lib/format';

interface Props {
  disk: Disk;
  live: Disk;
  selection: Selection | null;
  pending: boolean;
  onSelect: (s: Selection) => void;
  onOpen: (s: Selection) => void;
}

export function DiskCard({ disk, live, selection, pending, onSelect, onOpen }: Props) {
  const items = diskItems(disk);

  return (
    <section className="disk">
      <div className="disk-head">
        <div className="idx">{disk.number}</div>
        <div className="grow">
          <div className="name">{disk.friendlyName || `Disk ${disk.number}`}</div>
          <div className="sub">
            {fmt(disk.size)} · {disk.busType} · {disk.mediaType === 'Unspecified' ? 'Removable' : disk.mediaType}
            {disk.serialNumber ? ` · S/N ${disk.serialNumber}` : ''}
          </div>
        </div>
        <div className="badges">
          {live.isSystem && <span className="badge accent">System</span>}
          {live.isBoot && !live.isSystem && <span className="badge accent">Boot</span>}
          {disk.isReadOnly && <span className="badge warn">Read-only</span>}
          {disk.isOffline && <span className="badge warn">Offline</span>}
          {disk.health !== 'Healthy' && <span className="badge danger">{disk.health}</span>}
          <span className="badge">{disk.partitionStyle}</span>
        </div>
      </div>

      <DiskMap disk={disk} selection={selection} pending={pending} onSelect={onSelect} onOpen={onOpen} />

      <table className="parts">
        <thead>
          <tr>
            <th style={{ width: '26%' }}>Volume</th>
            <th style={{ width: '14%' }}>Type</th>
            <th style={{ width: '11%' }}>Filesystem</th>
            <th style={{ width: '13%' }} className="num">Size</th>
            <th style={{ width: '13%' }} className="num">Free</th>
            <th style={{ width: '13%' }}>Used</th>
            <th className="num">Offset</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const sel = selection?.diskNumber === disk.number
              && selection.kind === it.kind && selection.offset === it.offset;
            const pick: Selection = {
              diskNumber: disk.number,
              kind: it.kind,
              partitionNumber: it.kind === 'partition' ? it.part.partitionNumber : undefined,
              offset: it.offset,
              size: it.size,
            };

            if (it.kind === 'free') {
              return (
                <tr key={`f-${it.offset}`} className={`row${sel ? ' sel' : ''}`}
                    onClick={() => onSelect(pick)} onDoubleClick={() => onOpen(pick)}>
                  <td className="name" style={{ color: 'var(--text-3)' }}>
                    <div className="vol">
                      <span className="swatch" style={{ background: 'var(--fs-raw)' }} />
                      <span className="nm">Unallocated</span>
                    </div>
                  </td>
                  <td>—</td><td>—</td>
                  <td className="num">{fmt(it.size)}</td>
                  <td className="num">—</td><td>—</td>
                  <td className="num">{fmt(it.offset)}</td>
                </tr>
              );
            }

            const p = it.part;
            const uf = usedFraction(p);
            const cls = fsClass(p);
            return (
              <tr key={`p-${p.partitionNumber}-${p.offset}`} className={`row${sel ? ' sel' : ''}`}
                  onClick={() => onSelect(pick)} onDoubleClick={() => onOpen(pick)}>
                <td className="name">
                  <div className="vol">
                    <span className="swatch" style={{ background: `var(--${cls})` }} />
                    <span className="nm">{partLabel(p)}</span>
                    {p.isSystem && <span className="badge accent">System</span>}
                    {p.isBoot && !p.isSystem && <span className="badge accent">Boot</span>}
                  </div>
                </td>
                <td>{p.typeName || '—'}</td>
                <td>{p.volume?.fileSystem || 'Unformatted'}</td>
                <td className="num">{fmt(p.size)}</td>
                <td className="num">{p.volume ? fmt(p.volume.sizeRemaining) : '—'}</td>
                <td>
                  {uf === null ? '—' : (
                    <div className="usebar" title={`${Math.round(uf * 100)}% used`}>
                      <i className={uf > 0.92 ? 'crit' : uf > 0.8 ? 'hi' : ''} style={{ width: `${uf * 100}%` }} />
                    </div>
                  )}
                </td>
                <td className="num">{fmt(p.offset)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
