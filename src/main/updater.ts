import { app, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { autoUpdater, CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { DvUpdateChannel, DvUpdateSettings, DvUpdateState } from '@shared/types';
import { store } from './store';
import { siteBase } from './shared';
import { platformId } from './companion';

/**
 * In-app updates (Catzoid family TODO #54) with electron-updater. The feed is the Catzoid site's
 * `<shared site address>/updates/dbcatz/` (it serves latest-mac.yml from the newest GitHub release and redirects the
 * zip there); when the site does not answer, the GitHub release itself. Nothing downloads until the user says
 * Update now; a downloaded update installs on Restart now or when DBCatz quits. Squirrel.Mac checks the Developer ID
 * signature before it swaps the app.
 */

const KEY = 'updates';
const FIRST_CHECK = 30_000;
const EVERY = 6 * 60 * 60_000;
const DEFAULTS: DvUpdateSettings = { auto: true, notify: true, channel: 'stable', skipped: '' };

interface Stored extends DvUpdateSettings {
  /** Anonymous install id, sent with update checks (X-Catzoid-Install) for version adoption counts. */
  installId: string;
  /** The version a notification was shown for (once per version). */
  notified: string;
  lastChecked?: number;
}

function stored(): Stored {
  const s = store.extra<Partial<Stored>>(KEY) ?? {};
  const out: Stored = {
    auto: s.auto !== false,
    notify: s.notify !== false,
    channel: s.channel === 'beta' ? 'beta' : 'stable',
    skipped: typeof s.skipped === 'string' ? s.skipped : '',
    installId: typeof s.installId === 'string' && s.installId ? s.installId : randomUUID(),
    notified: typeof s.notified === 'string' ? s.notified : '',
    lastChecked: typeof s.lastChecked === 'number' ? s.lastChecked : undefined,
  };
  if (out.installId !== s.installId) store.setExtra(KEY, out);
  return out;
}
const save = (patch: Partial<Stored>) => store.setExtra(KEY, { ...stored(), ...patch });
/** The anonymous install id (also on crash / feedback reports). */
export const installId = () => stored().installId;
export const updateChannel = (): DvUpdateChannel => stored().channel;


/** Release notes from the feed: a string, or one entry per version in between. */
function notesOf(info: UpdateInfo): string {
  const n = info.releaseNotes;
  if (!n) return '';
  if (typeof n === 'string') return n;
  return n.map((v) => `## ${v.version}\n\n${v.note ?? ''}`).join('\n\n');
}

export class Updater {
  private state: DvUpdateState;
  private token: CancellationToken | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private source: 'site' | 'github' = 'site';
  /** Called on every change (the window shows it; the app menu's item follows). */
  onChange: (s: DvUpdateState) => void = () => undefined;
  /** The notification was clicked: show the What's New dialog. */
  onOpen: () => void = () => undefined;

  constructor() {
    const s = stored();
    this.state = { status: 'idle', current: app.getVersion(), lastChecked: s.lastChecked, settings: this.settings(), downloadUrl: '' };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } }),
    );
    autoUpdater.on('update-downloaded', () => {
      this.set({ status: 'downloaded', progress: undefined });
      this.notify('downloaded');
    });
  }

  private settings(): DvUpdateSettings {
    const { auto, notify, channel, skipped } = stored();
    return { auto, notify, channel, skipped };
  }

  get(): DvUpdateState {
    return { ...this.state, settings: this.settings(), downloadUrl: platformId() ? `${siteBase()}/download/dbcatz/${platformId()}` : `${siteBase()}/dbcatz` };
  }

  private set(patch: Partial<DvUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.get());
  }

  /** Automatic checks: 30 s after launch, then every 6 h (when the switch is on). Only a packaged app updates. */
  start(): void {
    if (!app.isPackaged && !process.env.DBCATZ_UPDATE_FEED) return;
    setTimeout(() => void this.auto(), FIRST_CHECK);
    this.timer = setInterval(() => void this.auto(), EVERY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async auto(): Promise<void> {
    if (!stored().auto || ['checking', 'downloading', 'downloaded'].includes(this.state.status)) return;
    await this.check(false);
  }

  private feed(source: 'site' | 'github', channel: DvUpdateChannel): void {
    const s = stored();
    autoUpdater.allowPrerelease = channel === 'beta';
    autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest';
    autoUpdater.requestHeaders = { 'X-Catzoid-Install': s.installId, 'X-Catzoid-Version': app.getVersion(), 'X-Catzoid-Channel': channel };
    // DBCATZ_UPDATE_FEED: a local feed for tests.
    if (source === 'site') autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DBCATZ_UPDATE_FEED || `${siteBase()}/updates/dbcatz` });
    else autoUpdater.setFeedURL({ provider: 'github', owner: 'catzoidhub', repo: 'DBCatz' });
    this.source = source;
  }

  /** Asks the site's feed, then the GitHub release when the site does not answer. */
  async check(manual: boolean): Promise<DvUpdateState> {
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.get();
    if (!app.isPackaged && !process.env.DBCATZ_UPDATE_FEED) {
      this.set({ status: 'error', manual, error: 'Updates work in the installed DBCatz only, not in a development build.' });
      return this.get();
    }
    if (process.env.DBCATZ_UPDATE_FEED) autoUpdater.forceDevUpdateConfig = true;
    this.set({ status: 'checking', manual, error: undefined });
    const channel = stored().channel;
    let info: UpdateInfo | null = null;
    let error = '';
    for (const source of process.env.DBCATZ_UPDATE_FEED ? (['site'] as const) : (['site', 'github'] as const)) {
      try {
        this.feed(source, channel);
        const r = await autoUpdater.checkForUpdates();
        info = r?.updateInfo ?? null;
        error = '';
        break;
      } catch (e) {
        error = (e as Error).message.split('\n')[0];
      }
    }
    const lastChecked = Date.now();
    save({ lastChecked });
    if (error) {
      this.set({ status: 'error', error: `Could not reach the update feed: ${error}`, lastChecked });
      return this.get();
    }
    if (!info || !newer(info.version, app.getVersion())) {
      this.set({ status: 'none', version: undefined, lastChecked });
      return this.get();
    }
    // The file electron-updater will fetch for this computer: Windows the Setup .exe, a Mac the zip of its own chip.
    const mine = (u: string) => (process.platform === 'win32' ? u.endsWith('.exe') : u.endsWith('.zip') && (process.arch === 'arm64') === u.includes('arm64'));
    const size = info.files?.find((f) => mine(f.url))?.size;
    this.set({ status: 'available', version: info.version, notes: notesOf(info), size, releaseDate: info.releaseDate, lastChecked, source: this.source });
    if (!manual && stored().skipped !== info.version) this.notify('available');
    return this.get();
  }

  async download(): Promise<void> {
    if (this.state.status !== 'available' && this.state.status !== 'error') return;
    this.token = new CancellationToken();
    this.set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: this.state.size ?? 0, bytesPerSecond: 0 }, error: undefined });
    try {
      await autoUpdater.downloadUpdate(this.token);
    } catch (e) {
      const cancelled = this.token?.cancelled;
      this.set(cancelled ? { status: 'available', progress: undefined } : { status: 'error', progress: undefined, error: `The download failed: ${(e as Error).message.split('\n')[0]}` });
    } finally {
      this.token = null;
    }
  }

  cancel(): void {
    this.token?.cancel();
  }

  skip(version: string): DvUpdateState {
    save({ skipped: version });
    this.set({ status: 'idle' });
    return this.get();
  }

  install(now: boolean): void {
    if (this.state.status !== 'downloaded') return;
    if (now) setImmediate(() => autoUpdater.quitAndInstall(false, true));
    // Otherwise autoInstallOnAppQuit installs it when DBCatz quits.
  }

  configure(patch: Partial<DvUpdateSettings>): DvUpdateState {
    const next: Partial<Stored> = {};
    if (typeof patch.auto === 'boolean') next.auto = patch.auto;
    if (typeof patch.notify === 'boolean') next.notify = patch.notify;
    if (patch.channel === 'stable' || patch.channel === 'beta') next.channel = patch.channel;
    save(next);
    this.set({});
    return this.get();
  }

  /** Once per version, only when the switch is on. */
  private notify(kind: 'available' | 'downloaded'): void {
    const s = stored();
    const v = this.state.version ?? '';
    if (!s.notify || !Notification.isSupported()) return;
    if (kind === 'available') {
      if (s.notified === v) return;
      save({ notified: v });
    }
    const n = new Notification(
      kind === 'available'
        ? { title: `DBCatz ${v} is available`, body: 'Click to see what’s new.' }
        : { title: 'Ready to install', body: `Restart DBCatz to use ${v}.` },
    );
    n.on('click', () => this.onOpen());
    n.show();
  }
}

/** a > b for x.y.z(-pre) versions. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre = ''] = v.replace(/^v/, '').split('-', 2);
    return { n: main.split('.').map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre > y.pre;
}
