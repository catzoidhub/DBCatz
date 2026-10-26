import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';

/**
 * The DBCatz window: one window with a tab per connection. Opening a
 * connection focuses its tab when it is already open. The application menu's
 * File / Database / Table / Query items reach the window as `viewer:command`.
 */

let win: BrowserWindow | null = null;
const preload = join(__dirname, '../preload/index.js');

export type ViewerCommand =
  | 'newConnection'
  | 'openConnection'
  | 'closeTab'
  | 'export'
  | 'import'
  | 'backup'
  | 'refresh'
  | 'dbCreate'
  | 'dbDrop'
  | 'dbFlush'
  | 'tableCreate'
  | 'tableStructure'
  | 'tableData'
  | 'tableRename'
  | 'tableTruncate'
  | 'tableDrop'
  | 'tableExport'
  | 'tableCopyName'
  | 'tableCopyDdl'
  | 'rowInsert'
  | 'rowDelete'
  | 'queryNew'
  | 'queryRun'
  | 'queryFormat'
  | 'keyNew'
  | 'keyDelete'
  | 'filter'
  | 'logs'
  | 'disconnect'
  | 'nextTab'
  | 'prevTab'
  | 'settings'
  | 'about'
  | 'checkUpdates'
  | 'reportBug'
  | 'sendFeedback'
  | 'dbPick'
  | 'askAi'
  | 'navBack'
  | 'navForward'
  | 'askDbcatz'
  | 'selectAll'
  | 'tablesExport'
  | 'tablesCopyNames'
  | 'tablesCopyDdl'
  | 'tablesCount'
  | 'tablesOptimize'
  | 'tablesTruncate'
  | 'tablesDrop';

export function send(command: ViewerCommand, table?: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('viewer:command', { command, table });
}

/** Opens the viewer at a connection (`null`: the New connection screen), optionally at one of its databases. */
/** Where a dbcatz:// link points inside a connection: a table, and a first row filter column = value. */
export interface ViewerTarget {
  table?: string;
  col?: string;
  val?: string;
}

export function openViewer(connId: string | null, db?: string, target: ViewerTarget = {}): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    win.webContents.send('viewer:open', { connId, db: db ?? null, table: target.table ?? null, col: target.col ?? null, val: target.val ?? null });
    return;
  }
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 860,
    minHeight: 520,
    title: 'DBCatz',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    show: false,
    webPreferences: { preload, sandbox: false, contextIsolation: true },
  });
  const w = win;
  w.once('ready-to-show', () => w.show());
  w.webContents.on('render-process-gone', (_e, d) => console.error(`DBCatz renderer gone: ${d.reason} (exit ${d.exitCode})`));
  w.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame) console.log(`DBCatz navigation: ${d.url}`);
  });
  w.webContents.on('unresponsive', () => console.warn('DBCatz renderer unresponsive'));
  // Back / forward: a three-finger swipe (System Settings → Trackpad → Swipe between pages) and Windows' browser keys / mouse buttons.
  w.on('swipe', (_e, direction) => {
    if (direction === 'right') send('navBack');
    else if (direction === 'left') send('navForward');
  });
  w.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') send('navBack');
    else if (cmd === 'browser-forward') send('navForward');
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  const extra = (['table', 'col', 'val'] as const).filter((k) => target[k] !== undefined).map((k) => `&${k}=${encodeURIComponent(target[k]!)}`).join('');
  const hash = `viewer=${encodeURIComponent(connId ?? '')}${db ? `&db=${encodeURIComponent(db)}` : ''}${extra}`;
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash });
}

export const viewerWindow = () => (win && !win.isDestroyed() ? win : null);

export function closeViewer(): void {
  if (win && !win.isDestroyed()) win.close();
}

const item = (label: string, command: ViewerCommand, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({ label, accelerator, click: () => send(command), ...extra });
const sep: MenuItemConstructorOptions = { type: 'separator' };

function viewerMenu(): MenuItemConstructorOptions[] {
  return [
    {
      label: app.name,
      submenu: [item('About DBCatz', 'about'), item(updateLabel, 'checkUpdates'), sep, item('Settings…', 'settings', 'CmdOrCtrl+,'), sep, { role: 'services' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }],
    },
    {
      label: 'File',
      submenu: [
        item('New Connection…', 'newConnection', 'CmdOrCtrl+N'),
        item('Open Connection…', 'openConnection', 'CmdOrCtrl+O'),
        sep,
        item('New Query Tab', 'queryNew', 'CmdOrCtrl+T'),
        item('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
        sep,
        item('Export…', 'export', 'CmdOrCtrl+E'),
        item('Import…', 'import', 'CmdOrCtrl+I'),
        item('Backup as .tar.gz…', 'backup', 'CmdOrCtrl+Shift+B'),
      ],
    },
    {
      // Select All goes to the window: text fields select their text, the table list its tables.
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, item('Select All', 'selectAll', 'CmdOrCtrl+A')],
    },
    {
      label: 'Database',
      submenu: [item('Choose Database…', 'dbPick', 'CmdOrCtrl+P'), sep, item('Refresh', 'refresh', 'CmdOrCtrl+R'), item('Show Logs', 'logs', 'CmdOrCtrl+L'), item('Disconnect', 'disconnect'), sep, item('Create Database…', 'dbCreate', 'CmdOrCtrl+Shift+N'), item('Flush Keys…', 'dbFlush'), sep, item('Drop Database…', 'dbDrop')],
    },
    {
      label: 'Table',
      submenu: [
        item('Create Table…', 'tableCreate', 'CmdOrCtrl+Shift+T'),
        sep,
        item('Show Data', 'tableData', 'CmdOrCtrl+1'),
        item('Show Structure', 'tableStructure', 'CmdOrCtrl+2'),
        item('Filter Rows', 'filter', 'CmdOrCtrl+F'),
        sep,
        item('Insert Row', 'rowInsert', 'CmdOrCtrl+Shift+I'),
        item('Delete Selected Rows', 'rowDelete', 'CmdOrCtrl+Backspace'),
        sep,
        item('Copy Table Name', 'tableCopyName'),
        item('Copy CREATE Statement', 'tableCopyDdl'),
        item('Export Table…', 'tableExport'),
        sep,
        item('Rename Table…', 'tableRename'),
        item('Truncate Table…', 'tableTruncate'),
        item('Drop Table…', 'tableDrop'),
      ],
    },
    {
      label: 'Query',
      submenu: [item('Run', 'queryRun', 'CmdOrCtrl+Return'), item('Run (alternative)', 'queryRun', 'CmdOrCtrl+Enter', { visible: false }), item('Format SQL', 'queryFormat', 'CmdOrCtrl+Shift+F'), item('Ask AI…', 'askAi', 'CmdOrCtrl+Shift+K'), item('Ask DBCatz…', 'askDbcatz', 'CmdOrCtrl+K'), sep, item('New Query Tab', 'queryNew', 'CmdOrCtrl+T')],
    },
    { role: 'viewMenu' },
    { label: 'Go', submenu: [item('Back', 'navBack', 'CmdOrCtrl+['), item('Forward', 'navForward', 'CmdOrCtrl+]')] },
    {
      role: 'windowMenu',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, sep, item('Next Tab', 'nextTab', 'Ctrl+Tab'), item('Previous Tab', 'prevTab', 'Ctrl+Shift+Tab'), sep, { role: 'front' }],
    },
    { role: 'help', submenu: [item('Report a Bug…', 'reportBug'), item('Send Feedback…', 'sendFeedback')] },
  ];
}

let viewerActive = false;
/** "Check for Updates…", or "Update Available…" while one waits (Catzoid #54). */
let updateLabel = 'Check for Updates…';
export function setUpdateLabel(label: string): void {
  if (label === updateLabel) return;
  updateLabel = label;
  Menu.setApplicationMenu(Menu.buildFromTemplate(viewerMenu()));
}
export function applyMenu(viewer: boolean): void {
  if (viewerActive === viewer && Menu.getApplicationMenu()) return;
  void viewer;
  viewerActive = viewer;
  Menu.setApplicationMenu(Menu.buildFromTemplate(viewerMenu()));
}

/** A table's right-click menu in the sidebar; choices arrive as commands with the table. Several picked: the bulk menu. */
export function tableMenu(table: string, kind: 'table' | 'view' | 'collection' | 'index', selection?: { tables: string[]; readOnly: boolean; sql: boolean }): void {
  const w = viewerWindow();
  if (!w) return;
  if (selection && selection.tables.length > 1) {
    const n = selection.tables.length;
    const noun = kind === 'collection' ? 'Collections' : kind === 'index' ? 'Indices' : 'Tables';
    const b = (label: string, command: ViewerCommand, extra: Partial<MenuItemConstructorOptions> = {}) => ({ label, click: () => w.webContents.send('viewer:command', { command, tables: selection.tables }), ...extra });
    const ro = selection.readOnly ? { enabled: false, sublabel: 'Read-only connection' } : {};
    Menu.buildFromTemplate([
      { label: `${n} ${noun} Selected`, enabled: false },
      sep,
      b(`Export ${n} ${noun}…`, 'tablesExport'),
      b('Copy Names', 'tablesCopyNames'),
      ...(selection.sql ? [b('Copy CREATE Statements', 'tablesCopyDdl'), b('Count Rows', 'tablesCount'), b(`Optimize ${n} ${noun}…`, 'tablesOptimize', ro)] : []),
      sep,
      b(`Truncate ${n} ${noun}…`, 'tablesTruncate', ro),
      b(`Drop ${n} ${noun}…`, 'tablesDrop', ro),
    ]).popup({ window: w });
    return;
  }
  const t = (label: string, command: ViewerCommand) => ({ label, click: () => w.webContents.send('viewer:command', { command, table }) });
  const noun = kind === 'collection' ? 'Collection' : kind === 'index' ? 'Index' : kind === 'view' ? 'View' : 'Table';
  Menu.buildFromTemplate([
    t('Show Data', 'tableData'),
    t('Show Structure', 'tableStructure'),
    sep,
    t('Copy Name', 'tableCopyName'),
    t(`Copy CREATE Statement`, 'tableCopyDdl'),
    t(`Export ${noun}…`, 'tableExport'),
    sep,
    t(`Rename ${noun}…`, 'tableRename'),
    ...(kind === 'view' ? [] : [t(`Truncate ${noun}…`, 'tableTruncate')]),
    t(`Drop ${noun}…`, 'tableDrop'),
  ]).popup({ window: w });
}

app.on('browser-window-focus', () => applyMenu(true));
