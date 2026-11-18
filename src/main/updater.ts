import { app, net, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { autoUpdater, CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { DvReleaseNotes, DvUpdateChannel, DvUpdateSettings, DvUpdateState } from '@shared/types';
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
const DEFAULTS: DvUpdateSettings = { auto: true, notify: true, channel: 'stable', skipped: '', dialog: true };

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
    dialog: s.dialog !== false,
    promptAt: typeof s.promptAt === 'number' ? s.promptAt : undefined,
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


/** Release notes from the feed (the GitHub fallback has them; the site's latest*.yml does not): a string, or one per version. */
function notesOf(info: UpdateInfo): DvReleaseNotes[] {
  const n = info.releaseNotes;
  if (Array.isArray(n)) return n.map((v) => ({ version: v.version, date: v.version === info.version ? (info.releaseDate ?? null) : null, notes: v.note ?? '' }));
  return [{ version: info.version, date: info.releaseDate ?? null, notes: n ?? '' }];
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
  /** The window is in front and opens What's New by itself (Catzoid #97): a notification would only repeat it. */
  inFront: () => boolean = () => false;

  constructor() {
    const s = stored();
    this.state = { status: 'idle', current: app.getVersion(), lastChecked: s.lastChecked, settings: this.settings(), downloadUrl: '', notesUrl: `${siteBase()}/dbcatz/download#versions` };
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
    const { auto, notify, channel, skipped, dialog, promptAt } = stored();
    return { auto, notify, channel, skipped, dialog, promptAt };
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
    // The install id / version / channel go to catzoid.com's update check only, never to GitHub: none on the GitHub
    // fallback feed (Catzoid #90).
    autoUpdater.requestHeaders =
      source === 'site' ? { 'X-Catzoid-Install': s.installId, 'X-Catzoid-Version': app.getVersion(), 'X-Catzoid-Channel': channel } : null;
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
    // No build for this platform on the feed yet (latest.yml / latest-linux.yml missing): nothing newer for this copy,
    // not a failure. Every platform but macOS, whose feed always exists.
    if (error && process.platform !== 'darwin' && /\b404\b/.test(error)) error = '';
    if (error) {
      this.set({ status: 'error', error: `Could not reach the update feed: ${error}`, lastChecked });
      return this.get();
    }
    if (!info || !newer(info.version, app.getVersion())) {
      this.set({ status: 'none', version: undefined, lastChecked });
      return this.get();
    }
    // The file electron-updater will fetch for this computer: Windows the Setup .exe, a Mac the zip of its own chip.
    // Linux: the AppImage, or the .deb for a copy installed from one (electron-updater picks the same way).
    const linux = (u: string) => (process.env.APPIMAGE ? u.endsWith('.AppImage') : u.endsWith('.deb')) && (process.arch === 'arm64') === /arm64|aarch64/.test(u);
    const mine = (u: string) =>
      process.platform === 'win32' ? u.endsWith('.exe') : process.platform === 'linux' ? linux(u) : u.endsWith('.zip') && (process.arch === 'arm64') === u.includes('arm64');
    const size = info.files?.find((f) => mine(f.url))?.size;
    this.set({ status: 'available', version: info.version, notes: await this.notesSince(info), size, releaseDate: info.releaseDate, lastChecked, source: this.source });
    this.lastInfo = info;
    this.retryNotes();
    if (!manual && stored().skipped !== info.version) this.notify('available');
    return this.get();
  }

  /**
   * Release notes of every version after the installed one, from the site's API (`<site>/api/dbcatz/releases`), else
   * the feed's own (the GitHub fallback only: the site's latest*.yml has none). "Sometimes no notes" (user,
   * 2026-11-18, all four apps): DBCatz used the feed's notes alone, so What's New was empty whenever the site answered
   * the check. Three tries; while the new version's notes are missing they are fetched again every 5 minutes (an hour
   * at most) and when What's New opens — the site's GitHub cache may not have the release yet.
   */
  private async notesSince(info: UpdateInfo): Promise<DvReleaseNotes[]> {
    const beta = stored().channel === 'beta';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt * 3000));
      try {
        const res = await net.fetch(`${siteBase()}/api/dbcatz/releases`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
        const list = (await res.json()) as { version: string; date?: string | null; notes?: string | null }[];
        const out = list
          .filter((r) => newer(r.version, app.getVersion()) && !newer(r.version, info.version) && (beta || !r.version.includes('-')))
          .sort((a, b) => (newer(a.version, b.version) ? -1 : 1))
          .map((r) => ({ version: r.version, date: r.date ?? null, notes: (r.notes ?? '').trim() }));
        if (out.find((r) => r.version === info.version)?.notes) return out;
        break; // answered, but without this release yet: the retries below pick it up
      } catch {
        /* next try */
      }
    }
    return notesOf(info);
  }

  private lastInfo: UpdateInfo | null = null;
  private notesTimer: ReturnType<typeof setInterval> | null = null;
  private notesMissing = () => !!this.state.version && !this.state.notes?.find((n) => n.version === this.state.version)?.notes.trim();

  /** Fetches the notes again while they are missing: every 5 minutes for an hour, and when What's New opens. */
  async refreshNotes(): Promise<DvUpdateState> {
    const info = this.lastInfo;
    if (!info || !this.notesMissing() || !['available', 'downloading', 'downloaded'].includes(this.state.status)) {
      this.stopNotes();
      return this.get();
    }
    const notes = await this.notesSince(info);
    if (info === this.lastInfo && notes.some((n) => n.notes.trim())) this.set({ notes });
    if (!this.notesMissing()) this.stopNotes();
    return this.get();
  }

  private retryNotes(): void {
    this.stopNotes();
    if (!this.notesMissing()) return;
    let left = 12;
    this.notesTimer = setInterval(() => {
      if (--left < 0) return this.stopNotes();
      void this.refreshNotes();
    }, 5 * 60_000);
  }

  private stopNotes(): void {
    if (this.notesTimer) clearInterval(this.notesTimer);
    this.notesTimer = null;
  }

  async download(): Promise<void> {
    if (this.state.status !== 'available' && this.state.status !== 'error') return;
    this.token = new CancellationToken();
    this.set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: this.state.size ?? 0, bytesPerSecond: 0 }, error: undefined });
    // The check (the .yml request) has already counted this install. The download goes through
    // catzoid.com/updates/dbcatz/<file>, which redirects to GitHub's release assets, and electron-updater keeps these
    // headers across that redirect: none on the download (Catzoid #90). The next check sets them again.
    autoUpdater.requestHeaders = null;
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
    // Windows: silent, or the assisted NSIS installer (oneClick: false) stops on "Who should this application be
    // installed for?" and Restart now never comes back (seen in DialCatz 1.2.2 → 1.2.3). It installs for the current
    // user as before (perMachine: false). Then DBCatz opens again.
    if (now) setImmediate(() => autoUpdater.quitAndInstall(process.platform === 'win32', true));
    // Otherwise autoInstallOnAppQuit installs it when DBCatz quits.
  }

  configure(patch: Partial<DvUpdateSettings>): DvUpdateState {
    const next: Partial<Stored> = {};
    if (typeof patch.auto === 'boolean') next.auto = patch.auto;
    if (typeof patch.notify === 'boolean') next.notify = patch.notify;
    if (patch.channel === 'stable' || patch.channel === 'beta') next.channel = patch.channel;
    if (typeof patch.dialog === 'boolean') next.dialog = patch.dialog;
    if (typeof patch.promptAt === 'number' && Number.isFinite(patch.promptAt)) next.promptAt = patch.promptAt;
    save(next);
    this.set({});
    return this.get();
  }

  /** Once per version, only when the switch is on. */
  private notify(kind: 'available' | 'downloaded'): void {
    const s = stored();
    const v = this.state.version ?? '';
    if (!s.notify || this.inFront() || !Notification.isSupported()) return;
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
