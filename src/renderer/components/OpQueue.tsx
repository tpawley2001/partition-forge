import React from 'react';
import type { PrecheckInfo } from '../../shared/ipc';
import type { ExecResult, Operation, Plan, ProgressEvent } from '../../shared/types';
import { IconInfo, IconPlay, IconRestart, IconTrash, IconWarn } from './Icons';

interface Props {
  ops: Operation[];
  plan: Plan | null;
  busy: boolean;
  progress: ProgressEvent | null;
  result: ExecResult | null;
  precheck: PrecheckInfo | null;
  onRemove: (id: string) => void;
  onClear: () => void;
  onApply: () => void;
  onReboot: () => void;
}

export function OpQueue({ ops, plan, busy, progress, result, precheck, onRemove, onClear, onApply, onReboot }: Props) {
  const blockers = plan?.blockers ?? [];
  const warnings = plan?.warnings ?? [];
  const planned = plan?.operations ?? [];

  return (
    <aside className="side">
      <div className="side-head">
        <h2>Pending operations</h2>
        <div style={{ flex: 1 }} />
        {ops.length > 0 && !busy && (
          <button className="ghost sm" onClick={onClear}>Clear</button>
        )}
      </div>

      <div className="side-body">
        {ops.length === 0 && !result && (
          <div className="empty">
            Nothing queued.<br />
            Select a partition or an unallocated area, then choose an action.
            <br /><br />
            Changes are collected here and nothing touches the disk until you press Apply.
          </div>
        )}

        {result && (
          <div className={`note ${result.ok ? 'info' : 'danger'}`}>
            {result.ok ? <IconInfo /> : <IconWarn />}
            <span>{result.message}</span>
          </div>
        )}

        {blockers.map((b, i) => (
          <div className="note danger" key={`b${i}`}><IconWarn /><span>{b}</span></div>
        ))}
        {warnings.map((w, i) => (
          <div className={`note ${w.severity === 'danger' ? 'danger' : w.severity === 'warn' ? 'warn' : 'info'}`} key={`w${i}`}>
            {w.severity === 'info' ? <IconInfo /> : <IconWarn />}
            <span>{w.message}</span>
          </div>
        ))}

        {/* Staging is known to be impossible (Secure Boot, no ESP, …): say so
            next to the queue instead of after the online phase has run. */}
        {plan?.requiresReboot && precheck && !precheck.canStage && !result && (
          <div className="note danger">
            <IconWarn />
            <span>
              The restart-required operations cannot be staged on this machine:
              <ul className="reasons">
                {precheck.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </span>
          </div>
        )}

        {ops.map((op, i) => {
          const p = planned.find((x) => x.id === op.id);
          const status = p?.status ?? op.status;
          const running = busy && progress?.opId === op.id;
          return (
            <div className={`op ${status}${running ? ' running' : ''}`} key={op.id}>
              <div className="n">{i + 1}</div>
              <div className="txt">
                <div className="d">{op.description}</div>
                {p?.engine === 'offline' && (
                  <div className="why">Runs during a restart. {p.engineReason ?? ''}</div>
                )}
                {p?.runAfterReboot && <div className="why">{p.engineReason}</div>}
                {running && <div className="why">{progress!.message}</div>}
                {p?.error && <div className="err">{p.error}</div>}
              </div>
              {!busy && (
                <button className="ghost sm" title="Remove" onClick={() => onRemove(op.id)}><IconTrash /></button>
              )}
            </div>
          );
        })}
      </div>

      <div className="side-foot">
        {busy && progress && (
          <>
            <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{progress.message.replace(/^\d+\/\d+:\s*/, '')}</div>
            <div className="progress"><i style={{ width: `${progress.percent}%` }} /></div>
          </>
        )}

        {result?.stagedOffline ? (
          <button className="primary" onClick={onReboot}>
            <IconRestart /> Restart now to finish
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || ops.length === 0 || !plan || plan.operations.length !== ops.length
              || plan.operations.some((p, i) => p.id !== ops[i]?.id) || blockers.length > 0
              || !!(plan.requiresReboot && (!precheck || !precheck.canStage))}
            onClick={onApply}
          >
            <IconPlay />
            {busy ? 'Working…' : `Apply ${ops.length || ''} operation${ops.length === 1 ? '' : 's'}`}
          </button>
        )}

        {plan?.requiresReboot && !result && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
            Some of these need the disks unmounted. Applying will stage them and ask you to restart.
          </div>
        )}
      </div>
    </aside>
  );
}
