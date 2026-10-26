import type { Disk, ExecResult, Operation, Plan, ProgressEvent } from './types';

export interface OfflineOutcome {
  found: boolean;
  jobPending?: boolean;
  aborted?: boolean;
  results?: { id: string; status: string; error: string }[];
}

export interface AppInfo {
  version: string;
  platform: string;
  elevated: boolean;
  mock: boolean;
}

export interface PrecheckInfo {
  canStage: boolean;
  reasons: string[];
  secureBoot: boolean;
  isUefi: boolean;
  espFound: boolean;
  espFree: number;
  engineBytes: number;
}

export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  version: string;
  available?: string;
  percent?: number;
  error?: string;
}

/** The surface exposed on window.pf by the preload bridge. */
export interface PfApi {
  getInfo(): Promise<AppInfo>;
  listDisks(): Promise<Disk[]>;
  /** Windows' online resize limits for one partition; slow (tens of seconds). */
  supportedSize(diskNumber: number, partitionNumber: number): Promise<{ min?: number; max?: number }>;
  plan(ops: Operation[]): Promise<Plan>;
  preview(ops: Operation[]): Promise<Disk[]>;
  apply(ops: Operation[]): Promise<ExecResult>;
  offlinePrecheck(): Promise<PrecheckInfo>;
  collectOffline(): Promise<OfflineOutcome | null>;
  reboot(): Promise<void>;
  onProgress(cb: (e: ProgressEvent) => void): () => void;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(cb: (s: UpdateState) => void): () => void;
}

export const CH = {
  info: 'pf:info',
  list: 'pf:list',
  supportedSize: 'pf:supported-size',
  plan: 'pf:plan',
  preview: 'pf:preview',
  apply: 'pf:apply',
  precheck: 'pf:precheck',
  collect: 'pf:collect',
  reboot: 'pf:reboot',
  progress: 'pf:progress',
  updateState: 'pf:update-state',
  updateCheck: 'pf:update-check',
  updateInstall: 'pf:update-install',
  updateStatus: 'pf:update-status',
} as const;
