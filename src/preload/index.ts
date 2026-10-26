import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, type DbCatzApi, type DbCatzSettings, type DvAiProgress, type DvConnectProgress, type DvJob, type DvUpdateState } from '@shared/types';

const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`dbcatz:${m}`, ...args)])) as unknown as DbCatzApi;

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  // One listener that throws (e.g. returns a value the context bridge cannot clone) must not stop the others.
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(`${channel} listener failed:`, e);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const bridge = {
  ...api,
  /** A connection to open (or focus) in a tab — from a dbcatz:// link or DevCatz. */
  onViewerOpen: (cb: (target: { connId: string | null; db: string | null; table: string | null; col: string | null; val: string | null }) => void) => on('viewer:open', cb),
  /** Menu bar / context menu commands. */
  onViewerCommand: (cb: (cmd: { command: string; table?: string }) => void) => on('viewer:command', cb),
  /** Jobs (export, import, backup) as they progress. */
  onViewerJobs: (cb: (jobs: DvJob[]) => void) => on('viewer:jobs', cb),
  /** Steps of a connection attempt (test or connect) as it runs. */
  onViewerProgress: (cb: (p: DvConnectProgress) => void) => on('viewer:progress', cb),
  /** The settings changed outside the window (DevCatz changed the shared theme / AI connection). */
  onSettings: (cb: (s: DbCatzSettings) => void) => on('viewer:settings', cb),
  /** Steps of a running Ask AI request. */
  onAiProgress: (cb: (p: DvAiProgress) => void) => on('viewer:aiProgress', cb),
  /** Connections changed: opened / closed, or DevCatz's services file was rewritten. */
  onViewerChanged: (cb: () => void) => on('viewer:changed', cb),
  /** In-app updates: every state change (checking, available, progress, downloaded, error). */
  onUpdate: (cb: (s: DvUpdateState) => void) => on('viewer:update', cb),
  /** Show the update dialog (the notification or the app menu's Update Available…). */
  onUpdateOpen: (cb: () => void) => on('viewer:updateOpen', cb),
  /** The first error while Send crash reports was never answered: ask once. */
  onReportsAsk: (cb: () => void) => on('viewer:reportsAsk', cb),
};

export type DbCatzBridge = typeof bridge;

contextBridge.exposeInMainWorld('dbcatz', bridge);
