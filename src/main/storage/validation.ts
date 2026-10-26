import type { Disk, Operation } from '../../shared/types';

const kinds = new Set(['resize', 'move', 'create', 'delete', 'format', 'label', 'letter', 'setActive', 'convertTable', 'wipe']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const letter = (v: unknown) => v === null || (typeof v === 'string' && /^[A-Z]$/.test(v));
const label = (v: unknown) => typeof v === 'string' && v.length <= 32 && !/[\x00-\x1f]/.test(v);
const filesystems = new Set(['NTFS', 'FAT32', 'exFAT', 'ReFS']);

/** IPC carries untrusted JavaScript values, regardless of its TypeScript signature. */
export function validateOperations(input: unknown): asserts input is Operation[] {
  if (!Array.isArray(input) || input.length > 256) throw new Error('The queue must contain at most 256 operations.');
  const ids = new Set<string>();
  for (const [i, op] of input.entries()) {
    const fail = () => { throw new Error(`Operation ${i + 1} has invalid parameters or a mismatched target.`); };
    if (!record(op) || typeof op.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(op.id) || ids.has(op.id)
      || typeof op.kind !== 'string' || !kinds.has(op.kind) || typeof op.description !== 'string' || op.description.length > 2048
      || !record(op.target) || !integer(op.target.diskNumber) || !record(op.params)) fail();
    const { kind, target: t, params: p } = op as Operation;
    ids.add(op.id);
    const expected = kind === 'create' ? 'free' : kind === 'convertTable' ? 'disk' : 'partition';
    if (t.kind !== expected || (t.kind === 'partition' && !integer(t.partitionNumber, 1))
      || (t.kind === 'free' && (!integer(t.offset) || !integer(t.size, 1)))) fail();
    const prm = p as Record<string, unknown>;
    switch (kind) {
      case 'resize': if (!integer(prm.newSize, 1) || (prm.newOffset !== undefined && !integer(prm.newOffset))) fail(); break;
      case 'move': if (!integer(prm.newOffset)) fail(); break;
      case 'create':
        if (!integer(prm.offset) || !integer(prm.size, 1) || !label(prm.label) || !letter(prm.driveLetter)
          || !(filesystems.has(prm.fileSystem as string) || prm.fileSystem === 'unformatted')
          || (prm.gptType !== undefined && (typeof prm.gptType !== 'string' || !/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(prm.gptType)))
          || (prm.mbrType !== undefined && (!integer(prm.mbrType, 1) || prm.mbrType > 255))) fail();
        break;
      case 'format':
        if (!filesystems.has(prm.fileSystem as string) || !label(prm.label) || typeof prm.quick !== 'boolean'
          || (prm.allocationUnit !== undefined && (!integer(prm.allocationUnit, 512) || prm.allocationUnit > 2 ** 21 || !Number.isInteger(Math.log2(prm.allocationUnit))))) fail();
        break;
      case 'label': if (!label(prm.label)) fail(); break;
      case 'letter': if (!letter(prm.driveLetter)) fail(); break;
      case 'convertTable': if (prm.to !== 'GPT' && prm.to !== 'MBR') fail(); break;
      case 'wipe': if (!integer(prm.passes, 1) || prm.passes > 7) fail(); break;
    }
  }
}

/** Disk numbers alone are reusable after hotplug, and partition sizes can change. */
export function assertSnapshotUnchanged(before: Disk[], after: Disk[], ops: Operation[]) {
  validateOperations(ops);
  for (const n of new Set(ops.map(op => op.target.diskNumber))) {
    const a = before.find(d => d.number === n);
    const b = after.find(d => d.number === n);
    const fingerprint = (d: Disk) => JSON.stringify([
      d.diskGuid, d.diskSignature, d.serialNumber, d.size, d.partitionStyle,
      d.partitions.map(p => [p.partitionNumber, p.offset, p.size, p.guid, p.volume?.uniqueId]),
    ]);
    if (!a || !b || fingerprint(a) !== fingerprint(b)) {
      throw new Error(`Disk ${n} changed since it was displayed. Refresh and build a new queue.`);
    }
  }
}
