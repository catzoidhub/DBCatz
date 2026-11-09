import { execFile, spawn } from 'node:child_process';
import { app, shell } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which build of a Catzoid app fits this computer, and where a sibling app lives (Catzoid family rule, user
 * 2026-10-27; the same shape as DevCatz's src/main/companion.ts): every install, update or link picks the build by
 * platform AND architecture — Windows `<App>-Setup-<v>.exe`, Mac Apple silicon `<App>-<v>-arm64.dmg`, Mac Intel
 * `<App>-<v>-x64.dmg`, site links `<site>/download/<app>/<platform>` — and says so when there is none, never another
 * platform's file.
 */

const isWin = process.platform === 'win32';
/** Linux (TODO §18): AppImages in ~/Applications or a .deb's /opt/<App>, as DevCatz's and DoCatz's companion.ts. */
const isLinux = process.platform === 'linux';

/** The site's platform id for this computer (mac-arm64, mac-x64, win-x64), or null when no Catzoid build exists for it. */
export function platformId(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (process.platform === 'darwin' && arch) return `mac-${arch}`;
  if (isWin && arch === 'x64') return 'win-x64';
  if (isLinux && arch) return `linux-${arch}`;
  return null;
}

/** "Mac (Apple silicon)", "Mac (Intel)", "Windows" — or this computer's own name when there is no build for it. */
export function platformLabel(): string {
  const id = platformId();
  if (id === 'mac-arm64') return 'Mac (Apple silicon)';
  if (id === 'mac-x64') return 'Mac (Intel)';
  if (id === 'win-x64') return 'Windows';
  if (id === 'linux-arm64') return 'Linux (ARM64)';
  if (id === 'linux-x64') return 'Linux (x64)';
  return `${process.platform} ${process.arch}`;
}

/** A release asset of `name` for this computer, or null when there is no build for it. */
export function platformAsset(name: string): { pattern: RegExp; label: string } | null {
  const id = platformId();
  if (!id) return null;
  if (id === 'win-x64') return { pattern: new RegExp(`^${name}-Setup-.*\\.exe$`), label: 'Windows' };
  if (id.startsWith('linux-')) return { pattern: new RegExp(`^${name}-.*-${id.slice(6)}\\.AppImage$`), label: platformLabel() };
  const arch = id === 'mac-arm64' ? 'arm64' : 'x64';
  return { pattern: new RegExp(`^${name}-.*-${arch}\\.dmg$`), label: platformLabel() };
}

/**
 * Where a Catzoid app is installed by default: /Applications on a Mac, the per-user NSIS folder on Windows; on Linux
 * the AppImage in ~/Applications (where the apps install themselves and each other), or a .deb's /opt/<App>.
 */
export function catzoidAppPaths(name: string): string[] {
  if (isLinux) return [join(homedir(), 'Applications', `${name}.AppImage`), `/opt/${name}/${name.toLowerCase()}`, `/opt/${name}/${name}`];
  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return [join(local, 'Programs', name, `${name}.exe`), join(process.env.ProgramFiles ?? 'C:\\Program Files', name, `${name}.exe`)];
  }
  return [`/Applications/${name}.app`, join(homedir(), 'Applications', `${name}.app`)];
}

/**
 * Finds a Catzoid app: the usual folders, the app that opens its links (`scheme://`), then (macOS) Spotlight by
 * bundle id. Null when it is not installed.
 */
export async function findCatzoidApp(name: string, scheme: string, bundleId: string): Promise<string | null> {
  const usable = (p: string | null | undefined): p is string =>
    !!p && (isWin ? /\.exe$/i.test(p) && existsSync(p) : !p.includes('/.Trash/') && existsSync(join(p, 'Contents', 'Info.plist')));
  const known = catzoidAppPaths(name).find((p) => existsSync(p));
  if (known) return known;
  if (isLinux) return null;
  const handler = await app.getApplicationInfoForProtocol(`${scheme}://open`).catch(() => null);
  if (usable(handler?.path) && new RegExp(name, 'i').test(handler.path)) return handler.path;
  if (isWin) return null;
  const out = await new Promise<string>((resolve) => execFile('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 10_000 }, (_e, stdout) => resolve(String(stdout ?? ''))));
  return out.split('\n').map((l) => l.trim()).find(usable) ?? null;
}

/** Opens a Catzoid app at a link: `open -a` on a Mac (that very copy), the program with the link on Windows / Linux. */
export async function openCatzoidApp(path: string, link: string): Promise<void> {
  if (isWin || isLinux) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(path, [link], { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => (child.unref(), resolve(true)));
    });
    if (!ok) await shell.openExternal(link);
    return;
  }
  const ok = await new Promise<boolean>((resolve) => execFile('open', ['-a', path, link], { timeout: 30_000 }, (e) => resolve(!e)));
  if (!ok) await shell.openExternal(link);
}
