import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Disk, ExecResult, Operation, Plan, ProgressEvent } from '../../shared/types';
import { runScript } from './powershell';
import { simulate } from './planner';
import { offlineAssetDir } from '../paths';

const ENGINE = 'pfengine.efi';

export interface PrecheckResult {
  firmware: string;
  isUefi: boolean;
  secureBoot: boolean;
  espFound: boolean;
  espSize: number;
  espFree: number;
  espLetter: string | null;
  engineBytes: number;
  canStage: boolean;
  jobPending?: boolean;
  reasons: string[];
}

const enginePath = () => path.join(offlineAssetDir(), ENGINE);

export async function offlinePrecheck(): Promise<PrecheckResult> {
  return runScript<PrecheckResult>('offline-precheck.ps1', {
    args: { EnginePath: enginePath() },
    timeoutMs: 120_000,
  });
}

/**
 * Translates queued operations into the identity-based form the offline engine
 * understands. It cannot use Windows disk numbers or partition numbers: after
 * the reboot the disks are enumerated by a different kernel under different
 * names, so targets are pinned to the GPT/MBR identifier written on the platter
 * and to byte offsets, resolved against the state each op will actually meet.
 */
export function buildOfflineJob(disks: Disk[], ops: Operation[]) {
  let state = disks;
  const out: unknown[] = [];

  for (const op of ops) {
    const diskNumber = (op.target as { diskNumber: number }).diskNumber;
    const disk = state.find((d) => d.number === diskNumber);

    if (op.engine === 'offline') {
      if (!disk) throw new Error(`Disk ${diskNumber} vanished while the queue was being prepared.`);
      const id = disk.diskGuid ?? disk.diskSignature;
      if (!id) {
        throw new Error(
          `Disk ${diskNumber} has no GPT identifier or MBR signature, so it cannot be matched reliably after a reboot.`);
      }

      let partition: { offset: number; size: number } | undefined;
      if (op.target.kind === 'partition') {
        const partNumber = op.target.partitionNumber;
        const p = disk.partitions.find((x) => x.partitionNumber === partNumber);
        if (!p) throw new Error(`Partition ${partNumber} on disk ${diskNumber} is no longer present.`);
        // Snapshot the geometry this op will actually meet — i.e. before the
        // op itself is simulated. A resize+move carries its new offset in
        // params, so reading the partition after simulate() would hand the
        // engine the destination as the source.
        partition = { offset: p.offset, size: p.size };
      }

      const params: Record<string, unknown> = { ...(op.params as Record<string, unknown>) };
      // sfdisk takes a bare GUID for GPT and a hex byte for MBR.
      if (op.kind === 'create') {
        const gpt = params.gptType as string | undefined;
        const mbr = params.mbrType as number | undefined;
        params.typeCode = disk.partitionStyle === 'GPT'
          ? (gpt ?? 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7').replace(/[{}]/g, '').toUpperCase()
          : `0x${(mbr ?? 0x07).toString(16)}`;
      }

      out.push({
        id: op.id,
        kind: op.kind,
        description: op.description,
        disk: { id: id.toLowerCase(), size: disk.size },
        partition,
        params,
      });
    }

    state = simulate(state, [op]);
  }

  return { version: 1, createdAt: new Date().toISOString(), operations: out };
}

async function writeTempJson(data: unknown): Promise<string> {
  const p = path.join(os.tmpdir(), `pf-job-${randomUUID()}.json`);
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

export async function applyPlan(
  disks: Disk[],
  plan: Plan,
  onProgress: (e: ProgressEvent) => void,
): Promise<ExecResult> {
  if (plan.blockers.length) {
    return { ok: false, operations: plan.operations, message: plan.blockers[0], stagedOffline: false };
  }

  const ops = plan.operations.map((o) => ({ ...o }));
  const onlineNow = ops.filter((o) => o.engine === 'online' && !o.runAfterReboot);
  const offline   = ops.filter((o) => o.engine === 'offline');
  const afterBoot = ops.filter((o) => o.runAfterReboot);

  if (afterBoot.length) return { ok: false, operations: ops, message: 'Assign drive letters manually after restarting.', stagedOffline: false };

  try {
    // Resolve identities and staging prerequisites before any online mutation.
    const job = offline.length ? buildOfflineJob(disks, ops) : null;
    const pre = await offlinePrecheck();
    if (pre.jobPending) return { ok: false, operations: ops, message: 'An offline job is already staged. Restart to finish it before applying another queue.', stagedOffline: true };
    if (offline.length && !pre.canStage) return { ok: false, operations: ops, message: pre.reasons.join(' '), stagedOffline: false };

    // apply.ps1 announces each operation with a "PROGRESS <pct> <n>/<total>: …"
    // line; the counter is how progress is attributed to the queue entry.
    let currentOnline = 0;

    // --- phase 1: whatever Windows can do right now -------------------------
    if (onlineNow.length) {
      const jobPath = await writeTempJson({ operations: onlineNow });
      try {
        const res = await runScript<{ results: { id: string; status: string; error: string | null }[]; aborted: boolean }>(
          'apply.ps1',
          {
            args: { JobFile: jobPath },
            timeoutMs: 30 * 60_000,
            onProgress: (percent, message) => {
              const m = /^(\d+)\/(\d+):\s*(.*)$/.exec(message);
              if (m) currentOnline = Number(m[1]) - 1;
              onProgress({ opId: onlineNow[currentOnline]?.id ?? '', percent, message });
            },
          },
        );
        for (const r of res.results) {
          const op = ops.find((o) => o.id === r.id);
          if (!op) continue;
          op.status = r.status as Operation['status'];
          if (r.error) op.error = r.error;
        }
        if (res.aborted) {
          return {
            ok: false,
            operations: ops,
            message: 'An operation failed, so the rest of the queue was left untouched.',
            stagedOffline: false,
          };
        }
      } finally {
        fs.unlink(jobPath).catch(() => {});
      }
    }

    if (!offline.length && !afterBoot.length) {
      return { ok: true, operations: ops, message: 'All operations completed.', stagedOffline: false };
    }

    // --- phase 2: stage the rest for the reboot -----------------------------
    // The offline job is built against the layout *before* this run, replaying
    // the online phase in simulation, so its byte offsets match what the engine
    // will find on disk.
    const jobPath = await writeTempJson(job);
    try {
      onProgress({ opId: '', percent: 0, message: 'Staging the offline engine' });
      await runScript<{ bootEntry: string; espLetter: string; armed: boolean }>('stage-offline.ps1', {
        args: { EnginePath: enginePath(), JobPath: jobPath },
        timeoutMs: 10 * 60_000,
        onProgress: (percent, message) => onProgress({ opId: '', percent, message }),
      });
    } finally {
      fs.unlink(jobPath).catch(() => {});
    }

    for (const op of [...offline, ...afterBoot]) {
      const o = ops.find((x) => x.id === op.id);
      if (o) o.status = 'pending';
    }

    return {
      ok: true,
      operations: ops,
      message: `${offline.length} operation(s) are staged. Restart to let PartitionForge carry them out before Windows starts.`,
      stagedOffline: true,
    };
  } catch (e) {
    return {
      ok: false, operations: ops, stagedOffline: false,
      message: `${(e as Error).message} Inspect the refreshed disk layout before building a new queue; some changes may already have completed.`,
    };
  }
}

/** Reads back what the offline engine did, if anything, after a reboot. */
export async function collectOfflineResult(): Promise<{
  found: boolean;
  jobPending?: boolean;
  aborted?: boolean;
  results?: { id: string; status: string; error: string }[];
} | null> {
  if (process.platform !== 'win32') return null;
  try {
    const logDest = path.join(app.getPath('userData'), 'last-offline-run.log');
    const r = await runScript<{ found: boolean; jobPending?: boolean; payload?: string }>(
      'collect-offline.ps1', { args: { LogDest: logDest }, timeoutMs: 120_000 });
    if (!r.found) return { found: false, jobPending: r.jobPending };
    const parsed = JSON.parse(r.payload ?? '{}');
    return { found: true, aborted: !!parsed.aborted, results: parsed.results ?? [] };
  } catch {
    return null;
  }
}

export async function rebootNow(): Promise<void> {
  const { spawn } = await import('node:child_process');
  spawn('shutdown.exe', ['/r', '/t', '3', '/c', 'PartitionForge is restarting to apply disk changes.'], {
    windowsHide: true, detached: true, stdio: 'ignore',
  }).unref();
}
