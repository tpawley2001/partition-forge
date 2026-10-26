import { app } from 'electron';
import * as path from 'node:path';

/**
 * Packaged builds put the tree under resources/pf (see electron-builder.yml
 * extraResources); in dev it lives next to the sources.
 */
export function resourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'pf')
    : path.join(app.getAppPath(), 'resources');
}

export const psScriptDir = () => path.join(resourceRoot(), 'ps');
export const offlineAssetDir = () => path.join(resourceRoot(), 'offline');
