import type { Disk, FreeRegion, Partition } from '../../shared/types';
import { runScript } from './powershell';
import { mockDisks } from '../mock/fixtures';

export const MIB = 1024 * 1024;
/** Windows aligns every partition it creates to a 1 MiB boundary. */
export const ALIGNMENT = MIB;
/** Gaps smaller than this are alignment slack, not usable space. */
const MIN_USABLE_GAP = MIB;

const GPT_TYPE_NAMES: Record<string, string> = {
  'c12a7328-f81f-11d2-ba4b-00a0c93ec93b': 'EFI System',
  'e3c9e316-0b5c-4db8-817d-f92df00215ae': 'Microsoft Reserved',
  'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7': 'Basic data',
  'de94bba4-06d1-4d40-a16a-bfd50179d6ac': 'Windows Recovery',
  '5808c8aa-7e8f-42e0-85d2-e1e90434cfb3': 'LDM metadata',
  'af9b60a0-1431-4f62-bc68-3311714a69ad': 'LDM data',
  '21686148-6449-6e6f-744e-656564454649': 'BIOS boot',
  '0fc63daf-8483-4772-8e79-3d69d8477de4': 'Linux filesystem',
  '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f': 'Linux swap',
  'e6d6d379-f507-44c2-a23c-238f2a3df928': 'Linux LVM',
  '933ac7e1-2eb4-4f13-b844-0e14e2aef915': 'Linux /home',
  '48465300-0000-11aa-aa11-00306543ecac': 'Apple HFS+',
  '7c3457ef-0000-11aa-aa11-00306543ecac': 'Apple APFS',
};

const MBR_TYPE_NAMES: Record<number, string> = {
  0x01: 'FAT12', 0x04: 'FAT16 <32M', 0x05: 'Extended', 0x06: 'FAT16',
  0x07: 'NTFS / exFAT', 0x0b: 'FAT32', 0x0c: 'FAT32 (LBA)', 0x0e: 'FAT16 (LBA)',
  0x0f: 'Extended (LBA)', 0x11: 'Hidden FAT12', 0x12: 'OEM / Recovery',
  0x27: 'Windows Recovery', 0x42: 'Dynamic disk', 0x82: 'Linux swap',
  0x83: 'Linux', 0x8e: 'Linux LVM', 0xa5: 'FreeBSD', 0xee: 'GPT protective',
  0xef: 'EFI System', 0xfd: 'Linux RAID',
};

/** Normalises whatever Windows reported into a display label. */
export function partitionTypeLabel(p: Partition): string {
  if (p.gptType) {
    const key = p.gptType.replace(/[{}]/g, '').toLowerCase();
    const named = GPT_TYPE_NAMES[key];
    if (named) return named;
  }
  if (p.mbrType !== null && p.mbrType !== undefined) {
    const named = MBR_TYPE_NAMES[p.mbrType];
    if (named) return named;
    return `MBR type 0x${p.mbrType.toString(16).padStart(2, '0')}`;
  }
  return p.typeName || 'Unknown';
}

export function alignUp(bytes: number, alignment = ALIGNMENT): number {
  return Math.ceil(bytes / alignment) * alignment;
}
export function alignDown(bytes: number, alignment = ALIGNMENT): number {
  return Math.floor(bytes / alignment) * alignment;
}

/**
 * First byte a partition may occupy. GPT keeps its primary header plus a
 * 128-entry table in the first 34 sectors; Windows then aligns to 1 MiB, and
 * MBR disks conventionally start at the same place.
 */
export function firstUsableOffset(disk: Disk): number {
  return ALIGNMENT;
}

/**
 * Last byte + 1 a partition may occupy. GPT mirrors its header and table in
 * the final 33 sectors, so those are off limits.
 */
export function lastUsableOffset(disk: Disk): number {
  const sector = disk.sectorSize || 512;
  const reserved = disk.partitionStyle === 'GPT' ? 33 * sector : 0;
  return alignDown(disk.size - reserved);
}

/** Derives the unallocated gaps Windows never reports as objects. */
export function computeFreeRegions(disk: Disk): FreeRegion[] {
  const start = firstUsableOffset(disk);
  const end = lastUsableOffset(disk);
  if (end <= start) return [];

  const sorted = [...disk.partitions].sort((a, b) => a.offset - b.offset);
  const gaps: FreeRegion[] = [];
  let cursor = start;

  for (const p of sorted) {
    if (p.offset > cursor) gaps.push({ offset: cursor, size: p.offset - cursor });
    cursor = Math.max(cursor, p.offset + p.size);
  }
  if (end > cursor) gaps.push({ offset: cursor, size: end - cursor });

  return gaps.filter((g) => g.size >= MIN_USABLE_GAP);
}

const useMock = () => process.env.PF_MOCK === '1' || process.platform !== 'win32';

export async function listDisks(): Promise<Disk[]> {
  const raw = useMock()
    ? mockDisks()
    : (await runScript<{ disks: Disk[] }>('enumerate.ps1', { timeoutMs: 120_000 })).disks;

  return raw.map((d) => {
    const disk: Disk = {
      ...d,
      partitions: d.partitions.map(p => ({ ...p,
        supportedSizeMin: p.supportedSizeMin ?? undefined,
        supportedSizeMax: p.supportedSizeMax ?? undefined,
      })).sort((a, b) => a.offset - b.offset),
      free: [],
    };
    disk.free = computeFreeRegions(disk);
    return disk;
  });
}

/**
 * Fills in the online resize limits Windows reports for one partition. They
 * are not part of the disk list because computing them costs ~30 s per large
 * NTFS volume; the Resize dialog asks for them, and Apply re-asks before
 * planning. A partition Windows will not resize online keeps both undefined.
 */
export async function loadSupportedSize(part: Partition): Promise<{ min?: number; max?: number }> {
  if (!useMock()) {
    const r = await runScript<{ sizeMin: number | null; sizeMax: number | null }>('supported-size.ps1', {
      args: { DiskNumber: part.diskNumber, PartitionNumber: part.partitionNumber },
      timeoutMs: 5 * 60_000,
    });
    part.supportedSizeMin = r.sizeMin ?? undefined;
    part.supportedSizeMax = r.sizeMax ?? undefined;
  }
  return { min: part.supportedSizeMin, max: part.supportedSizeMax };
}
