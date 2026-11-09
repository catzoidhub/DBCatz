import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DevCatzService, DevCatzServicesFile } from '@shared/types';
import { findCatzoidApp } from './companion';
import { appDataDir } from './platform';

/**
 * DevCatz and DoCatz integration: each writes the database services it runs to
 * dbcatz/services.json in its data folder (owner-only file); DBCatz lists them
 * as "DevCatz services" / "DoCatz services" and follows the file while it
 * changes. Nothing here talks to the apps directly — the file is the whole
 * contract.
 */

/** An app's data folder: ~/Library/Application Support/<App>, %APPDATA%\\<App>, ~/.config/<App> on Linux. */
const dataDir = (app: string) => appDataDir(app);

export type ServicesApp = 'DevCatz' | 'DoCatz';
const APPS: Record<ServicesApp, { scheme: string; bundleId: string; env: string }> = {
  DevCatz: { scheme: 'devcatz', bundleId: 'com.mrcatz.devcatz', env: 'DBCATZ_SERVICES_FILE' },
  DoCatz: { scheme: 'docatz', bundleId: 'com.mrcatz.docatz', env: 'DBCATZ_DOCATZ_SERVICES_FILE' },
};

export class AppServices {
  private services: DevCatzService[] = [];
  private mtime = 0;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;
  onChange: () => void = () => undefined;

  constructor(readonly app: ServicesApp) {
    this.file = process.env[APPS[app].env] || join(dataDir(app), 'dbcatz', 'services.json');
    this.read();
    this.follow();
  }

  /**
   * The app wherever it lives — /Applications or ~/Applications on a Mac, the per-user install folder on
   * Windows, else the app that opens its links, else (Mac) Spotlight by bundle id (companion.ts).
   */
  locate(): Promise<string | null> {
    return findCatzoidApp(this.app, APPS[this.app].scheme, APPS[this.app].bundleId);
  }

  /** The app is on this computer: it was found, or it has written a services file (even an empty one). */
  async installed(): Promise<boolean> {
    return existsSync(this.file) || (await this.locate()) !== null;
  }

  list(): DevCatzService[] {
    return this.services;
  }

  /** Reads the file now instead of at the next change or poll. */
  refresh(): void {
    if (this.read()) this.onChange();
  }

  private read(): boolean {
    try {
      if (!existsSync(this.file)) {
        const had = this.services.length > 0;
        this.services = [];
        this.mtime = 0;
        return had;
      }
      const m = statSync(this.file).mtimeMs;
      if (m === this.mtime) return false;
      this.mtime = m;
      const f = JSON.parse(readFileSync(this.file, 'utf8')) as DevCatzServicesFile;
      this.services = Array.isArray(f.services) ? f.services.filter((s) => s && typeof s.id === 'string') : [];
      return true;
    } catch (e) {
      console.warn(`${this.app} services.json could not be read:`, (e as Error).message);
      return false;
    }
  }

  /** fs.watch on the folder (the file is replaced atomically), plus a slow poll for the first write. */
  private follow(): void {
    const dir = dirname(this.file);
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
