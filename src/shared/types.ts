/**
 * Shared domain model. Imported by the Electron main process, the preload
 * bridge and the React renderer, so it must stay dependency-free.
 */

export type PartitionStyle = 'MBR' | 'GPT' | 'RAW';

export interface Volume {
  fileSystem: string;            // NTFS, FAT32, exFAT, ReFS, '' when raw
  label: string;
  size: number;                  // bytes
  sizeRemaining: number;         // bytes free
  health: string;
  uniqueId: string;
}

export interface Partition {
  diskNumber: number;
  partitionNumber: number;
  driveLetter: string | null;
  offset: number;                // bytes from start of disk
  size: number;                  // bytes
  typeName: string;              // human label: Basic data, EFI System, ...
  gptType: string | null;        // {guid} on GPT disks
  mbrType: number | null;        // 0x07, 0x83, ... on MBR disks
  isBoot: boolean;
  isSystem: boolean;
  isActive: boolean;
  isHidden: boolean;
  guid: string | null;
  volume: Volume | null;
  /** Shrink/grow window Windows reports for an online resize. */
  supportedSizeMin?: number;
  supportedSizeMax?: number;
}

/** Synthesised gap between partitions — never returned by Windows directly. */
export interface FreeRegion {
  offset: number;
  size: number;
}

export interface Disk {
  number: number;
  friendlyName: string;
  serialNumber: string;
  size: number;
  partitionStyle: PartitionStyle;
  busType: string;               // NVMe, SATA, USB, RAID...
  mediaType: string;             // SSD, HDD, Unspecified
  sectorSize: number;            // logical sector size
  physicalSectorSize: number;
  isBoot: boolean;               // holds the active boot partition
  isSystem: boolean;             // holds the running Windows install
  isOffline: boolean;
  isReadOnly: boolean;
  health: string;
  /**
   * Cross-OS identity. The offline engine sees a completely different device
   * naming scheme (/dev/nvme0n1 vs disk 0), so disks are matched on what is
   * written to the platter: the GPT header's disk GUID, or the 4-byte MBR
   * signature at offset 0x1B8. Size is checked as a second factor.
   */
  diskGuid: string | null;      // GPT
  diskSignature: string | null; // MBR, hex e.g. "a1b2c3d4"
  partitions: Partition[];
  free: FreeRegion[];
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

export type OpKind =
  | 'resize'
  | 'move'
  | 'create'
  | 'delete'
  | 'format'
  | 'label'
  | 'letter'
  | 'setActive'
  | 'convertTable'
  | 'wipe';

/** Where an operation can physically be carried out. */
export type Engine = 'online' | 'offline';

export interface OpTargetPartition {
  kind: 'partition';
  diskNumber: number;
  partitionNumber: number;
}
export interface OpTargetFree {
  kind: 'free';
  diskNumber: number;
  offset: number;
  size: number;
}
export interface OpTargetDisk {
  kind: 'disk';
  diskNumber: number;
}
export type OpTarget = OpTargetPartition | OpTargetFree | OpTargetDisk;

export interface ResizeParams  { newSize: number; newOffset?: number }
export interface MoveParams    { newOffset: number }
export interface CreateParams  { offset: number; size: number; fileSystem: string; label: string; driveLetter: string | null; gptType?: string; mbrType?: number }
export interface FormatParams  { fileSystem: string; label: string; allocationUnit?: number; quick: boolean }
export interface LabelParams   { label: string }
export interface LetterParams  { driveLetter: string | null }
export interface ConvertParams { to: 'GPT' | 'MBR' }
export interface WipeParams    { passes: number }

export type OpParams =
  | ResizeParams | MoveParams | CreateParams | FormatParams
  | LabelParams  | LetterParams | ConvertParams | WipeParams
  | Record<string, never>;

export interface Operation {
  id: string;
  kind: OpKind;
  target: OpTarget;
  params: OpParams;
  /** Human sentence shown in the pending queue. */
  description: string;
  /** Decided by the planner, not the UI. */
  engine: Engine;
  /** Why the planner forced this offline, when it did. */
  engineReason?: string;
  /**
   * Online, but only once the offline pass has finished — drive letters are a
   * Windows concept the offline engine cannot assign, so an op like that
   * queued behind an offline one waits for the reboot instead.
   */
  runAfterReboot?: boolean;
  /** Set once executed. */
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
}

export type Severity = 'info' | 'warn' | 'danger';

export interface Warning {
  severity: Severity;
  message: string;
}

/** Result of planning the whole queue. */
export interface Plan {
  operations: Operation[];
  warnings: Warning[];
  requiresReboot: boolean;
  /** Hard blocks — execution is refused while any of these exist. */
  blockers: string[];
}

export interface ProgressEvent {
  opId: string;
  percent: number;
  message: string;
}

export interface ExecResult {
  ok: boolean;
  operations: Operation[];
  message: string;
  /** True when the remaining work was staged for the next boot. */
  stagedOffline: boolean;
}
