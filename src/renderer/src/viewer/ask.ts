import { DV_ASK_DESTRUCTIVE, DV_ASK_WRITES, type DvAskAction, type DvConnection } from '@shared/types';
import { statementKind } from '@shared/dbsafety';
import { splitStatements } from '@shared/sqlsplit';
import { api, openDevCatzDownload, saveSettings, settingsTab, showSettings } from '../store';
import { goTo } from './nav';
import { active, connections, dispatch, editing, isKv, isProd, isReadOnly, isSql, refreshConnections, showJobs } from './viewer';
import { words } from '@shared/platform';

/**
 * Runs one step Ask DBCatz proposed, after the user clicked it (and, for a
 * destructive one, read what it does and pressed Continue). Every name is
 * checked on the way: the connection must exist, goTo refuses a database or
 * table it does not have, Read-only connections refuse every change before
 * anything opens. Nothing is removed from here: drop / truncate / flush open
 * DBCatz's own dialog, where the name has to be typed; queries run through
 * Run, which asks on Production and before destructive statements.
 */
export async function runAsk(a: DvAskAction): Promise<string> {
  const x = a.args;
  // Steps that need no connection.
  switch (a.kind) {
    case 'open-settings':
      settingsTab.value = x.tab === 'ai' || x.tab === 'updates' || x.tab === 'about' ? x.tab : 'appearance';
      showSettings.value = true;
      return `Opened Settings → ${{ appearance: 'General', ai: 'AI', updates: 'Updates', about: 'About' }[settingsTab.value]}`;
    case 'set-theme': {
      const t = x.theme === 'light' || x.theme === 'dark' ? x.theme : x.theme === 'system' || x.theme === 'auto' ? 'system' : null;
      if (!t) throw new Error('The theme is Auto, Light or Dark');
      await saveSettings({ theme: t });
      return `Theme: ${t === 'system' ? 'Auto' : t[0].toUpperCase() + t.slice(1)} (all Catzoid apps follow)`;
    }
    case 'open-jobs':
      showJobs.value = true;
      return 'Jobs open';
    case 'new-connection':
      editing.value = null;
      showSettings.value = false;
      active.value = 'home';
      return 'New connection form open';
  }
  const conn = connections.value.find((c) => c.id === a.connection);
  if (!conn) throw new Error(a.connection ? 'That connection is not in DBCatz any more' : 'Which connection? Open one first, or name it');
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const need = (v: string | undefined, what: string) => {
    if (!v?.trim()) throw new Error(`The step has no ${what}`);
    return v.trim();
  };
  if (DV_ASK_WRITES.includes(a.kind) && isReadOnly(conn)) throw new Error(`${conn.name} is a Read-only connection: this step would change it, so it does not run`);
  switch (a.kind) {
    case 'open-connection':
      await goTo({ connId: conn.id, db: x.database });
      return `Opened ${conn.name}${x.database ? ` › ${x.database}` : ''}`;
    case 'open-database':
      await goTo({ connId: conn.id, db: need(x.database, 'database') });
      return `Opened ${x.database}`;
    case 'open-table':
      await goTo({ connId: conn.id, db: x.database, table: need(x.table, 'table'), mode: x.view === 'structure' ? 'structure' : 'data' });
      return `Opened ${x.table}${x.view === 'structure' ? ' (structure)' : ''}`;
    case 'filter-rows':
      if (isKv(conn.engine)) throw new Error('Redis / Valkey has no tables to filter: use open-keys with a pattern');
      await goTo({ connId: conn.id, db: x.database, table: need(x.table, 'table'), mode: 'data', where: need(x.where, 'filter') });
      return `${x.table} filtered: ${x.where}`;
    case 'open-keys':
      if (!isKv(conn.engine)) throw new Error('Keys are for Redis / Valkey connections');
      await goTo({ connId: conn.id, db: x.database });
      dispatch({ command: 'keysPattern', pattern: x.pattern || '*' });
      return `Keys matching ${x.pattern || '*'}`;
    case 'open-logs':
      await goTo({ connId: conn.id, db: x.database });
      dispatch({ command: 'logs' });
      return 'Logs open';
    case 'refresh':
      await goTo({ connId: conn.id, db: x.database });
      dispatch({ command: 'refresh' });
      return 'Reloaded';
    case 'write-query':
      await goTo({ connId: conn.id, db: x.database, mode: 'query' });
      dispatch({ command: 'queryText', text: need(x.query, 'query') });
      return 'In a new Query editor, not run: check it and press Run';
    case 'run-query':
      await goTo({ connId: conn.id, db: x.database, mode: 'query' });
      dispatch({ command: 'queryText', text: need(x.query, 'query'), run: true });
      return isReadOnly(conn) ? 'Run (Read-only: changes are refused)' : isProd(conn) ? 'Run: Production asks before any change' : 'Run: see the results';
    case 'export':
      await goTo({ connId: conn.id, db: x.database });
      dispatch({ command: 'export', tables: list(x.tables), format: x.format });
      return 'Export dialog open: choose where to save';
    case 'backup':
      await goTo({ connId: conn.id });
      dispatch({ command: 'backup', databases: list(x.databases) });
      return 'Backup dialog open';
    case 'import':
      await goTo({ connId: conn.id, db: x.database });
      dispatch({ command: 'import', format: x.format });
      return 'Import dialog open: choose the file';
    case 'create-database':
      await goTo({ connId: conn.id });
      dispatch({ command: 'dbCreate', name: x.name });
      return 'Create database dialog open';
    case 'create-table':
      await goTo({ connId: conn.id, db: x.database });
      dispatch({ command: 'tableCreate', name: x.name });
      return 'Create table dialog open';
    case 'rename-table':
      await goTo({ connId: conn.id, db: x.database, table: need(x.table, 'table') });
      dispatch({ command: 'tableRename', table: x.table, name: x.name });
      return 'Rename dialog open';
    case 'truncate-table':
      await goTo({ connId: conn.id, db: x.database, table: need(x.table, 'table') });
      dispatch({ command: 'tableTruncate', table: x.table });
      return `Confirm in the dialog: type ${x.table} to empty it`;
    case 'drop-table':
      await goTo({ connId: conn.id, db: x.database, table: need(x.table, 'table') });
      dispatch({ command: 'tableDrop', table: x.table });
      return `Confirm in the dialog: type ${x.table} to drop it`;
    case 'drop-database':
      if (isKv(conn.engine) || conn.engine === 'elasticsearch') throw new Error(`${conn.name} has no databases to drop`);
      await goTo({ connId: conn.id, db: need(x.database, 'database') });
      dispatch({ command: 'dbDrop' });
      return `Confirm in the dialog: type ${x.database} to drop it`;
    case 'flush-keys':
      if (!isKv(conn.engine)) throw new Error('Flushing keys is for Redis / Valkey');
      await goTo({ connId: conn.id, db: need(x.database, 'database') });
      dispatch({ command: 'dbFlush' });
      return `Confirm in the dialog: type ${x.database} to flush it`;
    case 'edit-connection':
      if (conn.serviceId) throw new Error(`${conn.name} is a DevCatz service: change it in DevCatz`);
      editing.value = conn;
      showSettings.value = false;
      active.value = 'home';
      return 'Connection form open';
    case 'open-devcatz': {
      if (!conn.serviceId) throw new Error(`${conn.name} is not a DevCatz service`);
      const found = await api.openInDevCatz(conn.serviceId);
      if (!found) {
        await openDevCatzDownload();
        throw new Error(`DevCatz is not installed on ${words.thisComputer}: its download page is open`);
      }
      return `DevCatz opened at ${conn.name}${conn.running ? '' : ': start it there'}`;
    }
    case 'disconnect':
      await api.dvDisconnect(conn.id);
      await refreshConnections();
      return `Disconnected from ${conn.name}`;
  }
  throw new Error(`DBCatz does not know the step ${a.kind}`);
}

/** How risky a step is: danger (removes data or structure), write (changes something), or null. */
export function askRisk(a: DvAskAction): 'danger' | 'write' | null {
  if (DV_ASK_DESTRUCTIVE.includes(a.kind)) return 'danger';
  if (a.kind === 'run-query' && a.args.query) {
    const conn = connections.value.find((c) => c.id === a.connection);
    if (conn) {
      const kinds = statements(conn, a.args.query).map((s) => statementKind(conn.engine, s));
      if (kinds.some((k) => k.destructive)) return 'danger';
      if (kinds.some((k) => !k.read)) return 'write';
    }
  }
  return DV_ASK_WRITES.includes(a.kind) ? 'write' : null;
}

function statements(conn: DvConnection, text: string): string[] {
  if (isSql(conn.engine)) return splitStatements(text);
  if (conn.engine === 'mongodb') return text.split(/\n(?=db\.|\{)/).map((s) => s.trim()).filter(Boolean);
  if (conn.engine === 'elasticsearch') return text.split(/\n(?=(?:GET|POST|PUT|DELETE|HEAD)\s)/i).map((s) => s.trim()).filter(Boolean);
  return text.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

/** What a risky step does, in plain words, before it is allowed to continue (the Review box). */
export function askConsequence(a: DvAskAction): string {
  const conn = connections.value.find((c) => c.id === a.connection);
  const where = conn ? `${conn.name}${isProd(conn) ? ' (PRODUCTION)' : ''}` : 'this connection';
  const x = a.args;
  switch (a.kind) {
    case 'drop-table':
      return `Deletes ${x.table}${x.database ? ` in ${x.database}` : ''} on ${where}, its structure and all its rows. DBCatz checks foreign keys first, then asks you to type ${x.table}. There is no undo.`;
    case 'truncate-table':
      return `Deletes every row of ${x.table} on ${where}; the table itself stays. You type ${x.table} to confirm. There is no undo.`;
    case 'drop-database':
      return `Deletes the database ${x.database} on ${where} with every table and row in it. You type ${x.database} to confirm. There is no undo.`;
    case 'flush-keys':
      return `Deletes every key in ${x.database} on ${where}. You type ${x.database} to confirm. There is no undo.`;
    case 'run-query':
      return `Runs on ${where}:\n${x.query}\n\nIt changes or removes data: DBCatz asks once more before it runs${conn && isProd(conn) ? ', with the connection name typed (Production)' : ''}.`;
    default:
      return `Changes ${where}: ${a.label}.`;
  }
}

/** The step's target in a few words, under its label. */
export function askDetail(a: DvAskAction): string {
  // Steps about the app itself name no connection.
  const conn = ['set-theme', 'open-settings', 'open-jobs', 'new-connection'].includes(a.kind) ? undefined : connections.value.find((c) => c.id === a.connection);
  const x = a.args;
  return [conn && `${conn.name}${isProd(conn) ? ' · PROD' : isReadOnly(conn) ? ' · READ-ONLY' : ''}`, x.database, x.table, x.view, x.where && `where ${x.where}`, x.pattern, x.tables, x.databases, x.format, x.name, x.tab, x.theme].filter(Boolean).join(' · ');
}
