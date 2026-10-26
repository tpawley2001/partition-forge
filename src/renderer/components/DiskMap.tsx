import React, { useMemo } from 'react';
import type { Disk, FreeRegion, Partition } from '../../shared/types';
import { fmt, fsClass, partLabel, usedFraction } from '../lib/format';

export type MapItem =
  | { kind: 'partition'; part: Partition; offset: number; size: number }
  | { kind: 'free'; region: FreeRegion; offset: number; size: number };

export interface Selection {
  diskNumber: number;
  kind: 'partition' | 'free';
  partitionNumber?: number;
  offset: number;
  size: number;
}

/**
 * A 16 MiB reserved partition next to a 4 TB volume is ~0.0004% of the disk and
 * would render sub-pixel. Every segment gets a floor, and the surplus is taken
 * proportionally from the segments that can spare it, so the map stays readable
 * without lying too much about scale.
 */
const MIN_PCT = 3.6;

function widths(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 100 / Math.max(sizes.length, 1));
  const raw = sizes.map((s) => (s / total) * 100);
  const deficit = raw.reduce((a, p) => a + Math.max(0, MIN_PCT - p), 0);
  const surplus = raw.reduce((a, p) => a + Math.max(0, p - MIN_PCT), 0);
  if (deficit === 0 || surplus <= 0) return raw;
  return raw.map((p) => (p < MIN_PCT ? MIN_PCT : p - (p - MIN_PCT) * (deficit / surplus)));
}

export function diskItems(disk: Disk): MapItem[] {
  const items: MapItem[] = [
    ...disk.partitions.map((p) => ({ kind: 'partition' as const, part: p, offset: p.offset, size: p.size })),
    ...disk.free.map((f) => ({ kind: 'free' as const, region: f, offset: f.offset, size: f.size })),
  ];
  return items.sort((a, b) => a.offset - b.offset);
}

interface Props {
  disk: Disk;
  selection: Selection | null;
  pending: boolean;
  onSelect: (s: Selection) => void;
  onOpen?: (s: Selection) => void;
}

export function DiskMap({ disk, selection, pending, onSelect, onOpen }: Props) {
  const items = useMemo(() => diskItems(disk), [disk]);
  const w = useMemo(() => widths(items.map((i) => i.size)), [items]);

  if (!items.length) {
    return (
      <div className="map">
        <div className="seg free" style={{ width: '100%' }}>
          <div className="cap"><div className="t">Unallocated — {fmt(disk.size)}</div></div>
        </div>
      </div>
    );
  }

  return (
    <div className="map">
      {items.map((it, i) => {
        const sel =
          selection?.diskNumber === disk.number &&
          selection.kind === it.kind &&
          selection.offset === it.offset;

        const pick: Selection = {
          diskNumber: disk.number,
          kind: it.kind,
          partitionNumber: it.kind === 'partition' ? it.part.partitionNumber : undefined,
          offset: it.offset,
          size: it.size,
        };

        const cls = [
          'seg',
          it.kind === 'free' ? 'free' : fsClass(it.part),
          sel ? 'sel' : '',
          pending ? 'ghost' : '',
          w[i] < 7 ? 'narrow' : '',
        ].filter(Boolean).join(' ');

        const used = it.kind === 'partition' ? usedFraction(it.part) : null;

        return (
          <div
            key={`${it.kind}-${it.offset}`}
            className={cls}
            style={{ width: `${w[i]}%` }}
            onClick={() => onSelect(pick)}
            onDoubleClick={() => onOpen?.(pick)}
            title={it.kind === 'partition'
              ? `${partLabel(it.part)} — ${fmt(it.size)}`
              : `Unallocated — ${fmt(it.size)}`}
          >
            {it.kind === 'partition' && <>
              <div className="tint" />
              <div className="strip" />
              {used !== null && <div className="used" style={{ width: `${used * 100}%` }} />}
            </>}
            <div className="cap">
              <div className="t">{it.kind === 'partition' ? partLabel(it.part) : 'Unallocated'}</div>
              <div className="s">{fmt(it.size)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
