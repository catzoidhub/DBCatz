import { readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { basename, join } from 'node:path';
import { buildLabel, currentOS } from '@shared/platform';

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

/** The OS version for About and the AI: on Linux the distribution (/etc/os-release, e.g. "Ubuntu 24.04.3 LTS"), not the kernel. */
export function systemVersion(): string {
  const kernel = process.getSystemVersion?.() ?? release();
  if (!isLinux) return kernel;
  try {
    const name = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
    if (name) return `${name} (kernel ${kernel})`;
  } catch {
    /* no os-release */
  }
  return kernel;
}

/**
 * The computer as the AI prompts name it (DevCatz TODO §39: a Linux user got a Mac path): the real OS with its
 * version or distribution and its shell, and that only this OS's commands, apps and paths may be named.
 */
export function aiPlatform(): string {
  const shell = isWin ? 'PowerShell / Command Prompt' : basename(process.env.SHELL || (isMac ? 'zsh' : 'bash'));
  const not = isMac
    ? 'no Windows (C:\\, PowerShell) or Linux-only (apt, systemctl) commands'
    : isWin
      ? 'no macOS (Homebrew, Finder, ⌘, Keychain, /Applications, ~/Library) or Linux (apt, systemctl) commands; Windows paths and Ctrl shortcuts'
      : 'no macOS (Homebrew, Finder, ⌘, Keychain, /Applications, ~/Library) or Windows (C:\\, PowerShell) commands; the distribution\'s own package manager and service commands';
  return `This computer: ${buildLabel(currentOS, process.arch)}, ${systemVersion()}; shell: ${shell}. Name only this system's commands, apps, shortcuts and paths (${not}).`;
}
