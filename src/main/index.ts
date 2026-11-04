import { app, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { API_METHODS, type DbCatzApi } from '@shared/types';
import { DbViewerManager } from './dbviewer/manager';
import { applyMenu, appMenuPopup, menuKey, menuShortcuts, openViewer, setUpdateLabel, showViewer, tableMenu, viewerWindow } from './dbviewer/window';
import { AppServices } from './devcatz';
import { AskAi } from './ai';
import { applySettings, migrateToShared, setAiKey, setSettings, settings } from './settings';
import { siteBase } from './shared';
import { Updater } from './updater';
import { Reporter } from './reporter';
import { uninstallPlan, uninstallRun } from './uninstall';
import { writeBridge } from './bridge';
import { openCatzoidApp, platformId } from './companion';
import { Mcatzp } from './mcatzp';
import * as mcatzpSetup from './mcatzp/install';
import { MCATZP_TARGETS } from '@catzoid/mcatzp-host';

/**
 * DBCatz — a database viewer for MySQL / MariaDB, PostgreSQL, SQLite, Redis /
 * Valkey, MongoDB and Elasticsearch: one window with a tab per connection.
 * Standalone, with DevCatz's and DoCatz's local services listed when they are
 * installed, and opened from them (or any app) through dbcatz:// links:
 *   dbcatz://open                         the Connections tab
 *   dbcatz://open?conn=svc:<id>&db=<db>   a DevCatz service, at a database
 *   dbcatz://open?docatz=<id>             a DoCatz database container (its password comes from DoCatz's file, never the link)
 *   dbcatz://open?conn=<saved id>
 *   dbcatz://open?conn=<id>&db=<db>&table=<table>[&col=<column>&val=<value>]
 *                                         a table's data, filtered to column = value (DialCatz's "Check in DBCatz");
 *                                         Redis / Valkey: table = a key; MongoDB: a collection; Elasticsearch: an index.
 *                                         Links only open and filter: the filter is built from the column and value
 *                                         (quoted for the engine), never SQL from the link, and nothing is changed.
 *   dbcatz://url?u=<encoded connection URL>  a URL as a session connection
 */

const devcatz = new AppServices('DevCatz');
const docatz = new AppServices('DoCatz');
const viewer = new DbViewerManager(devcatz, docatz);
const ai = new AskAi(viewer);
const updater = new Updater();
const reporter = new Reporter();
let mcatzp: Mcatzp;
let mcatzpUpdate: string | null = null;
/** Settings' MCatzP badge: asked once a day while the switch is on, and whenever the page or an install has news. */
const MCATZP_UPDATE_EVERY_MS = 24 * 3600_000;
async function checkMcatzpUpdate(): Promise<void> {
  const next = settings().mcatzp.on ? await mcatzpSetup.availableUpdate().catch(() => mcatzpUpdate) : null;
  if (next === mcatzpUpdate) return;
  mcatzpUpdate = next;
  viewerWindow()?.webContents.send('viewer:mcatzpUpdate', next);
}
const windowReads = new Map<string, (data: unknown) => void>();
/** What only the window holds (Logs, History). No window, or none answering: there is nothing to read. */
function askWindow<T>(what: 'log' | 'history', connId: string, db: string): Promise<T[]> {
  const w = viewerWindow();
  if (!w || w.isDestroyed()) return Promise.resolve([]);
  const id = randomUUID();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      windowReads.delete(id);
      done([]);
    }, 3000);
    windowReads.set(id, (data) => {
      clearTimeout(timer);
      done(Array.isArray(data) ? (data as T[]) : []);
    });
    w.webContents.send('viewer:mcatzpRead', { id, what, connId, db });
  });
}
let mcatzpInstalling: AbortController | null = null;
const clientId = (id: unknown) => {
  const known = MCATZP_TARGETS.find((t) => t === id);
  if (!known) throw new Error('Unknown client');
  return known;
};

/** One link parameter: trimmed, bounded, no control characters; undefined when missing or unusable. */
function text(v: string | null, max: number, keepEmpty = false): string | undefined {
  if (v === null) return undefined;
  const t = v.trim();
  if ((!t && !keepEmpty) || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) return undefined;
  return t;
}

/** The target of a dbcatz:// link. */
function handleLink(raw: string): void {
  try {
    const u = new URL(raw);
    const q = u.searchParams;
    if (u.hostname === 'url' && q.get('u')) {
      const c = viewer.openUrl(q.get('u')!);
      return openViewer(c.id);
    }
    const doc = text(q.get('docatz'), 160);
    if (doc !== undefined) {
      if (!/^[\w.-]+$/.test(doc)) throw new Error('bad DoCatz service id');
      docatz.refresh(); // a container DoCatz just started may not have reached the poll yet
      return openViewer(`doc:${doc}`, text(q.get('db'), 256));
    }
    const conn = text(q.get('conn'), 160);
    if (conn !== undefined && !/^((svc|doc):)?[\w.:-]+$/.test(conn)) throw new Error('bad connection id');
    const table = text(q.get('table'), 256);
    const col = table !== undefined ? text(q.get('col'), 128) : undefined;
    const val = col !== undefined ? (text(q.get('val'), 1000, true) ?? '') : undefined;
    openViewer(conn ?? null, text(q.get('db'), 256), { table, col, val });
  } catch (e) {
    console.warn(`dbcatz link ignored: ${raw} (${(e as Error).message})`);
    openViewer(null);
  }
}

// One instance: a second launch (Finder, a link) goes to the running one.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('dbcatz://'));
  if (link) handleLink(link);
  else openViewer(null);
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (app.isReady()) handleLink(url);
  else app.once('ready', () => handleLink(url));
});
app.on('activate', () => openViewer(null));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  mcatzp?.quit();
  void viewer.closeAll();
});

/** A started job runs on; its end (and any error) reaches the window through the Jobs list. */
function background(job: Promise<string>, path: string): string {
  job.catch(() => undefined);
  return path;
}

function api(): DbCatzApi {
  const win = () => viewerWindow() ?? undefined;
  return {
    appInfo: async () => {
      const [devcatzPath, docatzPath] = await Promise.all([devcatz.locate(), docatz.locate()]);
      return { version: app.getVersion(), devcatz: devcatzPath !== null || (await devcatz.installed()), devcatzPath, docatzPath, site: siteBase(), platform: platformId() ?? '' };
    },
    aboutInfo: async () => ({
      version: app.getVersion(),
      arch: process.arch,
      macos: process.getSystemVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      site: siteBase(),
      dataDir: app.getPath('userData'),
    }),
    updateState: async () => updater.get(),
    updateCheck: async () => updater.check(true),
    updateDownload: async () => updater.download(),
    updateCancel: async () => updater.cancel(),
    updateSkip: async (version) => updater.skip(version),
    updateInstall: async (now) => updater.install(now),
    updateConfigure: async (patch) => updater.configure(patch),
    reportPreview: async (kind, message, email, shots) => reporter.preview(kind, message, email, Number(shots) || 0),
    reportSend: (kind, message, email, shots) => reporter.feedback(kind, message, email, Array.isArray(shots) ? shots : []),
    captureWindow: async () => {
      const w = win();
      return w && !w.isDestroyed() ? (await w.webContents.capturePage()).toPNG().toString('base64') : '';
    },
    reportError: async (message, stack) => reporter.error('renderer', Object.assign(new Error(message), { stack })),
    reportSettings: async () => reporter.settings(),
    reportConfigure: async (crash) => reporter.configure(crash),
    uninstallPlan: () => uninstallPlan(),
    uninstallRun: (confirm, shared) =>
      uninstallRun(confirm, shared, async () => {
        updater.stop();
        reporter.stop();
        await viewer.closeAll();
      }),
    settings: async () => settings(),
    setSettings: async (patch) => {
      const next = setSettings(patch);
      if (patch.mcatzp) {
        if (patch.mcatzp.on !== undefined) {
          await mcatzp.set(next.mcatzp.on);
          void checkMcatzpUpdate();
        }
        mcatzp.scopesChanged();
      }
      return next;
    },
    setAiKey: async (provider, key) => setAiKey(provider, key),
    aiModels: (provider) => ai.models(provider),
    aiProbe: (provider, models) => ai.probe(provider, models),
    aiTest: () => ai.test(),
    aiAsk: (connId, db, req, token) => ai.ask(connId, db, req, token),
    aiCancel: async (token) => ai.cancel(token),
    aiAskDbcatz: (req, token) => ai.askDbcatz(req, token),
    aiPreviewAskDbcatz: (req) => ai.previewAskDbcatz(req),
    aiExplainLog: (connId, req, token) => ai.explainLog(connId, req, token),
    aiPreviewLog: (connId, req) => ai.previewLog(connId, req),
    aiPreview: (connId, db, req) => ai.preview(connId, db, req),
    aiForget: async (connId, db) => ai.forget(connId, db),
    mcatzpActivity: async () => mcatzp.activity.list(),
    mcatzpClearActivity: async () => mcatzp.activity.clear(),
    mcatzpRevoke: (name) => mcatzp.revoke(String(name)),
    mcatzpSetup: async (askSite) => {
      if (askSite !== false) void checkMcatzpUpdate();
      return mcatzpSetup.setupState(askSite !== false);
    },
    mcatzpInstall: async () => {
      if (mcatzpInstalling) throw new Error('MCatzP is being installed');
      mcatzpInstalling = new AbortController();
      const report = (p: Parameters<Parameters<typeof mcatzpSetup.install>[0]>[0] | null) => viewerWindow()?.webContents.send('viewer:mcatzpInstalling', p);
      try {
        report({ phase: 'download', received: 0, total: 0 });
        await mcatzpSetup.install(report, mcatzpInstalling.signal);
      } catch (e) {
        // Cancel is an answer, not a failure.
        if (!mcatzpInstalling?.signal.aborted) throw e;
      } finally {
        mcatzpInstalling = null;
        report(null);
      }
      void checkMcatzpUpdate();
      return mcatzpSetup.setupState();
    },
    mcatzpInstallCancel: async () => mcatzpInstalling?.abort(),
    mcatzpApprovals: () => mcatzpSetup.approvals(),
    mcatzpTargets: () => mcatzpSetup.targets(),
    mcatzpAddToClient: async (id) => {
      await mcatzpSetup.addToClient(clientId(id));
      return mcatzpSetup.targets();
    },
    mcatzpRemoveFromClient: async (id) => {
      await mcatzpSetup.removeFromClient(clientId(id));
      return mcatzpSetup.targets();
    },
    mcatzpUpdate: async () => mcatzpUpdate,
    mcatzpPending: async () => mcatzp.pending(),
    mcatzpWindowReply: async (id, data) => {
      windowReads.get(String(id))?.(data);
      windowReads.delete(String(id));
    },
    mcatzpAnswer: async (id, answer, typed) => mcatzp.answer(String(id), answer === 'once' || answer === 'session' ? answer : 'deny', typeof typed === 'string' ? typed : undefined),
    openUrl: async (url) => {
      // app:licenses — the third-party licences shipped inside the app (Catzoid #66), readable offline
      if (url === 'app:licenses') await shell.openPath(app.isPackaged ? join(process.resourcesPath, 'third-party-licenses.txt') : join(app.getAppPath(), 'resources', 'third-party-licenses.txt'));
      else if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    },
    pickFile: async (title) => {
      const r = await dialog.showOpenDialog(win()!, { title, properties: ['openFile', 'showHiddenFiles'] });
      return r.canceled ? null : r.filePaths[0];
    },
    openInDevCatz: async (serviceId) => {
      const path = await devcatz.locate();
      if (!path) return false;
      // That very copy at the service: `open -a` on a Mac, the .exe with the link on Windows.
      await openCatzoidApp(path, `devcatz://db/${encodeURIComponent(serviceId)}`);
      return true;
    },
    openInDoCatz: async (serviceId) => {
      const path = await docatz.locate();
      if (!path) return false;
      // The container's page; an older DoCatz writes no container name, so its window.
      const name = docatz.list().find((s) => s.id === serviceId)?.container;
      await openCatzoidApp(path, name && /^[\w.-]{1,200}$/.test(name) ? `docatz://container/${name}` : 'docatz://open');
      return true;
    },
    ...viewer.routes(),
    dvOpen: async (connId, database) => openViewer(connId, database),
    dvPickSqlite: async () => {
      const r = await dialog.showOpenDialog(win()!, { title: 'SQLite database file or folder', properties: ['openFile', 'openDirectory'], filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3', 's3db'] }] });
      return r.canceled ? null : r.filePaths[0];
    },
    dvExport: async (connId, options) => {
      const ext = options.format === 'redis' ? 'redis' : options.format === 'json' ? 'ndjson' : options.format;
      const name = `${options.database}${options.tables.length === 1 ? `-${options.tables[0]}` : ''}.${ext}`;
      const r = await dialog.showSaveDialog(win()!, { defaultPath: join(app.getPath('downloads'), name), filters: [{ name: options.format.toUpperCase(), extensions: [ext] }] });
      if (r.canceled || !r.filePath) return null;
      return background(viewer.export(connId, r.filePath, options), r.filePath);
    },
    dvImport: async (connId, options) => {
      const filters = options.format === 'sql' ? [{ name: 'SQL or DBCatz backup', extensions: ['sql', 'gz', 'tgz'] }] : options.format === 'csv' ? [{ name: 'CSV', extensions: ['csv', 'txt'] }] : options.format === 'json' ? [{ name: 'JSON / NDJSON', extensions: ['json', 'ndjson', 'jsonl'] }] : [{ name: 'Redis script or DBCatz backup', extensions: ['redis', 'txt', 'gz', 'tgz'] }];
      const r = await dialog.showOpenDialog(win()!, { title: 'Import', properties: ['openFile'], filters });
      if (r.canceled || !r.filePaths[0]) return null;
      return background(viewer.import(connId, r.filePaths[0], options), r.filePaths[0]);
    },
    dvBackup: async (connId, databases) => {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      const conn = viewer.connections().find((c) => c.id === connId);
      const r = await dialog.showSaveDialog(win()!, { defaultPath: join(app.getPath('downloads'), `${(conn?.name ?? 'database').replace(/[^\w.-]+/g, '-')}-${stamp}.tar.gz`), filters: [{ name: 'Gzipped tar', extensions: ['tar.gz', 'gz'] }] });
      if (r.canceled || !r.filePath) return null;
      return background(viewer.backup(connId, r.filePath, databases), r.filePath);
    },
    dvReveal: async (path) => shell.showItemInFolder(path),
    dvTableMenu: async (table, kind, selection) => tableMenu(table, kind, selection),
    dvAppMenu: async (x, y) => appMenuPopup(x, y),
    dvMenuShortcuts: async () => menuShortcuts(),
    dvMenuKey: async (key) => menuKey(key),
  };
}

app.whenReady().then(() => {
  if (app.isPackaged) app.setAsDefaultProtocolClient('dbcatz'); // not the dev Electron binary
  const impl = api() as unknown as Record<string, (...args: unknown[]) => unknown>;
  // Saving or removing a connection rewrites bridge.json (DialCatz reads it).
  const bridged = new Set(['dvSaveConnection', 'dvDeleteConnection']);
  for (const m of API_METHODS)
    ipcMain.handle(`dbcatz:${m}`, async (_e, ...args) => {
      const r = await impl[m](...args);
      if (bridged.has(m)) writeBridge(viewer.connections());
      return r;
    });
  const send = (channel: string, payload: unknown) => viewerWindow()?.webContents.send(channel, payload);
  mcatzp = new Mcatzp(api(), viewer, {
    show: (ask) => {
      if (ask) showViewer();
      send('viewer:mcatzpAsk', ask);
    },
    settingsChanged: () => send('viewer:settings', settings()),
    open: (page) => openViewer(page.connId, page.db, { table: page.table }),
    refresh: () => send('viewer:command', { command: 'refresh' }),
    logQuery: (connId, r) => send('viewer:mcatzpLog', { connId, ...r }),
    queryLog: (connId) => askWindow('log', connId, ''),
    queryHistory: (connId, db) => askWindow('history', connId, db),
  });
  void mcatzp.set(settings().mcatzp.on).catch(() => undefined);
  setTimeout(() => void checkMcatzpUpdate(), 30_000);
  setInterval(() => void checkMcatzpUpdate(), MCATZP_UPDATE_EVERY_MS);
  viewer.onJobs = (jobs) => send('viewer:jobs', jobs);
  viewer.onProgress = (p) => send('viewer:progress', p);
  viewer.onChange = () => {
    send('viewer:changed', null);
    writeBridge(viewer.connections());
  };
  ai.onProgress = (p) => send('viewer:aiProgress', p);
  updater.onChange = (s) => {
    send('viewer:update', s);
    setUpdateLabel(s.status === 'available' || s.status === 'downloaded' ? 'Update Available…' : 'Check for Updates…');
  };
  updater.onOpen = () => {
    openViewer(null);
    send('viewer:updateOpen', null);
  };
  reporter.onAsk = () => send('viewer:reportsAsk', null);
  reporter.start();
  updater.start();
  writeBridge(viewer.connections());
  devcatz.onChange = docatz.onChange = () => {
    viewer.servicesChanged();
    send('viewer:changed', null);
  };
  // Theme and AI connection are shared with DevCatz (shared.ts): follow its changes; what DBCatz kept alone moves over once.
  applySettings((s) => send('viewer:settings', s));
  void migrateToShared()
    .then(() => send('viewer:settings', settings()))
    .catch((e) => console.warn('Shared settings migration:', (e as Error).message));
  applyMenu(true);
  const link = process.argv.find((a) => a.startsWith('dbcatz://'));
  if (link) handleLink(link);
  else openViewer(null);
});
