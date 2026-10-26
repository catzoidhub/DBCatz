import { reactive, ref } from 'vue';
import type { DbEngine, DvConnection, DvConnectProgress, DvJob } from '@shared/types';
import { DV_DOCUMENT, DV_KEYVALUE, DV_SQL } from '@shared/types';
import { api } from '../store';

/**
 * DBCatz window state: the open tabs (one per connection, plus the
 * "connections" tab), the connection list, jobs and the command bus the
 * native menu / context menus feed.
 */

export interface Tab {
  /** `home`, or a unique tab id (several tabs may show one connection). */
  id: string;
  connection: DvConnection | null;
  /** Database / table to open first (a duplicated tab starts where its source was). */
  initialDb?: string;
  initialTable?: string;
  /** View to open first (back / forward to a closed tab). */
  initialMode?: string;
}
/** Each workspace tells where it is, so a tab can be duplicated. */
export const tabState = new Map<string, () => { db: string; table: string }>();
let tabSeq = 0;

export const connections = ref<DvConnection[]>([]);
export const tabs = ref<Tab[]>([{ id: 'home', connection: null }]);
export const active = ref('home');
export const jobs = ref<DvJob[]>([]);
/** The Jobs panel (top bar); a started export / import / backup opens it. */
export const showJobs = ref(false);
/** Connection attempts in progress (or just ended), by token. */
export const progress = reactive(new Map<string, DvConnectProgress>());
export const newToken = (what: string) => `${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** Prefilled connection to edit on the home tab (null = new). */
export const editing = ref<DvConnection | null>(null);

export type Command = {
  command: string;
  table?: string;
  db?: string;
  /** Ask DBCatz: a query for a new editor, and the dialogs' presets. */
  text?: string;
  tables?: string[];
  databases?: string[];
  format?: string;
  name?: string;
  /** queryText: run it at once (through Run, with its usual checks). keysPattern: the pattern. */
  run?: boolean;
  pattern?: string;
};
type Listener = (c: Command) => void;
const listeners = new Set<Listener>();
/** The active workspace listens for menu commands. */
export function onCommand(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function dispatch(c: Command): void {
  for (const l of listeners) l(c);
}

export async function refreshConnections(): Promise<void> {
  connections.value = await api.dvConnections();
  for (const t of tabs.value) if (t.connection) t.connection = connections.value.find((c) => c.id === t.connection!.id) ?? t.connection;
}

/** Opens the tab of a connection (focuses an existing one unless `fresh`), optionally at a database / table. */
export function openTab(conn: DvConnection, opts: { fresh?: boolean; db?: string; table?: string; mode?: string } = {}): void {
  const existing = opts.fresh ? null : tabs.value.find((t) => t.connection?.id === conn.id);
  if (existing) {
    active.value = existing.id;
    return;
  }
  const id = `tab-${++tabSeq}`;
  tabs.value.push({ id, connection: conn, initialDb: opts.db, initialTable: opts.table, initialMode: opts.mode });
  active.value = id;
}

/** Another tab of the same connection, starting at the same database and table. */
export function duplicateTab(id: string): void {
  const t = tabs.value.find((x) => x.id === id);
  if (!t?.connection) return;
  const where = tabState.get(id)?.();
  openTab(t.connection, { fresh: true, db: where?.db, table: where?.table });
}

export function closeTab(id: string): void {
  if (id === 'home') return;
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs.value.splice(i, 1);
  tabState.delete(id);
  if (active.value === id) active.value = tabs.value[Math.min(i, tabs.value.length - 1)]?.id ?? 'home';
}

export function closeOtherTabs(id: string): void {
  for (const t of [...tabs.value]) if (t.id !== id && t.id !== 'home') closeTab(t.id);
  active.value = id;
}

export function cycleTab(dir: 1 | -1): void {
  const i = tabs.value.findIndex((t) => t.id === active.value);
  active.value = tabs.value[(i + dir + tabs.value.length) % tabs.value.length].id;
}

export const ENGINE_NAME: Record<DbEngine, string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgresql: 'PostgreSQL', redis: 'Redis', valkey: 'Valkey', mongodb: 'MongoDB', elasticsearch: 'Elasticsearch', sqlite: 'SQLite' };
export const DEFAULT_PORT: Record<DbEngine, number> = { mysql: 3306, mariadb: 3306, postgresql: 5432, redis: 6379, valkey: 6379, mongodb: 27017, elasticsearch: 9200, sqlite: 0 };
export const isSql = (e: DbEngine) => DV_SQL.includes(e);
export const isDoc = (e: DbEngine) => DV_DOCUMENT.includes(e);
export const isKv = (e: DbEngine) => DV_KEYVALUE.includes(e);

/**
 * The Data grid's filter for a link's column = value: identifiers quoted and values escaped for the engine (SQL), or
 * JSON (MongoDB filter, Elasticsearch match query). The value is always compared as text; nothing from the link runs
 * as written.
 */
export function linkWhere(engine: DbEngine, col: string, val: string): string {
  if (engine === 'mongodb') return JSON.stringify({ [col]: val });
  if (engine === 'elasticsearch') return JSON.stringify({ match: { [col]: val } });
  const mysqlLike = engine === 'mysql' || engine === 'mariadb';
  const ident = mysqlLike ? `\`${col.replace(/`/g, '``')}\`` : `"${col.replace(/"/g, '""')}"`;
  const text = (mysqlLike ? val.replace(/\\/g, '\\\\') : val).replace(/'/g, "''");
  return `${ident} = '${text}'`;
}

/** What the engine calls its things (keeps the UI honest for every engine). */
export function words(e: DbEngine) {
  if (isKv(e)) return { db: 'database', dbs: 'databases', table: 'key', tables: 'keys', row: 'key', rows: 'keys', query: 'command' };
  if (e === 'mongodb') return { db: 'database', dbs: 'databases', table: 'collection', tables: 'collections', row: 'document', rows: 'documents', query: 'query' };
  if (e === 'elasticsearch') return { db: 'cluster', dbs: 'clusters', table: 'index', tables: 'indices', row: 'document', rows: 'documents', query: 'request' };
  if (e === 'sqlite') return { db: 'file', dbs: 'files', table: 'table', tables: 'tables', row: 'row', rows: 'rows', query: 'SQL' };
  return { db: 'database', dbs: 'databases', table: 'table', tables: 'tables', row: 'row', rows: 'rows', query: 'SQL' };
}

/** Databases the server ships with (shown under a System group, never picked first). */
export const SYSTEM_DBS: Partial<Record<DbEngine, string[]>> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  mariadb: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgresql: ['postgres', 'template0', 'template1'],
  mongodb: ['admin', 'config', 'local'],
};
export const isSystemDb = (e: DbEngine, db: string) => (SYSTEM_DBS[e] ?? []).includes(db);

/**
 * Tables the server keeps for itself inside the `mysql` schema (MySQL 5.7–9 and
 * MariaDB): grants, time zones, help, replication, statistics, logs …
 */
const MYSQL_SCHEMA_TABLES = new Set([
  'columns_priv', 'column_stats', 'component', 'db', 'default_roles', 'engine_cost', 'event', 'func', 'general_log', 'global_grants', 'global_priv',
  'gtid_executed', 'gtid_slave_pos', 'help_category', 'help_keyword', 'help_relation', 'help_topic', 'index_stats', 'innodb_index_stats',
  'innodb_table_stats', 'ndb_binlog_index', 'password_history', 'plugin', 'proc', 'procs_priv', 'proxies_priv', 'role_edges', 'roles_mapping',
  'server_cost', 'servers', 'slave_master_info', 'slave_relay_log_info', 'slave_worker_info', 'slow_log', 'table_stats', 'tables_priv', 'time_zone',
  'time_zone_leap_second', 'time_zone_name', 'time_zone_transition', 'time_zone_transition_type', 'transaction_registry', 'user',
]);
const MYSQL_SCHEMA_PREFIX = /^(replication_|innodb_|ndb_|gtid_|firewall_|audit_log_|component_|slave_|time_zone)/;

/**
 * A table the database ships with rather than one the user made — listed apart
 * (System tables) so the user's own are easy to find: everything in MySQL's
 * information_schema / performance_schema / sys and the server's own tables in
 * `mysql`; SQLite's sqlite_*; MongoDB's system.* and the admin / config / local
 * databases; Elasticsearch's hidden (dot) indices.
 */
export function isSystemTable(e: DbEngine, db: string, table: string): boolean {
  switch (e) {
    case 'mysql':
    case 'mariadb':
      if (db === 'information_schema' || db === 'performance_schema' || db === 'sys') return true;
      return db === 'mysql' && (MYSQL_SCHEMA_TABLES.has(table.toLowerCase()) || MYSQL_SCHEMA_PREFIX.test(table.toLowerCase()));
    case 'postgresql':
      return /^(pg_catalog|information_schema|pg_toast)\./.test(table);
    case 'sqlite':
      return /^sqlite_/i.test(table);
    case 'mongodb':
      return db === 'admin' || db === 'config' || db === 'local' || table.startsWith('system.');
    case 'elasticsearch':
      return table.startsWith('.');
    default:
      return false;
  }
}

/** host:port / socket / via SSH line for a connection. */
export function DV_HINT(c: DvConnection): string {
  if (c.engine === 'sqlite') return c.file;
  const target = c.method === 'socket' ? c.socket : `${c.host}:${c.port}`;
  if (c.method === 'ssh' && c.ssh) return `${target} via SSH ${c.ssh.user}@${c.ssh.host}`;
  if (c.method === 'aws-iam') return `${target} · AWS IAM${c.user ? ` as ${c.user}` : ''}`;
  if (c.method === 'vault') return `${target} · credentials from Vault`;
  return `${c.user ? `${c.user}@` : ''}${target}${c.options?.requireSsl ? ' · SSL' : ''}`;
}

/** Production connections ask before writes; Read-only ones refuse them. */
export const isProd = (c: DvConnection | null | undefined) => c?.options?.mode === 'production';
export const isReadOnly = (c: DvConnection | null | undefined) => c?.options?.mode === 'readonly';

/** One question before a write (shown by DbCatzApp); `word` = what to type to go ahead, or null for a click. */
export interface WriteAsk {
  title: string;
  detail: string;
  statements: string[];
  word: string | null;
  tone: 'warning' | 'error';
  action: string;
  resolve: (ok: boolean) => void;
}
export const writeAsk = ref<WriteAsk | null>(null);
export function askWrite(o: Omit<WriteAsk, 'resolve' | 'statements' | 'tone' | 'action'> & Partial<Pick<WriteAsk, 'statements' | 'tone' | 'action'>>): Promise<boolean> {
  return new Promise((resolve) => {
    writeAsk.value = { statements: [], tone: 'warning', action: 'Go ahead', ...o, resolve: (ok) => {
      writeAsk.value = null;
      resolve(ok);
    } };
  });
}
/** Asks only on Production connections (one click), e.g. before a grid edit. */
export async function confirmProdWrite(c: DvConnection, what: string, statement = ''): Promise<boolean> {
  if (!isProd(c)) return true;
  return askWrite({ title: `${what} on ${c.name}?`, detail: `${c.name} is a Production connection: this changes the live database.`, statements: statement ? [statement] : [], word: null, action: what });
}

export const fmtBytes = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
export const fmtNum = (n: number | null) => (n === null ? '' : n.toLocaleString('en-US'));
export const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);
export const fmtTtl = (s: number) => (s < 0 ? 'no expiry' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);

/** Colour swatches for saved connections. */
export const COLORS = ['oklch(70% 0.16 25)', 'oklch(76% 0.15 78)', 'oklch(70% 0.16 150)', 'oklch(70% 0.13 235)', 'oklch(66% 0.17 300)', 'oklch(70% 0.15 350)'];

/** What DBCatz did on a connection (queries, edits, DDL), newest first, for the Logs tab. */
export interface Activity {
  time: number;
  text: string;
  ms: number | null;
  affected: number | null;
  error: string | null;
}
export const activity = reactive(new Map<string, Activity[]>());
export function logActivity(connId: string, a: Omit<Activity, 'time'> & { time?: number }): void {
  const list = activity.get(connId) ?? [];
  list.unshift({ time: a.time ?? Date.now(), text: a.text, ms: a.ms ?? null, affected: a.affected ?? null, error: a.error ?? null });
  if (list.length > 500) list.length = 500;
  activity.set(connId, list);
}

/** Query history per database of a connection (kept for the window's life), like saved queries. */
export const history = reactive(new Map<string, string[]>());
export const historyKey = (connId: string, db: string) => `${connId}\n${db}`;
export function remember(connId: string, db: string, text: string): void {
  const key = historyKey(connId, db);
  const list = history.get(key) ?? [];
  const next = [text, ...list.filter((t) => t !== text)].slice(0, 50);
  history.set(key, next);
}

/** Minimal SQL formatter for the Format command: keywords on their own lines. */
export function formatSql(sql: string): string {
  const kw = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'JOIN', 'UNION', 'VALUES', 'SET', 'INSERT INTO', 'UPDATE', 'DELETE FROM'];
  // Quoted strings and identifiers are kept as they are; only the rest is reflowed.
  const parts = sql.replace(/\s+/g, ' ').trim().split(/('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`)/);
  return parts
    .map((p, i) => {
      if (i % 2) return p;
      for (const k of kw) {
        // JOIN on its own, not the second word of LEFT / RIGHT / INNER JOIN.
        const before = k === 'JOIN' ? '(?<!(?:LEFT|RIGHT|INNER|OUTER|CROSS))' : '';
        p = p.replace(new RegExp(`${before}(^|\\s+)${k.replace(' ', '\\s+')}(?=\\s|$)`, 'gi'), (_m, _pre, at: number) => (i === 0 && at === 0 ? k : `\n${k}`));
      }
      return p
        .replace(/\b(as|on|and|or|not|null|is|in|like|between|distinct|asc|desc|case|when|then|else|end)\b/gi, (w) => w.toUpperCase())
        .replace(/,\s*(?=\S)/g, ',\n  ')
        .replace(/\s+(AND|OR)\b/g, '\n  $1');
    })
    .join('');
}
