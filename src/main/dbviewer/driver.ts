import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import { authPlugins as mysqlAuth } from 'mysql2';
import { createReadStream } from 'node:fs';
import pg from 'pg';
import { EsDriver, MongoDriver, RedisDriver } from './nosql';
import { DV_DEFAULT_OPTIONS, type DvOptions } from '@shared/types';
import type { DvCharsets, DvColumn, DvColumnDef, DvEngine, DvForeignKey, DvIndex, DvKey, DvKeyInput, DvKeyValue, DvRows, DvRowsQuery, DvStructure, DvTable } from '@shared/types';

/**
 * One connection of the database viewer, the same calls for MySQL / MariaDB
 * (mysql2), PostgreSQL (pg, a pool per database) and SQLite (node:sqlite, a
 * folder of files or one file). Values come back as plain JSON-safe values:
 * dates and big numbers as strings, binary as 0x… hex.
 */

export interface ConnectSettings {
  engine: DvEngine;
  host: string;
  port: number;
  user: string;
  /** A function for tokens that expire (AWS IAM): asked for each new connection. */
  password: string | (() => Promise<string>);
  database: string;
  /** SQLite: a folder of database files, or one file. */
  file: string;
  /** A local socket instead of host:port. */
  socket?: string;
  /** Connection options (see DvOptions); undefined = defaults. */
  options?: Partial<DvOptions>;
  /** Extra CA certificates (PEM), e.g. Amazon RDS's bundle. */
  ca?: string;
  /** Server name for TLS when `host` is a tunnel (127.0.0.1). */
  servername?: string;
}

const opt = (s: ConnectSettings): DvOptions => ({ ...DV_DEFAULT_OPTIONS, ...(s.options ?? {}) });
/** Node TLS options for `requireSsl`, or undefined. */
export function tlsOf(s: ConnectSettings): { rejectUnauthorized: boolean; ca?: string; servername?: string } | undefined {
  const o = opt(s);
  if (!o.requireSsl) return undefined;
  return { rejectUnauthorized: o.verifyCert, ...(s.ca ? { ca: s.ca } : {}), ...(s.servername ? { servername: s.servername } : {}) };
}
export const passwordNow = async (s: ConnectSettings) => (typeof s.password === 'function' ? s.password() : s.password);

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  affected: number | null;
}

export interface Driver {
  readonly engine: DvEngine;
  version(): Promise<string>;
  databases(): Promise<string[]>;
  /** Tables and views; `withSystem` adds the engine's own (SQLite's sqlite_*) for the sidebar's System group — exports never get them. */
  tables(db: string, withSystem?: boolean): Promise<DvTable[]>;
  structure(db: string, table: string): Promise<DvStructure>;
  /** One statement, with ? placeholders (the driver adapts them). */
  query(db: string, sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Several statements at once (imports, DDL scripts). */
  exec(db: string, sql: string): Promise<void>;
  close(): Promise<void>;

  // Document engines (MongoDB, Elasticsearch) do these themselves; SQL engines get them built from SQL in ops.ts.
  rows?(db: string, table: string, q: DvRowsQuery): Promise<DvRows>;
  updateRow?(db: string, table: string, key: Record<string, unknown>, changes: Record<string, unknown>): Promise<void>;
  insertRow?(db: string, table: string, values: Record<string, unknown>): Promise<void>;
  deleteRows?(db: string, table: string, keys: Record<string, unknown>[]): Promise<number>;
  createDatabase?(name: string, options?: { charset: string; collation: string }): Promise<void>;
  /** Character sets and collations for a new database (SQL servers). */
  charsets?(): Promise<DvCharsets>;
  dropDatabase?(name: string): Promise<void>;
  createTable?(db: string, table: string, columns: DvColumnDef[]): Promise<void>;
  dropTable?(db: string, table: string): Promise<void>;
  truncate?(db: string, table: string): Promise<void>;
  renameTable?(db: string, from: string, to: string): Promise<void>;
  addIndex?(db: string, table: string, name: string, columns: string[], unique: boolean): Promise<void>;
  dropIndex?(db: string, table: string, name: string): Promise<void>;
  documents?(db: string, table: string): AsyncGenerator<Record<string, unknown>>;
  insertDocuments?(db: string, table: string, docs: Record<string, unknown>[]): Promise<void>;

  // Key-value engines (Redis, Valkey).
  keys?(db: string, pattern: string, limit: number): Promise<{ keys: DvKey[]; total: number }>;
  key?(db: string, key: string): Promise<DvKeyValue>;
  keySet?(db: string, input: DvKeyInput): Promise<void>;
  keyDelete?(db: string, keys: string[]): Promise<number>;
  keyRename?(db: string, from: string, to: string): Promise<void>;
  flush?(db: string): Promise<void>;
}

const BINARY_PREVIEW = 64;

/** JSON-safe cell value. */
export function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v as Uint8Array);
    return `0x${b.subarray(0, BINARY_PREVIEW).toString('hex')}${b.length > BINARY_PREVIEW ? `… (${b.length} bytes)` : ''}`;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export const quoteIdent = (engine: DvEngine, name: string) =>
  engine === 'mysql' || engine === 'mariadb' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

/** A table name that may carry a PostgreSQL schema (`schema.table`). */
export const quoteTable = (engine: DvEngine, name: string) =>
  engine === 'postgresql' && name.includes('.') ? name.split('.').map((p) => quoteIdent(engine, p)).join('.') : quoteIdent(engine, name);

/** SQL literal for dumps. */
export function literal(engine: DvEngine, v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return engine === 'postgresql' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const hex = Buffer.from(v as Uint8Array).toString('hex');
    return engine === 'postgresql' ? `'\\x${hex}'::bytea` : engine === 'sqlite' ? `X'${hex}'` : `0x${hex || '00'}`;
  }
  if (v instanceof Date) return `'${cell(v)}'`;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (engine === 'mysql' || engine === 'mariadb') return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
  return `'${s.replace(/'/g, "''")}'`;
}

export { splitStatements } from '@shared/sqlsplit';

// ------------------------------------------------------------------ MySQL / MariaDB

/** caching_sha2_password / sha256_password that refuse to ask for the server's RSA key ("Get Public Key" off). */
function noPublicKey(name: 'caching_sha2_password' | 'sha256_password') {
  const factory = (mysqlAuth as Record<string, (o?: object) => (a: { connection: unknown; command: unknown }) => (d: Buffer) => Buffer | null>)[name];
  return (args: { connection: unknown; command: unknown }) => {
    const inner = factory({})(args);
    return (data: Buffer) => {
      const out = inner(data);
      if (Buffer.isBuffer(out) && out.length === 1 && (out[0] === 2 || out[0] === 1) && !(args.connection as { config: { ssl?: unknown } }).config.ssl)
        throw new Error('The server wants to send its RSA public key to finish signing in: turn on "Get Public Key" or "Require SSL"');
      return out;
    };
  };
}

class MysqlDriver implements Driver {
  private pool: mysql.Pool;
  constructor(
    readonly engine: DvEngine,
    s: ConnectSettings,
  ) {
    const o = opt(s);
    const tls = tlsOf(s);
    this.pool = mysql.createPool({
      ...(s.socket ? { socketPath: s.socket } : { host: s.host, port: s.port }),
      user: s.user,
      password: typeof s.password === 'string' ? s.password : '',
      database: s.database || undefined,
      multipleStatements: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      connectionLimit: 4,
      connectTimeout: o.connectTimeout * 1000,
      ...(tls ? { ssl: tls } : {}),
      enableCleartextPlugin: o.cleartext,
      ...(o.localInfile ? { flags: ['+LOCAL_FILES'], infileStreamFactory: (path: string) => createReadStream(path) } : {}),
      ...(o.getPublicKey ? {} : { authPlugins: { caching_sha2_password: noPublicKey('caching_sha2_password'), sha256_password: noPublicKey('sha256_password') } as never }),
    });
    // Session settings on every pooled connection: time zone ('' = the server's), read-only for Read-only connections.
    if (o.timeZone || o.mode === 'readonly') {
      const tz = o.timeZone;
      (this.pool as unknown as { pool: { on(e: 'connection', f: (c: { query(q: string, v: unknown[], cb: (e: Error | null) => void): void }) => void): void } }).pool.on('connection', (c) => {
        if (tz) c.query('SET time_zone = ?', [tz], (e) => e && console.warn(`DBCatz: SET time_zone = ${tz}: ${e.message}`));
        if (o.mode === 'readonly') c.query('SET SESSION TRANSACTION READ ONLY', [], (e) => e && console.warn(`DBCatz: read-only session: ${e.message}`));
      });
    }
  }

  private async on<T>(db: string, fn: (c: mysql.PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    try {
      if (db) await c.query(`USE ${quoteIdent('mysql', db)}`);
      return await fn(c);
    } finally {
      c.release();
    }
  }

  async version() {
    const [rows] = await this.pool.query('SELECT VERSION() AS v');
    return String((rows as { v: string }[])[0].v);
  }

  async databases() {
    const [rows] = await this.pool.query('SHOW DATABASES');
    return (rows as { Database: string }[]).map((r) => r.Database);
  }

  async tables(db: string): Promise<DvTable[]> {
    const [rows] = await this.pool.query(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS rowsEst, DATA_LENGTH + INDEX_LENGTH AS size FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [db],
    );
    return (rows as { name: string; type: string; rowsEst: string | null; size: string | null }[]).map((r) => ({
      name: r.name,
      type: /VIEW/i.test(r.type) ? 'view' : 'table',
      rows: r.rowsEst === null ? null : Number(r.rowsEst),
      size: r.size === null ? null : Number(r.size),
    }));
  }

  async structure(db: string, table: string): Promise<DvStructure> {
    return this.on(db, async (c) => {
      const [cols] = await c.query(`SHOW FULL COLUMNS FROM ${quoteIdent('mysql', table)}`);
      const columns: DvColumn[] = (cols as Record<string, string | null>[]).map((r) => ({
        name: String(r.Field),
        type: String(r.Type),
        nullable: r.Null === 'YES',
        default: r.Default,
        key: r.Key === 'PRI',
        autoIncrement: /auto_increment/i.test(r.Extra ?? ''),
        comment: r.Comment || null,
        extra: r.Extra || null,
        collation: r.Collation || null,
        charset: r.Collation ? r.Collation.split('_')[0] : null,
      }));
      const [idx] = await c.query(`SHOW INDEX FROM ${quoteIdent('mysql', table)}`);
      const byName = new Map<string, DvIndex>();
      for (const r of idx as { Key_name: string; Column_name: string; Non_unique: number | string }[]) {
        const i = byName.get(r.Key_name) ?? { name: r.Key_name, columns: [], unique: Number(r.Non_unique) === 0, primary: r.Key_name === 'PRIMARY' };
        i.columns.push(r.Column_name);
        byName.set(r.Key_name, i);
      }
      const [fks] = await c.query(
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol, r.DELETE_RULE AS onDelete, r.UPDATE_RULE AS onUpdate
         FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
         WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [db, table],
      );
      const fkMap = new Map<string, DvForeignKey>();
      for (const r of fks as { name: string; col: string; refTable: string; refCol: string; onDelete: string; onUpdate: string }[]) {
        const f = fkMap.get(r.name) ?? { name: r.name, columns: [], refTable: r.refTable, refColumns: [], onDelete: r.onDelete, onUpdate: r.onUpdate };
        f.columns.push(r.col);
        f.refColumns.push(r.refCol);
        fkMap.set(r.name, f);
      }
      const [ddlRows] = await c.query(`SHOW CREATE TABLE ${quoteIdent('mysql', table)}`);
      const d = (ddlRows as Record<string, string>[])[0];
      return {
        columns,
        indexes: [...byName.values()],
        foreignKeys: [...fkMap.values()],
        primaryKey: byName.get('PRIMARY')?.columns ?? [],
        ddl: d['Create Table'] ?? d['Create View'] ?? '',
      };
    });
  }

  async charsets(): Promise<DvCharsets> {
    const [cs] = await this.pool.query('SHOW CHARACTER SET');
    const [co] = await this.pool.query('SHOW COLLATION');
    return {
      charsets: (cs as { Charset: string; 'Default collation': string; Description: string }[]).map((r) => ({ name: r.Charset, collation: r['Default collation'], description: r.Description })).sort((a, b) => a.name.localeCompare(b.name)),
      collations: (co as { Collation: string; Charset: string }[]).map((r) => ({ name: r.Collation, charset: r.Charset })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async query(db: string, sql: string, params: unknown[] = []): Promise<QueryResult> {
    return this.on(db, async (c) => {
      const [res, fields] = await c.query({ sql, values: params, rowsAsArray: true });
      if (Array.isArray(res) && fields) return { columns: (fields as mysql.FieldPacket[]).map((f) => f.name), rows: (res as unknown[][]).map((r) => r.map(cell)), affected: null };
      const h = res as mysql.ResultSetHeader;
      return { columns: [], rows: [], affected: h.affectedRows ?? null };
    });
  }

  async exec(db: string, sql: string) {
    await this.on(db, (c) => c.query(sql));
  }

  async close() {
    await this.pool.end();
  }
}

// ------------------------------------------------------------------ PostgreSQL

// Dates, timestamps and intervals as the server prints them.
for (const oid of [1082, 1083, 1114, 1184, 1186, 1266]) pg.types.setTypeParser(oid, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => v); // int8 stays exact

class PgDriver implements Driver {
  readonly engine: DvEngine = 'postgresql';
  private pools = new Map<string, pg.Pool>();
  constructor(private s: ConnectSettings) {}

  private pool(db: string): pg.Pool {
    const name = db || this.s.database || 'postgres';
    let p = this.pools.get(name);
    if (!p) {
      const o = opt(this.s);
      const tls = tlsOf(this.s);
      // A socket: pg wants the folder (it adds .s.PGSQL.<port>).
      const host = this.s.socket ? (/\.s\.PGSQL\.\d+$/.test(this.s.socket) ? this.s.socket.replace(/\/[^/]+$/, '') : this.s.socket) : this.s.host;
      const port = this.s.socket ? Number(/\.s\.PGSQL\.(\d+)$/.exec(this.s.socket)?.[1] ?? this.s.port) : this.s.port;
      const pw = this.s.password;
      p = new pg.Pool({ host, port, user: this.s.user, password: typeof pw === 'string' ? pw : () => pw(), database: name, max: 4, connectionTimeoutMillis: o.connectTimeout * 1000, ssl: tls ?? false, ...(o.timeZone || o.mode === 'readonly' ? { options: [o.timeZone ? `-c TimeZone=${o.timeZone.replace(/[^A-Za-z0-9_/+:-]/g, '')}` : '', o.mode === 'readonly' ? '-c default_transaction_read_only=on' : ''].filter(Boolean).join(' ') } : {}) });
      p.on('error', () => undefined);
      this.pools.set(name, p);
    }
    return p;
  }

  async version() {
    const r = await this.pool('').query('SHOW server_version');
    return `PostgreSQL ${r.rows[0].server_version}`;
  }

  async databases() {
    const r = await this.pool('').query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname');
    return r.rows.map((x) => x.datname as string);
  }

  /** `schema.table` for schemas other than public. */
  private split(table: string): [string, string] {
    const i = table.indexOf('.');
    return i > 0 ? [table.slice(0, i), table.slice(i + 1)] : ['public', table];
  }

  async tables(db: string): Promise<DvTable[]> {
    const r = await this.pool(db).query(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS size
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
       ORDER BY n.nspname <> 'public', n.nspname, c.relname`,
    );
    return r.rows.map((x) => ({
      name: x.schema === 'public' ? x.name : `${x.schema}.${x.name}`,
      type: x.kind === 'v' || x.kind === 'm' ? 'view' : 'table',
      rows: Number(x.rows) < 0 ? null : Number(x.rows),
      size: x.size === null ? null : Number(x.size),
    }));
  }

  async structure(db: string, table: string): Promise<DvStructure> {
    const p = this.pool(db);
    const [schema, name] = this.split(table);
    const cols = await p.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def, col_description(a.attrelid, a.attnum) AS comment, a.attidentity AS ident,
              (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enumvals,
              (SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation AND a.attcollation <> 0 AND a.attcollation <> (SELECT ty.typcollation FROM pg_type ty WHERE ty.oid = a.atttypid)) AS coll
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [schema, name],
    );
    const idx = await p.query(
      `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary, array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS cols
       FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE n.nspname = $1 AND t.relname = $2 GROUP BY i.relname, ix.indisunique, ix.indisprimary ORDER BY ix.indisprimary DESC, i.relname`,
      [schema, name],
    );
    const fks = await p.query(
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2 AND con.contype = 'f'`,
      [schema, name],
    );
    const indexes: DvIndex[] = idx.rows.map((r) => ({ name: r.name, columns: pgArray(r.cols), unique: r.unique, primary: r.primary }));
    const primaryKey = indexes.find((i) => i.primary)?.columns ?? [];
    const columns: DvColumn[] = cols.rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.nullable,
      default: r.def,
      key: primaryKey.includes(r.name),
      autoIncrement: /^nextval\(/.test(r.def ?? '') || r.ident === 'a' || r.ident === 'd',
      comment: r.comment,
      extra: r.ident === 'a' ? 'identity always' : r.ident === 'd' ? 'identity by default' : null,
      collation: r.coll ?? null,
      charset: null,
      ...(r.enumvals ? { options: pgArray(r.enumvals) } : {}),
    }));
    const foreignKeys: DvForeignKey[] = fks.rows.map((r) => {
      const m = /FOREIGN KEY \(([^)]+)\) REFERENCES ([^(]+)\(([^)]+)\)(.*)/.exec(r.def) ?? [];
      const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
      return { name: r.name, columns: list(m[1]), refTable: (m[2] ?? '').trim().replace(/"/g, ''), refColumns: list(m[3]), onDelete: /ON DELETE (\w+( \w+)?)/.exec(m[4] ?? '')?.[1] ?? null, onUpdate: /ON UPDATE (\w+( \w+)?)/.exec(m[4] ?? '')?.[1] ?? null };
    });
    return { columns, indexes, foreignKeys, primaryKey, ddl: this.ddl(table, columns, indexes, fks.rows.map((r) => `CONSTRAINT ${quoteIdent('postgresql', r.name)} ${r.def}`)) };
  }

  /** A readable CREATE TABLE (pg has no SHOW CREATE TABLE). */
  private ddl(table: string, columns: DvColumn[], indexes: DvIndex[], constraints: string[]): string {
    // Serial / identity columns are written so the dump recreates the sequence (DROP TABLE drops the owned one).
    const lines = columns.map((c) => {
      const serial = /^nextval\('[^']*_seq'::regclass\)$/.test(c.default ?? '');
      const type = serial ? (/^(bigint|int8)$/.test(c.type) ? 'bigserial' : /^(smallint|int2)$/.test(c.type) ? 'smallserial' : 'serial') : c.type;
      const identity = c.extra === 'identity always' ? ' GENERATED ALWAYS AS IDENTITY' : c.extra === 'identity by default' ? ' GENERATED BY DEFAULT AS IDENTITY' : '';
      return `  ${quoteIdent('postgresql', c.name)} ${type}${c.nullable ? '' : ' NOT NULL'}${identity}${c.default && !serial && !identity ? ` DEFAULT ${c.default}` : ''}`;
    });
    const pk = indexes.find((i) => i.primary);
    if (pk) lines.push(`  PRIMARY KEY (${pk.columns.map((c) => quoteIdent('postgresql', c)).join(', ')})`);
    for (const c of constraints) lines.push(`  ${c}`);
    const idx = indexes.filter((i) => !i.primary).map((i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent('postgresql', i.name)} ON ${quoteTable('postgresql', table)} (${i.columns.map((c) => quoteIdent('postgresql', c)).join(', ')});`);
    return `CREATE TABLE ${quoteTable('postgresql', table)} (\n${lines.join(',\n')}\n);${idx.length ? `\n${idx.join('\n')}` : ''}`;
  }

  async charsets(): Promise<DvCharsets> {
    const r = await this.pool('').query("SELECT collname, collprovider FROM pg_collation WHERE collencoding IN (-1, 6) AND collname NOT LIKE '%.%' ORDER BY collname");
    const collations = r.rows.map((x) => ({ name: x.collname as string, charset: 'UTF8' }));
    return {
      charsets: [
        { name: 'UTF8', collation: '', description: 'Unicode, 8-bit (the usual choice)' },
        { name: 'LATIN1', collation: '', description: 'ISO 8859-1, Western European' },
        { name: 'WIN1252', collation: '', description: 'Windows CP1252, Western European' },
        { name: 'SQL_ASCII', collation: '', description: 'No conversion (bytes as given)' },
      ],
      collations,
    };
  }

  async query(db: string, sql: string, params: unknown[] = []): Promise<QueryResult> {
    let n = 0;
    const text = params.length ? sql.replace(/\?/g, () => `$${++n}`) : sql;
    const r = await this.pool(db).query({ text, values: params, rowMode: 'array' });
    const fields = r.fields ?? [];
    if (fields.length) return { columns: fields.map((f) => f.name), rows: (r.rows as unknown[][]).map((row) => row.map(cell)), affected: null };
    return { columns: [], rows: [], affected: r.rowCount ?? null };
  }

  async exec(db: string, sql: string) {
    await this.pool(db).query(sql);
  }

  async close() {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
    this.pools.clear();
  }
}

function pgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return String(v ?? '')
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((x) => x.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

// ------------------------------------------------------------------ SQLite

const SQLITE_FILE = /\.(sqlite3?|db|db3|s3db)$/i;

/** COLLATE of a column in a SQLite CREATE TABLE statement (NOCASE, RTRIM …), or null. */
function sqliteCollation(ddl: string, column: string): string | null {
  const esc = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('[\x22`\\[]?' + esc + '[\x22`\\]]?\\s+[^,]*?\\bCOLLATE\\s+(\\w+)', 'i');
  return re.exec(ddl)?.[1] ?? null;
}

class SqliteDriver implements Driver {
  readonly engine: DvEngine = 'sqlite';
  private dbs = new Map<string, DatabaseSync>();
  /** A folder of files (DevCatz service) or a single file. */
  private folder: string | null;
  private single: string | null;
  constructor(s: ConnectSettings) {
    const isDir = existsSync(s.file) && statSync(s.file).isDirectory();
    this.folder = isDir ? s.file : null;
    this.single = isDir ? null : s.file;
  }

  private open(db: string): DatabaseSync {
    const name = db || this.databasesSync()[0];
    if (!name) throw new Error('No SQLite database file here yet');
    let d = this.dbs.get(name);
    if (!d) {
      const path = this.folder ? join(this.folder, name) : this.single!;
      if (!existsSync(path)) throw new Error(`${path} does not exist`);
      d = new DatabaseSync(path);
      d.exec('PRAGMA foreign_keys = ON;');
      this.dbs.set(name, d);
    }
    return d;
  }

  private databasesSync(): string[] {
    if (this.single) return [basename(this.single)];
    try {
      return readdirSync(this.folder!).filter((f) => SQLITE_FILE.test(f)).sort();
    } catch {
      return [];
    }
  }

  async version() {
    const d = new DatabaseSync(':memory:');
    const v = (d.prepare('select sqlite_version() as v').get() as { v: string }).v;
    d.close();
    return `SQLite ${v}`;
  }

  async databases() {
    return this.databasesSync();
  }

  async tables(db: string, withSystem = false): Promise<DvTable[]> {
    const rows = this.open(db)
      .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view')${withSystem ? '' : " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"} ORDER BY name`)
      .all() as { name: string; type: string }[];
    return rows.map((r) => ({ name: r.name, type: r.type === 'view' ? 'view' : 'table', rows: null, size: null }));
  }

  async structure(db: string, table: string): Promise<DvStructure> {
    const d = this.open(db);
    const q = quoteIdent('sqlite', table);
    const cols = d.prepare(`PRAGMA table_xinfo(${q})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }[];
    const ddl = (d.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string } | undefined)?.sql ?? '';
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const columns: DvColumn[] = cols
      .filter((c) => c.hidden === 0)
      .map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.notnull === 0 && c.pk === 0,
        default: c.dflt_value,
        key: c.pk > 0,
        autoIncrement: c.pk > 0 && /INTEGER/i.test(c.type) && pkCols.length === 1 && /AUTOINCREMENT/i.test(ddl),
        comment: null,
        extra: null,
        collation: sqliteCollation(ddl, c.name),
        charset: null,
      }));
    const idxList = d.prepare(`PRAGMA index_list(${q})`).all() as { name: string; unique: number; origin: string }[];
    const indexes: DvIndex[] = idxList.map((i) => ({
      name: i.name,
      unique: i.unique === 1,
      primary: i.origin === 'pk',
      columns: (d.prepare(`PRAGMA index_info(${quoteIdent('sqlite', i.name)})`).all() as { name: string }[]).map((c) => c.name),
    }));
    if (pkCols.length && !indexes.some((i) => i.primary)) indexes.unshift({ name: 'PRIMARY', columns: pkCols, unique: true, primary: true });
    const fkRows = d.prepare(`PRAGMA foreign_key_list(${q})`).all() as { id: number; table: string; from: string; to: string; on_update: string; on_delete: string }[];
    const fkMap = new Map<number, DvForeignKey>();
    for (const r of fkRows) {
      const f = fkMap.get(r.id) ?? { name: `fk_${r.id}`, columns: [], refTable: r.table, refColumns: [], onDelete: r.on_delete, onUpdate: r.on_update };
      f.columns.push(r.from);
      f.refColumns.push(r.to);
      fkMap.set(r.id, f);
    }
    const extraIdx = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as { sql: string }[]).map((r) => `${r.sql};`);
    return { columns, indexes, foreignKeys: [...fkMap.values()], primaryKey: pkCols, ddl: [ddl ? `${ddl};` : '', ...extraIdx].filter(Boolean).join('\n') };
  }

  async query(db: string, sql: string, params: unknown[] = []): Promise<QueryResult> {
    const d = this.open(db);
    const st = d.prepare(sql);
    const cols = st.columns();
    const values = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as (string | number | null)[];
    if (cols.length) {
      st.setReturnArrays(true);
      const rows = st.all(...values) as unknown as unknown[][];
      return { columns: cols.map((c) => c.name), rows: rows.map((r) => r.map(cell)), affected: null };
    }
    const r = st.run(...values);
    return { columns: [], rows: [], affected: Number(r.changes) };
  }

  async exec(db: string, sql: string) {
    this.open(db).exec(sql);
  }

  async close() {
    for (const d of this.dbs.values()) d.close();
    this.dbs.clear();
  }
}

export function connect(s: ConnectSettings): Driver {
  if (s.engine === 'postgresql') return new PgDriver(s);
  if (s.engine === 'sqlite') return new SqliteDriver(s);
  if (s.engine === 'redis' || s.engine === 'valkey') return new RedisDriver(s.engine, s);
  if (s.engine === 'mongodb') return new MongoDriver(s);
  if (s.engine === 'elasticsearch') return new EsDriver(s);
  return new MysqlDriver(s.engine, s);
}

/** Column types the table editor offers. */
export const TYPES: Record<DvEngine, string[]> = {
  mysql: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'VARCHAR(255)', 'CHAR(36)', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'JSON', 'BLOB', 'ENUM(\'a\',\'b\')'],
  mariadb: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'VARCHAR(255)', 'CHAR(36)', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR', 'JSON', 'BLOB', 'UUID', 'ENUM(\'a\',\'b\')'],
  postgresql: ['integer', 'bigint', 'smallint', 'numeric(10,2)', 'real', 'double precision', 'varchar(255)', 'text', 'boolean', 'date', 'timestamp', 'timestamptz', 'time', 'interval', 'uuid', 'json', 'jsonb', 'bytea', 'inet', 'serial', 'bigserial'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
  mongodb: [],
  elasticsearch: ['keyword', 'text', 'integer', 'long', 'float', 'double', 'boolean', 'date', 'object', 'nested', 'geo_point', 'ip'],
  redis: [],
  valkey: [],
};
