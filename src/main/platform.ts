import { homedir } from 'node:os';
import { join } from 'node:path';

/** The OS DBCatz runs on, for the main process (the renderer and shared code use @shared/platform). */
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
/** Linux (TODO §18, as DevCatz and DoCatz): a branch reads `isWin ? win : isLinux ? linux : mac`, never the macOS path. */
export const isLinux = process.platform === 'linux';

/**
 * A Catzoid app's data folder (or the family's, `Catzoid`), where that app writes it: %APPDATA% on Windows,
 * $XDG_CONFIG_HOME or ~/.config on Linux, ~/Library/Application Support on macOS — Electron's userData for each app.
 */
export function appDataDir(name: string): string {
  if (isWin) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name);
  if (isLinux) return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name);
  return join(homedir(), 'Library', 'Application Support', name);
}
