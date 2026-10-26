import type { Partition } from '../../shared/types';

export function fmt(bytes: number, digitsOverride?: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = digitsOverride ?? (v < 10 && i > 1 ? 2 : v < 100 && i > 1 ? 1 : 0);
  return `${(bytes < 0 ? -v : v).toFixed(d)} ${units[i]}`;
}

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

/** Colour family per filesystem, so the map reads at a glance. */
export function fsClass(p: Partition): string {
  if (p.isSystem) return 'fs-system';
  const g = (p.gptType ?? '').toLowerCase();
  if (g.includes('c12a7328')) return 'fs-efi';
  if (g.includes('e3c9e316')) return 'fs-reserved';
  if (g.includes('de94bba4')) return 'fs-recovery';
  const fs = (p.volume?.fileSystem ?? '').toUpperCase();
  if (fs === 'NTFS') return 'fs-ntfs';
  if (fs.startsWith('FAT')) return 'fs-fat';
  if (fs === 'EXFAT') return 'fs-exfat';
  if (fs === 'REFS') return 'fs-refs';
  if (fs.startsWith('EXT')) return 'fs-ext';
  return 'fs-raw';
}

export function partLabel(p: Partition): string {
  const bits: string[] = [];
  if (p.driveLetter) bits.push(`${p.driveLetter}:`);
  if (p.volume?.label) bits.push(p.volume.label);
  if (!bits.length) bits.push(p.typeName || 'Partition');
  return bits.join('  ');
}

export function usedFraction(p: Partition): number | null {
  if (!p.volume || p.volume.size <= 0) return null;
  return (p.volume.size - p.volume.sizeRemaining) / p.volume.size;
}

export function alignUp(b: number, a = MIB) { return Math.ceil(b / a) * a; }
export function alignDown(b: number, a = MIB) { return Math.floor(b / a) * a; }
export function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
