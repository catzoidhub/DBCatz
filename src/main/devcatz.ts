import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DevCatzService, DevCatzServicesFile } from '@shared/types';

/**
 * DevCatz integration: DevCatz writes the database services it manages to
 * services.json in its data folder (owner-only file); DBCatz lists them as
 * "DevCatz services" and follows the file while it changes. Nothing here
 * talks to DevCatz directly — the file is the whole contract.
 */

export const SERVICES_FILE = process.env.DBCATZ_SERVICES_FILE || join(homedir(), 'Library', 'Application Support', 'DevCatz', 'dbcatz', 'services.json');
const APP_PATHS = ['/Applications/DevCatz.app', join(homedir(), 'Applications', 'DevCatz.app')];
const BUNDLE_ID = 'com.mrcatz.devcatz';

const usable = (p: string | null | undefined): p is string => !!p && !p.includes('/.Trash/') && existsSync(join(p, 'Contents', 'Info.plist'));

export class DevCatzServices {
  private services: DevCatzService[] = [];
  private mtime = 0;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  onChange: () => void = () => undefined;

  constructor() {
    this.read();
    this.follow();
  }

  /**
   * The DevCatz app bundle wherever it lives — /Applications, ~/Applications or
   * any other folder (a build output, Downloads): the usual places first, then
   * the app Launch Services opens devcatz:// links with, then Spotlight by bundle id.
   */
  static async locate(): Promise<string | null> {
    const known = APP_PATHS.find((p) => existsSync(p));
    if (known) return known;
    const handler = await app.getApplicationInfoForProtocol('devcatz://db').catch(() => null);
    if (usable(handler?.path) && /DevCatz/i.test(handler.path)) return handler.path;
    const out = await new Promise<string>((resolve) => execFile('mdfind', [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`], { timeout: 10_000 }, (_e, stdout) => resolve(String(stdout ?? ''))));
    return out.split('\n').map((l) => l.trim()).find(usable) ?? null;
  }

  /** DevCatz is on this Mac: its app was found, or it has written a services file (even an empty one). */
  async installed(): Promise<boolean> {
    return existsSync(SERVICES_FILE) || (await DevCatzServices.locate()) !== null;
  }

  list(): DevCatzService[] {
    return this.services;
  }

  private read(): boolean {
    try {
      if (!existsSync(SERVICES_FILE)) {
        const had = this.services.length > 0;
        this.services = [];
        this.mtime = 0;
        return had;
      }
      const m = statSync(SERVICES_FILE).mtimeMs;
      if (m === this.mtime) return false;
      this.mtime = m;
      const f = JSON.parse(readFileSync(SERVICES_FILE, 'utf8')) as DevCatzServicesFile;
      this.services = Array.isArray(f.services) ? f.services.filter((s) => s && typeof s.id === 'string') : [];
      return true;
    } catch (e) {
      console.warn('DevCatz services.json could not be read:', (e as Error).message);
      return false;
    }
  }

  /** fs.watch on the folder (the file is replaced atomically), plus a slow poll for the first write. */
  private follow(): void {
    const dir = dirname(SERVICES_FILE);
    const arm = () => {
      if (this.watcher || !existsSync(dir)) return;
      try {
        this.watcher = watch(dir, { persistent: false }, () => {
          if (this.read()) this.onChange();
        });
        this.watcher.on('error', () => {
          this.watcher?.close();
          this.watcher = null;
        });
      } catch {
        this.watcher = null;
      }
    };
    arm();
    this.timer = setInterval(() => {
      arm();
      if (this.read()) this.onChange();
    }, 5000);
  }

  close(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }
}
