import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DevCatzService, DevCatzServicesFile } from '@shared/types';
import { findCatzoidApp } from './companion';

/**
 * DevCatz integration: DevCatz writes the database services it manages to
 * services.json in its data folder (owner-only file); DBCatz lists them as
 * "DevCatz services" and follows the file while it changes. Nothing here
 * talks to DevCatz directly — the file is the whole contract.
 */

/** DevCatz's data folder: ~/Library/Application Support/DevCatz on a Mac, %APPDATA%\DevCatz on Windows. */
const DEVCATZ_DATA =
  process.platform === 'win32' ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DevCatz') : join(homedir(), 'Library', 'Application Support', 'DevCatz');
export const SERVICES_FILE = process.env.DBCATZ_SERVICES_FILE || join(DEVCATZ_DATA, 'dbcatz', 'services.json');

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
   * The DevCatz app wherever it lives — /Applications or ~/Applications on a Mac, the per-user install folder on
   * Windows, else the app that opens devcatz:// links, else (Mac) Spotlight by bundle id (companion.ts).
   */
  static locate(): Promise<string | null> {
    return findCatzoidApp('DevCatz', 'devcatz', 'com.mrcatz.devcatz');
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
