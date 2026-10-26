const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planOperations, simulate } = require('../dist/main/storage/planner');
const { buildOfflineJob, applyPlan } = require('../dist/main/storage/ops');
const { MIB, computeFreeRegions } = require('../dist/main/storage/disks');
const { assertSnapshotUnchanged } = require('../dist/main/storage/validation');

function disk() {
  const d = { number: 0, size: 2048 * MIB, sectorSize: 512, partitionStyle: 'GPT', diskGuid: 'test-guid',
    partitions: [part(1, 1, 512), part(2, 1024, 512)] };
  d.free = computeFreeRegions(d);
  return d;
}
function part(n, offset, size) {
  return { diskNumber: 0, partitionNumber: n, offset: offset * MIB, size: size * MIB, driveLetter: n === 1 ? 'D' : 'E',
    supportedSizeMin: 128 * MIB, supportedSizeMax: 1023 * MIB,
    volume: { fileSystem: 'NTFS', size: size * MIB, sizeRemaining: (size - 100) * MIB } };
}
function op(kind, params = {}, extra = {}) {
  return { id: 'op-1', kind, target: { kind: 'partition', diskNumber: 0, partitionNumber: 1 },
    params, description: 'Test operation', status: 'pending', engine: 'online', ...extra };
}
function plan(operation, d = disk()) { return planOperations([d], [operation]); }

test('rejects malformed IPC values without crashing the planner', () => {
  for (const value of [null, {}, [null], [op('resize', { newSize: NaN })], [op('move', { newOffset: Infinity })],
    [op('delete', {}, { target: { kind: 'disk', diskNumber: 0 } })], [op('surprise')], [op('wipe', { passes: -1 })]]) {
    assert.ok(planOperations([disk()], value).blockers.length);
  }
  assert.ok(planOperations([disk()], [op('delete'), op('delete')]).blockers.length);
});
test('combined resize and move cannot overlap neighbours or leave the disk', () => {
  for (const params of [{ newSize: 700 * MIB, newOffset: 500 * MIB }, { newSize: 900 * MIB, newOffset: 1600 * MIB },
    { newSize: 256 * MIB, newOffset: 0 }, { newSize: 256 * MIB + 1 }]) {
    assert.ok(plan(op('resize', params)).blockers.length);
  }
});
test('valid online resize remains online and preserves the used byte count', () => {
  const operation = op('resize', { newSize: 256 * MIB });
  assert.deepEqual(plan(operation).blockers, []);
  assert.equal(plan(operation).operations[0].engine, 'online');
  const p = simulate([disk()], [operation])[0].partitions[0];
  assert.equal(p.volume.size - p.volume.sizeRemaining, 100 * MIB);
});
test('renderer cannot inject deferral or execution status', () => {
  const p = plan(op('label', { label: 'Data' }, { runAfterReboot: true, status: 'done', error: 'fake' }));
  assert.equal(p.operations[0].runAfterReboot, undefined);
  assert.equal(p.operations[0].status, 'pending');
  assert.equal(p.operations[0].error, undefined);
});
test('setting an existing letter on the same partition is allowed', () => {
  assert.deepEqual(plan(op('letter', { driveLetter: 'D' })).blockers, []);
  assert.ok(plan(op('letter', { driveLetter: 'E' })).blockers.length);
});
test('synthetic partitions stay unique across incremental simulation', () => {
  const create = (id, offset) => op('create', { offset: offset * MIB, size: 32 * MIB, fileSystem: 'NTFS', label: '', driveLetter: null },
    { id, target: { kind: 'free', diskNumber: 0, offset: offset * MIB, size: 32 * MIB } });
  const ops = [create('new-1', 600), create('new-2', 700)];
  let state = [disk()];
  for (const operation of ops) state = simulate(state, [operation]);
  assert.equal(new Set(state[0].partitions.map(p => p.partitionNumber)).size, 4);
  assert.deepEqual(planOperations([disk()], ops).blockers, []);
  assert.ok(planOperations([disk()], [...ops, op('delete', {}, { target: { kind: 'partition', diskNumber: 0, partitionNumber: 1000 } })]).blockers.length);
});
test('unsupported offline paths are blocked', () => {
  let d = disk();
  d.isBoot = true;
  assert.ok(plan(op('move', { newOffset: 600 * MIB }), d).blockers.length);
  d = disk(); d.sectorSize = 4096;
  assert.ok(plan(op('move', { newOffset: 600 * MIB }), d).blockers.length);
  assert.ok(plan(op('convertTable', { to: 'MBR' }, { target: { kind: 'disk', diskNumber: 0 } })).blockers.length);
  d = disk(); d.partitions[0].volume = null;
  assert.ok(plan(op('resize', { newSize: 256 * MIB }), d).blockers.length);
});
test('offline jobs resolve each source against preceding geometry changes', () => {
  const operations = [op('resize', { newSize: 256 * MIB }), op('move', { newOffset: 600 * MIB }, { id: 'op-2', engine: 'offline' })];
  const job = buildOfflineJob([disk()], operations);
  assert.equal(job.operations[0].partition.offset, MIB);
  assert.equal(job.operations[0].partition.size, 256 * MIB);
  assert.equal(job.operations[0].params.newOffset, 600 * MIB);
});
test('hotplug identity changes and external layout changes invalidate a queue', () => {
  const original = disk();
  assert.doesNotThrow(() => assertSnapshotUnchanged([original], [disk()], [op('delete')]));
  for (const change of [d => d.diskGuid = 'replacement', d => d.partitions[0].size += MIB,
    d => d.partitions[0].guid = 'replacement-partition']) {
    const current = disk(); change(current);
    assert.throws(() => assertSnapshotUnchanged([original], [current], [op('delete')]), /changed/);
  }
});
test('offline preflight failure prevents all online writes in a mixed queue', async () => {
  const ps = require('../dist/main/storage/powershell');
  const paths = require('../dist/main/paths');
  const originalRun = ps.runScript;
  const originalDir = paths.offlineAssetDir;
  const calls = [];
  paths.offlineAssetDir = () => '/tmp/partitionforge-test';
  ps.runScript = async name => { calls.push(name); return { canStage: false, reasons: ['No engine'] }; };
  try {
    const operations = [op('label', { label: 'Data' }), op('move', { newOffset: 600 * MIB }, { id: 'move', engine: 'offline' })];
    const result = await applyPlan([disk()], { operations, blockers: [] }, () => {});
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['offline-precheck.ps1']);
  } finally { ps.runScript = originalRun; paths.offlineAssetDir = originalDir; }
});
test('staging failure preserves online completion status for review', async () => {
  const ps = require('../dist/main/storage/powershell');
  const paths = require('../dist/main/paths');
  const originalRun = ps.runScript;
  const originalDir = paths.offlineAssetDir;
  paths.offlineAssetDir = () => '/tmp/partitionforge-test';
  ps.runScript = async name => {
    if (name === 'offline-precheck.ps1') return { canStage: true };
    if (name === 'apply.ps1') return { aborted: false, results: [{ id: 'op-1', status: 'done' }] };
    throw new Error('Staging failed');
  };
  try {
    const operations = [op('label', { label: 'Data' }), op('move', { newOffset: 600 * MIB }, { id: 'move', engine: 'offline' })];
    const result = await applyPlan([disk()], { operations, blockers: [] }, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.operations[0].status, 'done');
    assert.match(result.message, /some changes may already have completed/);
  } finally { ps.runScript = originalRun; paths.offlineAssetDir = originalDir; }
});
