import type {
  Disk, Operation, OpKind, Partition, Plan, Warning,
  ResizeParams, MoveParams, CreateParams, ConvertParams, LetterParams,
} from '../../shared/types';
import { alignDown, alignUp, computeFreeRegions, firstUsableOffset, lastUsableOffset, MIB } from './disks';
import { validateOperations } from './validation';

/** MBR addresses sectors with 32 bits: 2^32 * 512 B. */
export const MBR_MAX_ADDRESSABLE = 2199023255552;
export const MBR_MAX_PRIMARY = 4;

const GIB = 1024 * MIB;

function findDisk(disks: Disk[], n: number): Disk | undefined {
  return disks.find((d) => d.number === n);
}
function findPart(disks: Disk[], d: number, p: number): Partition | undefined {
  return findDisk(disks, d)?.partitions.find((x) => x.partitionNumber === p);
}

/* ------------------------------------------------------------------ *
 * Simulation — apply the queue to a throwaway copy so the disk map can
 * render the pending layout before anything is written.
 * ------------------------------------------------------------------ */

export function simulate(disks: Disk[], ops: Operation[]): Disk[] {
  validateOperations(ops);
  const copy: Disk[] = JSON.parse(JSON.stringify(disks));
  let synthetic = Math.max(999, ...copy.flatMap(d => d.partitions.map(p => p.partitionNumber))) + 1;

  for (const op of ops) {
    const disk = findDisk(copy, (op.target as { diskNumber: number }).diskNumber);
    if (!disk) continue;

    switch (op.kind) {
      case 'resize': {
        const t = op.target as { partitionNumber: number };
        const p = disk.partitions.find((x) => x.partitionNumber === t.partitionNumber);
        const prm = op.params as ResizeParams;
        if (!p) break;
        p.size = prm.newSize;
        if (prm.newOffset !== undefined) p.offset = prm.newOffset;
        if (p.volume) {
          const used = p.volume.size - p.volume.sizeRemaining;
          p.volume.size = prm.newSize;
          p.volume.sizeRemaining = Math.max(0, prm.newSize - used);
        }
        break;
      }
      case 'move': {
        const t = op.target as { partitionNumber: number };
        const p = disk.partitions.find((x) => x.partitionNumber === t.partitionNumber);
        if (p) p.offset = (op.params as MoveParams).newOffset;
        break;
      }
      case 'delete': {
        const t = op.target as { partitionNumber: number };
        disk.partitions = disk.partitions.filter((x) => x.partitionNumber !== t.partitionNumber);
        break;
      }
      case 'create': {
        const prm = op.params as CreateParams;
        disk.partitions.push({
          diskNumber: disk.number,
          partitionNumber: synthetic++,
          driveLetter: prm.driveLetter,
          offset: prm.offset,
          size: prm.size,
          typeName: 'Basic',
          gptType: disk.partitionStyle === 'GPT' ? (prm.gptType ?? '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}') : null,
          mbrType: disk.partitionStyle === 'MBR' ? (prm.mbrType ?? 0x07) : null,
          isBoot: false, isSystem: false, isActive: false, isHidden: false,
          guid: null,
          volume: prm.fileSystem && prm.fileSystem !== 'unformatted'
            ? { fileSystem: prm.fileSystem, label: prm.label, size: prm.size, sizeRemaining: prm.size, health: 'Healthy', uniqueId: '' }
            : null,
        });
        break;
      }
      case 'format': {
        const t = op.target as { partitionNumber: number };
        const p = disk.partitions.find((x) => x.partitionNumber === t.partitionNumber);
        const prm = op.params as { fileSystem: string; label: string };
        if (p) {
          p.volume = { fileSystem: prm.fileSystem, label: prm.label, size: p.size, sizeRemaining: p.size, health: 'Healthy', uniqueId: p.volume?.uniqueId ?? '' };
        }
        break;
      }
      case 'label': {
        const t = op.target as { partitionNumber: number };
        const p = disk.partitions.find((x) => x.partitionNumber === t.partitionNumber);
        if (p?.volume) p.volume.label = (op.params as { label: string }).label;
        break;
      }
      case 'letter': {
        const t = op.target as { partitionNumber: number };
        const p = disk.partitions.find((x) => x.partitionNumber === t.partitionNumber);
        if (p) p.driveLetter = (op.params as LetterParams).driveLetter;
        break;
      }
      case 'convertTable': {
        disk.partitionStyle = (op.params as ConvertParams).to;
        break;
      }
      case 'setActive': {
        const t = op.target as { partitionNumber: number };
        disk.partitions.forEach((x) => { x.isActive = x.partitionNumber === t.partitionNumber; });
        break;
      }
      case 'wipe': {
        if (op.target.kind === 'partition') {
          const pn = op.target.partitionNumber;
          const p = disk.partitions.find(x => x.partitionNumber === pn);
          if (p) p.volume = null;
        }
        break;
      }
    }
    disk.partitions.sort((a, b) => a.offset - b.offset);
    disk.free = computeFreeRegions(disk);
  }
  return copy;
}

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

export function planOperations(disks: Disk[], requested: Operation[]): Plan {
  const warnings: Warning[] = [];
  const blockers: string[] = [];
  const operations: Operation[] = [];
  try { validateOperations(requested); } catch (e) {
    return { operations, warnings, requiresReboot: false, blockers: [(e as Error).message] };
  }

  // Each op is validated against the layout it will actually meet, i.e. with
  // every earlier op in the queue already applied.
  let state = disks;

  for (const [idx, op] of requested.entries()) {
    const staged: Operation = { ...op, engine: 'online', engineReason: undefined, runAfterReboot: undefined, status: 'pending', error: undefined };
    const diskNumber = (op.target as { diskNumber: number }).diskNumber;
    const disk = findDisk(state, diskNumber);

    if (!disk) {
      blockers.push(`Operation ${idx + 1} targets disk ${diskNumber}, which is no longer present.`);
      continue;
    }
    if (disk.isReadOnly) blockers.push(`Disk ${disk.number} is read-only; clear the read-only flag first.`);
    if (disk.isOffline) blockers.push(`Disk ${disk.number} is offline; bring it online before editing it.`);
    if (disk.partitionStyle === 'RAW' && op.kind !== 'convertTable' && op.kind !== 'wipe') {
      blockers.push(`Disk ${disk.number} has no partition table. Convert it to GPT or MBR first.`);
    }

    const part = op.target.kind === 'partition'
      ? findPart(state, diskNumber, op.target.partitionNumber)
      : undefined;

    if (op.target.kind === 'partition' && !part) {
      blockers.push(`Operation ${idx + 1} targets a partition that no longer exists (disk ${diskNumber}, partition ${op.target.partitionNumber}).`);
      continue;
    }
    if (part && !findPart(disks, diskNumber, part.partitionNumber)) {
      blockers.push('Apply newly created partitions before queuing further changes to them.');
      continue;
    }

    // Validate the actual geometry passed to both engines, including combined
    // resize+move requests. Never check rounded values then execute raw ones.
    if (op.kind === 'resize' || op.kind === 'move' || op.kind === 'create') {
      const prm = op.params as CreateParams & ResizeParams & MoveParams;
      const start = op.kind === 'create' ? prm.offset : (prm.newOffset ?? part!.offset);
      const size = op.kind === 'create' ? prm.size : op.kind === 'resize' ? prm.newSize : part!.size;
      const end = start + size;
      const sector = disk.sectorSize || 512;
      if (!Number.isSafeInteger(end) || start % sector || size % sector || size < MIB
        || start < firstUsableOffset(disk) || end > lastUsableOffset(disk)) {
        blockers.push(`Operation ${idx + 1} has unaligned geometry or falls outside the usable area of disk ${disk.number}.`);
        continue;
      }
      if (disk.partitions.some(p => p !== part && start < p.offset + p.size && end > p.offset)) {
        blockers.push(`Operation ${idx + 1} would overlap another partition on disk ${disk.number}.`);
        continue;
      }
      if (disk.partitionStyle === 'MBR' && end > MBR_MAX_ADDRESSABLE) {
        blockers.push(`MBR cannot address the requested partition end on disk ${disk.number}.`);
      }
    }

    switch (op.kind) {
      /* -------------------------------------------------- resize */
      case 'resize': {
        const prm = op.params as ResizeParams;
        const p = part!;

        if (prm.newSize < MIB) {
          blockers.push(`Cannot resize ${describe(p)} below 1 MiB.`);
          break;
        }
        // Growing to the left, or any offset change, is a move plus a resize.
        const movesStart = prm.newOffset !== undefined && prm.newOffset !== p.offset;
        if (movesStart) {
          staged.engine = 'offline';
          staged.engineReason = 'Changing the start of a partition means relocating its data, which Windows cannot do while it is mounted.';
        }

        // Growing: the space immediately after must be free.
        if (prm.newSize > p.size && !movesStart) {
          const growBy = prm.newSize - p.size;
          const gapAfter = disk.free.find((g) => g.offset === p.offset + p.size);
          if (!gapAfter || gapAfter.size < growBy) {
            blockers.push(`${describe(p)} cannot grow by ${fmt(growBy)} — there is only ${fmt(gapAfter?.size ?? 0)} of unallocated space directly after it.`);
            break;
          }
        }

        // Shrinking past what Windows will do online means immovable files
        // (page file, hibernation, MFT extents) sit in the tail.
        if (prm.newSize < p.size && p.supportedSizeMin !== undefined && prm.newSize < p.supportedSizeMin) {
          staged.engine = 'offline';
          staged.engineReason = `Windows will only shrink this volume to ${fmt(p.supportedSizeMin)} online because immovable system files sit near its end. The offline engine can relocate them.`;
        }
        if (p.supportedSizeMin === undefined || p.supportedSizeMax === undefined
          || prm.newSize > p.supportedSizeMax) {
          staged.engine = 'offline';
          staged.engineReason = 'Windows has not reported support for this resize; it requires an unmounted filesystem.';
        }
        if (p.volume && prm.newSize < p.volume.size - p.volume.sizeRemaining) {
          blockers.push(`${describe(p)} holds ${fmt(p.volume.size - p.volume.sizeRemaining)} of data; it cannot shrink to ${fmt(prm.newSize)}.`);
        }
        if (!p.volume && prm.newSize < p.size) {
          blockers.push(`${describe(p)} has no recognised filesystem. Shrinking it could truncate data and is refused.`);
        }
        break;
      }

      /* ---------------------------------------------------- move */
      case 'move': {
        const prm = op.params as MoveParams;
        const p = part!;
        staged.engine = 'offline';
        staged.engineReason = 'Windows has no online move; the data must be relocated with the volume unmounted.';

        const newEnd = prm.newOffset + p.size;
        if (prm.newOffset < firstUsableOffset(disk) || newEnd > lastUsableOffset(disk)) {
          blockers.push(`Moving ${describe(p)} to ${fmt(prm.newOffset)} would place it outside the usable area of the disk.`);
          break;
        }
        const collides = disk.partitions.some((o) =>
          o.partitionNumber !== p.partitionNumber &&
          prm.newOffset < o.offset + o.size && newEnd > o.offset);
        if (collides) blockers.push(`Moving ${describe(p)} to ${fmt(prm.newOffset)} would overlap another partition.`);
        if (p.isSystem || p.isBoot) {
          warnings.push({ severity: 'danger', message: `${describe(p)} is part of the Windows boot chain. Moving it rewrites boot references; the offline engine repairs the BCD afterwards, but keep recovery media to hand.` });
        }
        break;
      }

      /* -------------------------------------------------- create */
      case 'create': {
        const prm = op.params as CreateParams;
        if (prm.fileSystem === 'FAT32' && prm.size > 32 * GIB) {
          staged.engine = 'offline';
          staged.engineReason = 'FAT32 volumes larger than 32 GiB have to be created outside the Windows formatter.';
        }
        const start = alignUp(prm.offset);
        const end = alignDown(prm.offset + prm.size);

        if (end - start < MIB) {
          blockers.push(`The requested partition is smaller than 1 MiB after alignment.`);
          break;
        }
        if (start < firstUsableOffset(disk) || end > lastUsableOffset(disk)) {
          blockers.push(`The requested partition falls outside the usable area of disk ${disk.number}.`);
          break;
        }
        const collides = disk.partitions.some((o) => start < o.offset + o.size && end > o.offset);
        if (collides) { blockers.push(`The requested partition overlaps an existing partition on disk ${disk.number}.`); break; }

        if (disk.partitionStyle === 'MBR') {
          if (disk.partitions.length >= MBR_MAX_PRIMARY) {
            blockers.push(`Disk ${disk.number} uses an MBR table, which holds at most ${MBR_MAX_PRIMARY} primary partitions. Convert it to GPT to add more.`);
          }
          if (end > MBR_MAX_ADDRESSABLE) {
            blockers.push(`MBR cannot address past ${fmt(MBR_MAX_ADDRESSABLE)}. Convert disk ${disk.number} to GPT to use the whole drive.`);
          }
        }
        if (prm.driveLetter && letterTaken(state, prm.driveLetter)) {
          blockers.push(`Drive letter ${prm.driveLetter}: is already in use.`);
        }
        break;
      }

      /* -------------------------------------------------- delete */
      case 'delete': {
        const p = part!;
        if (p.isSystem) { blockers.push(`${describe(p)} holds the running Windows installation and cannot be deleted from inside it.`); break; }
        if (p.isBoot)   { blockers.push(`${describe(p)} is the active boot partition for this machine. Deleting it leaves the system unbootable.`); break; }
        const used = p.volume ? p.volume.size - p.volume.sizeRemaining : 0;
        warnings.push({
          severity: 'danger',
          message: p.volume
            ? `Deleting ${describe(p)} destroys ${fmt(used)} of data on ${p.volume.label || 'an unlabelled volume'}.`
            : `Deleting ${describe(p)} destroys its contents.`,
        });
        break;
      }

      /* -------------------------------------------------- format */
      case 'format': {
        const p = part!;
        if (p.isSystem) { blockers.push(`${describe(p)} holds the running Windows installation and cannot be formatted from inside it.`); break; }
        if (p.isBoot)   { blockers.push(`${describe(p)} is the active boot partition. Formatting it leaves the system unbootable.`); break; }
        const prm = op.params as { fileSystem: string; quick: boolean };
        if (prm.fileSystem === 'FAT32' && p.size > 32 * GIB) {
          warnings.push({ severity: 'warn', message: `Windows' own formatter refuses FAT32 above 32 GiB. PartitionForge will format ${describe(p)} with its offline engine instead.` });
          staged.engine = 'offline';
          staged.engineReason = 'FAT32 volumes larger than 32 GiB have to be created outside the Windows formatter.';
        }
        warnings.push({ severity: 'danger', message: `Formatting ${describe(p)} erases everything on it.` });
        break;
      }

      /* -------------------------------------------- convertTable */
      case 'convertTable': {
        const prm = op.params as ConvertParams;
        if (disk.partitionStyle === prm.to) { blockers.push(`Disk ${disk.number} already uses ${prm.to}.`); break; }
        if (disk.partitions.length > 0) {
          blockers.push('Conversion of a populated disk is unavailable until disk identity and boot repair are supported.');
          staged.engine = 'offline';
          staged.engineReason = 'Windows can only switch partition style on an empty disk. The offline engine rewrites the table in place, keeping the partitions.';
        }
        if (prm.to === 'MBR') {
          if (disk.size > MBR_MAX_ADDRESSABLE) {
            warnings.push({ severity: 'danger', message: `Disk ${disk.number} is ${fmt(disk.size)}. Under MBR everything past ${fmt(MBR_MAX_ADDRESSABLE)} becomes unreachable.` });
          }
          if (disk.partitions.length > MBR_MAX_PRIMARY) {
            blockers.push(`Disk ${disk.number} has ${disk.partitions.length} partitions; MBR holds at most ${MBR_MAX_PRIMARY}.`);
          }
        }
        if (disk.isSystem || disk.isBoot) {
          warnings.push({ severity: 'danger', message: `Disk ${disk.number} boots this machine. Converting its partition style also requires the firmware to switch between UEFI and legacy BIOS mode — check that your firmware supports the target mode before applying.` });
        }
        break;
      }

      /* ---------------------------------------------------- misc */
      case 'setActive': {
        if (disk.partitionStyle !== 'MBR') {
          blockers.push('The active flag only exists on MBR disks; GPT firmware finds the boot loader without it.');
          break;
        }
        if (part!.isActive) { blockers.push(`${describe(part!)} is already the active partition.`); break; }
        warnings.push({ severity: 'warn', message: `Marking ${describe(part!)} active tells the firmware to boot from it. If it does not contain boot files, the machine will not start.` });
        break;
      }
      case 'letter': {
        const prm = op.params as LetterParams;
        if (prm.driveLetter && prm.driveLetter !== part?.driveLetter && letterTaken(state, prm.driveLetter)) {
          blockers.push(`Drive letter ${prm.driveLetter}: is already in use.`);
        }
        if (part?.isSystem) blockers.push('The drive letter of the running Windows volume cannot be changed.');
        break;
      }
      case 'wipe': {
        const p = part!;
        if (p.isSystem || p.isBoot) { blockers.push(`${describe(p)} is in use by the running system and cannot be wiped.`); break; }
        staged.engine = 'offline';
        staged.engineReason = 'Secure erase writes every sector and must run with the volume unmounted.';
        warnings.push({ severity: 'danger', message: `Wiping ${describe(p)} overwrites its addressable sectors and destroys its contents. Remapped SSD cells and snapshots may retain copies.` });
        break;
      }
    }

    operations.push(staged);
    state = simulate(state, [staged]);
  }

  // Ordering guard. Operations on one disk have to happen in the order the
  // user queued them, so once anything on a disk is deferred to the reboot,
  // everything queued behind it on that same disk is deferred too. Disks are
  // independent of each other, so the cascade is per-disk, not global.
  const OFFLINE_INCAPABLE: OpKind[] = ['letter'];
  const deferredDisks = new Set<number>();
  for (const op of operations) {
    const dn = (op.target as { diskNumber: number }).diskNumber;
    if (op.engine === 'offline') { deferredDisks.add(dn); continue; }
    if (!deferredDisks.has(dn)) continue;

    if (OFFLINE_INCAPABLE.includes(op.kind)) {
      op.runAfterReboot = true;
      op.engineReason = 'Drive letters are assigned by Windows, so this runs automatically once the machine has restarted.';
      continue; // stays online; runAfterReboot is the deferral, not the offline engine
    } else {
      op.engine = 'offline';
      op.engineReason = `An earlier operation on disk ${dn} has to run during the reboot, and operations on a disk must keep their order.`;
    }
  }

  for (const op of operations.filter(o => o.engine === 'offline' || o.runAfterReboot)) {
    const d = findDisk(disks, op.target.diskNumber)!;
    if (d.sectorSize !== 512) blockers.push('The offline engine currently supports only disks with 512-byte logical sectors.');
    if ((d.isBoot || d.isSystem) && (op.kind === 'move' || op.kind === 'convertTable'
      || (op.kind === 'resize' && (op.params as ResizeParams).newOffset !== undefined))) {
      blockers.push('Moving partitions on the boot disk is unavailable until boot-reference repair is implemented.');
    }
    if (op.engine === 'offline' && op.kind === 'resize') {
      const p = findPart(disks, d.number, (op.target as { partitionNumber: number }).partitionNumber);
      if (!p?.volume || !['NTFS', 'ext2', 'ext3', 'ext4'].includes(p.volume.fileSystem)) {
        blockers.push('Offline filesystem resizing supports NTFS and ext filesystems only.');
      }
    }
    if (op.engine === 'offline' && (op.kind === 'format' || op.kind === 'create')) {
      const prm = op.params as CreateParams & { quick?: boolean; allocationUnit?: number };
      if (prm.fileSystem === 'ReFS') blockers.push('The offline engine cannot format ReFS.');
      if (op.kind === 'create' && prm.driveLetter) blockers.push('Offline creation cannot assign drive letters. Choose no letter, then assign one after restarting.');
      if (op.kind === 'format' && (prm.quick === false || prm.allocationUnit !== undefined)) blockers.push('The offline formatter supports quick format with default allocation size only.');
    }
    if (op.runAfterReboot) blockers.push('Assign drive letters after the offline job finishes; automatic deferred assignment is currently unavailable.');
  }

  const touchesSystemDisk = operations.some((o) => {
    const d = findDisk(disks, (o.target as { diskNumber: number }).diskNumber);
    return !!d && (d.isSystem || d.isBoot);
  });
  const anyOffline = operations.some((o) => o.engine === 'offline' || o.runAfterReboot);

  if (anyOffline) {
    warnings.push({
      severity: 'info',
      message: `${operations.filter((o) => o.engine === 'offline').length} operation(s) cannot run while Windows is using these disks. PartitionForge will stage them and carry them out during a reboot, before Windows starts.`,
    });
  }
  if (touchesSystemDisk) {
    warnings.push({ severity: 'warn', message: 'This queue changes the disk your system boots from. Back up anything you cannot lose before applying.' });
  }

  return { operations, warnings, requiresReboot: anyOffline, blockers: dedupe(blockers) };
}

/* ---------------------------------------------------------- helpers */

function letterTaken(disks: Disk[], letter: string): boolean {
  const L = letter.replace(':', '').toUpperCase();
  return disks.some((d) => d.partitions.some((p) => (p.driveLetter ?? '').toUpperCase() === L));
}

function describe(p: Partition): string {
  if (p.driveLetter) return `${p.driveLetter}:`;
  if (p.volume?.label) return `"${p.volume.label}"`;
  return `partition ${p.partitionNumber} on disk ${p.diskNumber}`;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function fmt(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = v < 10 && i > 1 ? 2 : v < 100 && i > 1 ? 1 : 0;
  return `${(bytes < 0 ? -v : v).toFixed(digits)} ${units[i]}`;
}
