/**
 * Platform words: the OS the app runs on and the words and key labels the UI
 * uses for it, so one build reads right on macOS, Windows and Linux.
 */

export type OS = 'mac' | 'windows' | 'linux';

/** The OS we run on: process.platform in the main process, the user agent in the window. */
export const currentOS: OS = (() => {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'mac' : 'linux';
})();

/** The words UI text uses for things that differ per OS. */
export function wordsFor(os: OS) {
  const mac = os === 'mac';
  const win = os === 'windows';
  return {
    os: mac ? 'macOS' : win ? 'Windows' : 'Linux',
    /** "this Mac" in "kept on this Mac". */
    thisComputer: mac ? 'this Mac' : win ? 'this PC' : 'this computer',
    /** The same words as DevCatz: on Windows the secrets are DPAPI-encrypted for the user. */
    secretStore: mac ? 'Keychain' : win ? "Windows' protected storage (DPAPI)" : 'the system keyring',
    /** Where "the macOS Keychain" is named with its OS. */
    secretStoreFull: mac ? 'macOS Keychain' : win ? "Windows' protected storage (DPAPI)" : 'system keyring',
    /** Where the OS's light / dark choice lives. */
    appearanceSettings: mac ? 'System Settings → Appearance' : win ? 'Settings → Personalization → Colors' : 'the system settings',
    /** The home folder as paths are written on this OS (~ on a Mac, %USERPROFILE% on Windows). */
    home: win ? '%USERPROFILE%\\' : '~/',
    /** The path separator as written on this OS. */
    sep: win ? '\\' : '/',
    fileManager: mac ? 'Finder' : win ? 'File Explorer' : 'the file manager',
    tray: mac ? 'menu bar' : 'system tray',
    revealIn: mac ? 'Reveal in Finder' : win ? 'Show in File Explorer' : 'Show in folder',
    settingsMenu: mac ? 'DBCatz → Settings' : 'File → Settings',
  };
}

export const words = wordsFor(currentOS);

/** A shortcut label: 'mod+shift+P' reads ⌘⇧P on a Mac and Ctrl+Shift+P elsewhere. */
export function keyLabel(combo: string, os: OS = currentOS): string {
  const mac = os === 'mac';
  const names: Record<string, [string, string]> = { mod: ['⌘', 'Ctrl'], shift: ['⇧', 'Shift'], alt: ['⌥', 'Alt'], ctrl: ['⌃', 'Ctrl'], '⏎': ['⏎', 'Enter'], '⌫': ['⌫', 'Backspace'] };
  const parts = combo.split('+').map((p) => { const n = names[p.toLowerCase()]; return n ? n[mac ? 0 : 1] : p; });
  return parts.join(mac ? '' : '+');
}
