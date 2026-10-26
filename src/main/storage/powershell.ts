import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { psScriptDir } from '../paths';

export class PowerShellError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message);
    this.name = 'PowerShellError';
  }
}

/**
 * Windows PowerShell 5.1 formats *redirected* pipeline output through
 * Out-String, which hard-wraps at the host width and inserts newlines into
 * long JSON payloads. So every script writes its result to a UTF-8 temp file
 * (-OutFile) and we read that instead of trusting stdout. stdout is kept for
 * progress lines only, which are short and wrap-safe.
 */
export interface RunOptions {
  /** Extra -Name Value pairs passed to the script's param() block. */
  args?: Record<string, string | number | boolean | null>;
  /** Called for each `PROGRESS <percent> <message>` line the script emits. */
  onProgress?: (percent: number, message: string) => void;
  timeoutMs?: number;
}

const PS_EXE = 'powershell.exe';

export async function runScript<T>(scriptName: string, opts: RunOptions = {}): Promise<T> {
  const outFile = path.join(os.tmpdir(), `pf-${randomUUID()}.json`);
  const script = path.join(psScriptDir(), scriptName);

  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-OutFile', outFile,
  ];
  for (const [k, v] of Object.entries(opts.args ?? {})) {
    if (v === null || v === undefined) continue;
    argv.push(`-${k}`);
    // Booleans map to PowerShell switch semantics via an explicit $true/$false.
    argv.push(typeof v === 'boolean' ? (v ? '$true' : '$false') : String(v));
  }

  return new Promise<T>((resolve, reject) => {
    const child = spawn(PS_EXE, argv, { windowsHide: true });
    let stderr = '';
    let stdoutTail = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill(); reject(new PowerShellError(`${scriptName} timed out`, stderr, null)); }, opts.timeoutMs)
      : null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-4096);
      for (const line of chunk.split(/\r?\n/)) {
        const m = /^PROGRESS\s+(\d+)\s+(.*)$/.exec(line.trim());
        if (m && opts.onProgress) opts.onProgress(Number(m[1]), m[2]);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { stderr += c; });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new PowerShellError(`Failed to launch PowerShell: ${err.message}`, stderr, null));
    });

    child.on('close', async (code) => {
      if (timer) clearTimeout(timer);
      let raw: string | null = null;
      try { raw = await fs.readFile(outFile, 'utf8'); } catch { /* script died before writing */ }
      fs.unlink(outFile).catch(() => {});

      if (raw) {
        // Strip a UTF-8 BOM if one slipped in.
        const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        try {
          const parsed = JSON.parse(text) as { ok: boolean; error?: string; data?: T };
          if (parsed.ok) return resolve(parsed.data as T);
          return reject(new PowerShellError(parsed.error ?? 'Script reported failure', stderr, code));
        } catch (e) {
          return reject(new PowerShellError(
            `Could not parse output of ${scriptName}: ${(e as Error).message}`, stderr || stdoutTail, code));
        }
      }
      reject(new PowerShellError(
        `${scriptName} exited ${code} without producing a result`, stderr || stdoutTail, code));
    });
  });
}

/** True when the current process holds an elevated token. */
export async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const r = await runScript<{ elevated: boolean }>('elevation.ps1', { timeoutMs: 15000 });
    return r.elevated;
  } catch {
    return false;
  }
}
