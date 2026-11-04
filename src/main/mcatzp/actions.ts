import type { ActionContext, ActionDef, CallResult } from '@catzoid/mcatzp-host';
import type { DbCatzApi, DvConnection, DvResult } from '@shared/types';
import { DV_KEYVALUE } from '@shared/types';
import { maskSecrets } from '../ai';
import { assertReadQuery } from './readquery';
import { ALTER_OPS, alterOps } from './schema';

/**
 * DBCatz's actions for MCatzP (TODO §16): each one calls the same `api()` method its UI uses. This is the read tier.
 * What goes out is picked field by field, never a whole connection: those hold SSH, AWS and Vault settings.
 * Values under a secret-looking column, field or key name go out as ••• ; text that can carry secrets goes through the
 * AI's masking. A password is never read at all: the window has none, and neither do these.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const NAME = (description: string) => ({ type: 'string', minLength: 1, maxLength: 512, description });
const CONNECTION = NAME("The connection's id or name (see list_connections).");
const DATABASE = NAME('The database (see list_databases). Redis / Valkey: db0, db1 …');
const TABLE = NAME('The table or view. MongoDB: a collection. Elasticsearch: an index.');

export const reply = (data: unknown): CallResult => ({ text: JSON.stringify(data, null, 2), data });

const SECRET_NAME = /passw(or)?d|passphrase|\bpwd\b|secret|token|api_?key|private_?key|credential|\bsalt\b|\botp\b/i;
const MAX_CELL = 2000;
const cut = (s: string) => (s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}… (${s.length} characters, cut)` : s);

/** One value for the client: readable as JSON whatever the driver returned. */
function cell(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<binary, ${v.length} bytes>`;
  const text = typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return cut(maskSecrets(text ?? ''));
}

/** Rows as objects by column, with secret-looking columns masked; `masked` names them, so the client can say why. */
function rowsOut(columns: string[], rows: unknown[][]): { rows: Record<string, unknown>[]; masked?: string[] } {
  const secret = columns.map((c) => SECRET_NAME.test(c));
  const out = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, secret[i] && r[i] !== null ? '•••' : cell(r[i])])));
  const masked = columns.filter((_, i) => secret[i]);
  return { rows: out, ...(masked.length ? { masked } : {}) };
}

/** One connection by id or name; a name two connections share is refused rather than guessed. */
export function findConnection(all: DvConnection[], ref: string): DvConnection {
  const list = all.filter((c) => !c.temporary);
  const byId = list.find((c) => c.id === ref);
  if (byId) return byId;
  const r = ref.trim().toLowerCase();
  const named = list.filter((c) => c.name.toLowerCase() === r);
  if (named.length > 1) throw new Error(`${named.length} connections are called ${ref}: use the id (list_connections)`);
  if (!named.length) throw new Error(`No connection ${ref} (list_connections shows them)`);
  return named[0];
}

/** What the user shares (Settings → MCatzP). */
export interface Scopes {
  connection(c: DvConnection): boolean;
  /** Rows, query results and key values; off = only the structure. */
  rows: boolean;
  /** Clients may ask for changes; off = they only read. */
  changes: boolean;
}

/** The part of the viewer the read tier needs beyond the API. */
export interface ReadQuery {
  readQuery(id: string, db: string, text: string, timeoutMs: number, signal: AbortSignal): Promise<DvResult[]>;
}

/** Query results for the client: cut at `max` rows, secret-looking columns masked. */
export function resultsOut(results: DvResult[], max: number): unknown {
  return results.map((r) => ({
    statement: r.statement,
    ...(r.error ? { error: maskSecrets(r.error) } : { columns: r.columns, rowCount: r.rows.length, ...(r.affected !== null ? { affected: r.affected } : {}), ...(r.rows.length > max ? { cutAt: max } : {}), ...rowsOut(r.columns, r.rows.slice(0, max)) }),
    ms: r.ms,
  }));
}

/** Tabs that live in the window's own state, read through it. */
export interface WindowReads {
  queryLog(connId: string): Promise<{ time: number; text: string; ms: number | null; affected: number | null; error: string | null }[]>;
  queryHistory(connId: string, db: string): Promise<string[]>;
}

const NOTHING_SHARED = 'No connections are shared with MCatzP yet: the user chooses them in DBCatz, Settings → MCatzP.';

export function readActions(api: DbCatzApi, viewer: ReadQuery, scopes: Scopes, windowReads: WindowReads, logQuery: (connId: string, r: { text: string; ms: number; affected: number | null; error: string | null }) => void): ActionDef[] {
  const conn = async (ref: unknown) => findConnection(await api.dvConnections(), String(ref));
  const read = (name: string, title: string, description: string, input: ReturnType<typeof OBJECT>, run: (args: Record<string, unknown>, ctx: ActionContext) => Promise<CallResult>): ActionDef => ({ name, title, description, tier: 'read', input, run });
  const keys = async (ref: unknown) => {
    const c = await conn(ref);
    if (!DV_KEYVALUE.includes(c.engine)) throw new Error(`${c.name} is ${c.engine}: keys are for Redis / Valkey. Use list_tables and read_rows`);
    return c;
  };

  const structure = [
    read('list_connections', 'List connections', 'The connections shared with you: id, name, engine, where it is, its mode (normal, production, readonly), whether it is running and connected, and its source: saved by the user, or a service from DevCatz or DoCatz. No passwords.', OBJECT(), async () => {
      const [all, layout] = await Promise.all([api.dvConnections(), api.dvLayout()]);
      const list = all.filter((c) => scopes.connection(c));
      if (!list.length) return { text: NOTHING_SHARED, data: [] };
      return reply(
        list.map((c) => ({
          id: c.id,
          name: c.name,
          engine: c.engine,
          ...(c.engine === 'sqlite' ? { file: c.file.split(/[\\/]/).pop() } : { host: c.host, port: c.port }),
          database: c.database || null,
          mode: c.options.mode,
          source: c.serviceApp ?? 'saved',
          ...(c.project ? { project: c.project } : {}),
          running: c.running,
          connected: c.connected,
          favorite: layout.favorites.includes(c.id),
          group: layout.groups.find((g) => g.members.includes(c.id))?.name ?? null,
        })),
      );
    }),
    read('server_info', 'Server version', "The server's version. Connects if DBCatz is not connected yet.", OBJECT({ connection: CONNECTION }, ['connection']), async ({ connection }) => {
      const c = await conn(connection);
      return reply({ connection: c.name, version: (await api.dvServerInfo(c.id)).version });
    }),
    read('list_databases', 'List databases', 'The databases of a connection, with the ones the user starred and used lately.', OBJECT({ connection: CONNECTION }, ['connection']), async ({ connection }) => {
      const c = await conn(connection);
      const [databases, prefs] = await Promise.all([api.dvDatabases(c.id), api.dvDbPrefs(c.id)]);
      return reply({ databases, starred: prefs.favorites, recent: prefs.recent });
    }),
    read('list_tables', 'List tables', 'Tables and views of a database (MongoDB: collections; Elasticsearch: indexes), with estimated rows and size when the engine reports them. Redis / Valkey have keys instead: list_keys.', OBJECT({ connection: CONNECTION, database: DATABASE }, ['connection', 'database']), async ({ connection, database }) => {
      const c = await conn(connection);
      return reply(await api.dvTables(c.id, String(database)));
    }),
    read('describe_table', 'Describe a table', 'Columns with their types, indexes, foreign keys, the primary key and the CREATE statement.', OBJECT({ connection: CONNECTION, database: DATABASE, table: TABLE }, ['connection', 'database', 'table']), async ({ connection, database, table }) => {
      const c = await conn(connection);
      const s = await api.dvStructure(c.id, String(database), String(table));
      return reply({ columns: s.columns, indexes: s.indexes, foreignKeys: s.foreignKeys, primaryKey: s.primaryKey, ddl: maskSecrets(s.ddl) });
    }),
    read('list_column_types', 'List column types', 'The column types this server offers.', OBJECT({ connection: CONNECTION }, ['connection']), async ({ connection }) => reply(await api.dvTypes((await conn(connection)).id))),
    read('list_charsets', 'List character sets', 'The character sets and collations this server offers.', OBJECT({ connection: CONNECTION }, ['connection']), async ({ connection }) => reply(await api.dvCharsets((await conn(connection)).id))),
    read('list_saved_queries', 'List saved queries', 'The queries the user saved for this database, with their text (secrets masked).', OBJECT({ connection: CONNECTION, database: DATABASE }, ['connection', 'database']), async ({ connection, database }) => {
      const c = await conn(connection);
      return reply((await api.dvSavedQueries(c.id, String(database))).map((q) => ({ name: q.name, text: maskSecrets(q.text), updated: new Date(q.updated).toISOString() })));
    }),
    read('check_alter', 'Check a table change', 'What alter_table would risk, without changing anything: data that would not fit, a dropped column, what points at it. `level` is none, warn, danger (the user types a name) or block (refused).', OBJECT({ connection: CONNECTION, database: DATABASE, table: TABLE, ops: ALTER_OPS }, ['connection', 'database', 'table', 'ops']), async ({ connection, database, table, ops }) => {
      const c = await conn(connection);
      return reply(await api.dvAlterCheck(c.id, String(database), String(table), alterOps(ops)));
    }),
    read('list_jobs', 'List jobs', 'Exports, imports and backups on the shared connections: how far each is, and how it ended. Check here after starting one, and tell the user.', OBJECT(), async () => {
      const [jobs, all] = await Promise.all([api.dvJobs(), api.dvConnections()]);
      const shared = new Set(all.filter((c) => scopes.connection(c)).map((c) => c.id));
      return reply(jobs.filter((j) => shared.has(j.connId)).map((j) => ({ id: j.id, kind: j.kind, title: j.title, connection: j.connId, done: j.done, total: j.total, finished: j.finished, cancelled: j.cancelled === true, error: j.error ? maskSecrets(j.error) : null })));
    }),
  ];

  const data = [
    read('list_query_log', 'Read the query log', "What ran on this connection since DBCatz opened, the newest first: the Logs tab. Statements, how long they took, rows changed and errors, with secrets masked.", OBJECT({ connection: CONNECTION, limit: { type: 'integer', minimum: 1, maximum: 500, description: '100 when left out.' } }, ['connection']), async ({ connection, limit }) => {
      const c = await conn(connection);
      return reply((await windowReads.queryLog(c.id)).slice(0, Number(limit ?? 100)).map((e) => ({ time: new Date(e.time).toISOString(), text: maskSecrets(e.text), ms: e.ms, affected: e.affected, error: e.error ? maskSecrets(e.error) : null })));
    }),
    read('list_query_history', 'Read the query history', 'Queries the user ran on this database since DBCatz opened, the newest first: the History list of the Query tab. Secrets masked.', OBJECT({ connection: CONNECTION, database: DATABASE }, ['connection', 'database']), async ({ connection, database }) => {
      const c = await conn(connection);
      return reply((await windowReads.queryHistory(c.id, String(database))).map(maskSecrets));
    }),
    read(
      'read_rows',
      'Read rows',
      'Rows of a table, a page at a time. Values under secret-looking columns come back as ••• and `masked` names those columns. To filter or join, use run_read_query.',
      OBJECT({ connection: CONNECTION, database: DATABASE, table: TABLE, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Rows in this page; 50 when left out.' }, offset: { type: 'integer', minimum: 0, description: 'Rows to skip.' }, order_by: NAME('A column to sort by.'), descending: { type: 'boolean' } }, ['connection', 'database', 'table']),
      async ({ connection, database, table, limit, offset, order_by: orderBy, descending }) => {
        const c = await conn(connection);
        // No WHERE from here: a filter is SQL, and SQL goes through run_read_query's check.
        const r = await api.dvRows(c.id, String(database), String(table), { limit: Number(limit ?? 50), offset: Number(offset ?? 0), orderBy: orderBy === undefined ? null : String(orderBy), desc: descending === true, where: '' });
        return reply({ total: r.total, primaryKey: r.primaryKey, columns: r.columns, ...rowsOut(r.columns, r.rows) });
      },
    ),
    read(
      'run_read_query',
      'Run a read-only query',
      "Runs a query that only reads: SELECT, SHOW, EXPLAIN, DESCRIBE (SQL), find / aggregate without $out (MongoDB), GET and _search (Elasticsearch), GET / HGETALL and the like (Redis, one command per line). Anything else is refused and names the statement. Results are cut at max_rows; values under secret-looking columns come back as ••• .",
      OBJECT({ connection: CONNECTION, database: DATABASE, query: { type: 'string', minLength: 1, maxLength: 100000 }, max_rows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Rows per statement; 100 when left out.' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 120, description: 'Gives up after this long; 30 when left out.' } }, ['connection', 'database', 'query']),
      async ({ connection, database, query, max_rows: maxRows, timeout_seconds: timeout }, ctx) => {
        const c = await conn(connection);
        assertReadQuery(c.engine, String(query));
        const max = Number(maxRows ?? 100);
        const results = await viewer.readQuery(c.id, String(database), String(query), Number(timeout ?? 30) * 1000, ctx.signal);
        for (const r of results) logQuery(c.id, { text: r.statement, ms: r.ms, affected: r.affected, error: r.error });
        return reply(resultsOut(results, max));
      },
    ),
    read(
      'list_keys',
      'List keys',
      'Redis / Valkey: keys matching a glob, with type, TTL in seconds (-1 = no expiry) and size.',
      OBJECT({ connection: CONNECTION, database: DATABASE, pattern: { type: 'string', minLength: 1, maxLength: 512, description: 'A glob; * when left out.' }, limit: { type: 'integer', minimum: 1, maximum: 1000, description: '200 when left out.' } }, ['connection', 'database']),
      async ({ connection, database, pattern, limit }) => {
        const c = await keys(connection);
        return reply(await api.dvKeys(c.id, String(database), String(pattern ?? '*'), Number(limit ?? 200)));
      },
    ),
    read('get_key', 'Read a key', "Redis / Valkey: a key's value (a large one is cut: `shown` of `size`). A secret-looking key or hash field comes back as ••• .", OBJECT({ connection: CONNECTION, database: DATABASE, key: NAME('The key.') }, ['connection', 'database', 'key']), async ({ connection, database, key }) => {
      const c = await keys(connection);
      const k = await api.dvKey(c.id, String(database), String(key));
      const value = SECRET_NAME.test(k.key)
        ? '•••'
        : typeof k.value === 'string'
          ? cell(k.value)
          : (k.value as (string | [string, string])[]).map((v) => (Array.isArray(v) ? [v[0], SECRET_NAME.test(v[0]) ? '•••' : cell(v[1])] : cell(v)));
      return reply({ key: k.key, type: k.type, ttl: k.ttl, size: k.size, shown: k.shown, value });
    }),
  ];

  return scopes.rows ? [...structure, ...data] : structure;
}
