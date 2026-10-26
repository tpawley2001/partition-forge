import type { Disk, Partition } from '../../shared/types';

/**
 * Sample topology used when PF_MOCK=1 or when the app runs off-Windows, so the
 * UI can be developed and reviewed without touching real hardware.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

interface Spec {
  size: number;
  type: string;
  gpt?: string;
  mbr?: number;
  fs?: string;
  label?: string;
  letter?: string;
  usedFraction?: number;
  boot?: boolean;
  system?: boolean;
  hidden?: boolean;
  /** Unallocated bytes to leave *after* this partition. */
  gapAfter?: number;
}

function layout(diskNumber: number, specs: Spec[], style: 'GPT' | 'MBR'): Partition[] {
  const parts: Partition[] = [];
  let offset = MIB;
  let n = 1;
  for (const s of specs) {
    const used = s.fs ? Math.round(s.size * (s.usedFraction ?? 0.4)) : 0;
    parts.push({
      diskNumber,
      partitionNumber: n++,
      driveLetter: s.letter ?? null,
      offset,
      size: s.size,
      typeName: s.type,
      gptType: style === 'GPT' ? (s.gpt ?? '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}') : null,
      mbrType: style === 'MBR' ? (s.mbr ?? 0x07) : null,
      isBoot: !!s.boot,
      isSystem: !!s.system,
      isActive: !!s.boot,
      isHidden: !!s.hidden,
      guid: style === 'GPT' ? `{00000000-0000-0000-0000-${String(diskNumber).padStart(4, '0')}${String(n).padStart(8, '0')}}` : null,
      volume: s.fs
        ? {
            fileSystem: s.fs,
            label: s.label ?? '',
            size: s.size,
            sizeRemaining: s.size - used,
            health: 'Healthy',
            uniqueId: `\\\\?\\Volume{mock-${diskNumber}-${n}}\\`,
          }
        : null,
      // Roughly what Windows reports: NTFS can shrink to used+slack and grow
      // into the space that follows it.
      supportedSizeMin: s.fs === 'NTFS' ? Math.round(used * 1.15) + 64 * MIB : s.size,
      supportedSizeMax: s.size + (s.gapAfter ?? 0),
    });
    offset += s.size + (s.gapAfter ?? 0);
  }
  return parts;
}

export function mockDisks(): Disk[] {
  const d0: Disk = {
    number: 0,
    friendlyName: 'Samsung SSD 990 PRO 1TB',
    serialNumber: 'S6Z1NJ0T512345',
    size: 1000204886016,
    partitionStyle: 'GPT',
    busType: 'NVMe',
    mediaType: 'SSD',
    sectorSize: 512,
    physicalSectorSize: 4096,
    isBoot: true,
    isSystem: true,
    isOffline: false,
    isReadOnly: false,
    health: 'Healthy',
    diskGuid: '8f3a1c2e-4b5d-4e6f-9a01-1122334455aa',
    diskSignature: null,
    partitions: layout(0, [
      { size: 260 * MIB, type: 'System', gpt: '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}', fs: 'FAT32', label: 'SYSTEM', usedFraction: 0.12, boot: true, hidden: true },
      { size: 16 * MIB, type: 'Reserved', gpt: '{e3c9e316-0b5c-4db8-817d-f92df00215ae}', hidden: true },
      { size: 820 * GIB, type: 'Basic', fs: 'NTFS', label: 'Windows', letter: 'C', usedFraction: 0.62, system: true },
      { size: 990 * MIB, type: 'Recovery', gpt: '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}', fs: 'NTFS', label: 'Recovery', usedFraction: 0.55, hidden: true },
    ], 'GPT'),
    free: [],
  };

  const d1: Disk = {
    number: 1,
    friendlyName: 'WDC WD40EZAZ-00SF3B0',
    serialNumber: 'WD-WX32D91KHFV7',
    size: 4000787030016,
    partitionStyle: 'GPT',
    busType: 'SATA',
    mediaType: 'HDD',
    sectorSize: 512,
    physicalSectorSize: 4096,
    isBoot: false,
    isSystem: false,
    isOffline: false,
    isReadOnly: false,
    health: 'Healthy',
    diskGuid: 'c7d9e0f1-2a3b-4c5d-8e9f-aabbccddeeff',
    diskSignature: null,
    partitions: layout(1, [
      { size: 1800 * GIB, type: 'Basic', fs: 'NTFS', label: 'Media', letter: 'D', usedFraction: 0.81, gapAfter: 400 * GIB },
      { size: 900 * GIB, type: 'Basic', fs: 'exFAT', label: 'Backups', letter: 'E', usedFraction: 0.33 },
    ], 'GPT'),
    free: [],
  };

  const d2: Disk = {
    number: 2,
    friendlyName: 'Crucial CT500MX500SSD1',
    serialNumber: '1849E1F4A2B0',
    size: 500107862016,
    partitionStyle: 'MBR',
    busType: 'SATA',
    mediaType: 'SSD',
    sectorSize: 512,
    physicalSectorSize: 512,
    isBoot: false,
    isSystem: false,
    isOffline: false,
    isReadOnly: false,
    health: 'Healthy',
    diskGuid: null,
    diskSignature: 'a1b2c3d4',
    partitions: layout(2, [
      { size: 100 * GIB, type: 'Basic', mbr: 0x07, fs: 'NTFS', label: 'Scratch', letter: 'F', usedFraction: 0.22 },
      { size: 200 * GIB, type: 'Basic', mbr: 0x83, label: 'ubuntu-root' },
    ], 'MBR'),
    free: [],
  };

  const d3: Disk = {
    number: 3,
    friendlyName: 'SanDisk Ultra USB 3.0',
    serialNumber: '4C530001180712107001',
    size: 61505273856,
    partitionStyle: 'MBR',
    busType: 'USB',
    mediaType: 'Unspecified',
    sectorSize: 512,
    physicalSectorSize: 512,
    isBoot: false,
    isSystem: false,
    isOffline: false,
    isReadOnly: false,
    health: 'Healthy',
    diskGuid: null,
    diskSignature: 'de11ad00',
    partitions: layout(3, [
      { size: 57 * GIB, type: 'Basic', mbr: 0x0c, fs: 'FAT32', label: 'USB DRIVE', letter: 'G', usedFraction: 0.08 },
    ], 'MBR'),
    free: [],
  };

  return [d0, d1, d2, d3];
}
