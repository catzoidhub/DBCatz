import { Socket, createConnection } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { MongoClient, ObjectId, type Document } from 'mongodb';
import type { DvColumnDef, DvEngine, DvKey, DvKeyInput, DvKeyValue, DvRows, DvRowsQuery, DvStructure, DvTable } from '@shared/types';
import { cell, tlsOf, type ConnectSettings, type Driver, type QueryResult } from './driver';

/**
 * The non-SQL engines of the viewer: Redis / Valkey over a small RESP2 client
 * (no dependency), MongoDB with the official driver, Elasticsearch over HTTP.
 * Document engines expose collections / indices as tables whose rows are
 * documents (one column per top-level field, `_id` the primary key).
 */

// ------------------------------------------------------------------ RESP client

type Resp = string | number | null | Resp[] | Error;

/** One Redis / Valkey connection; commands run one after the other. */
export class RespClient {
  private sock: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private queue: { resolve: (v: Resp) => void; reject: (e: Error) => void }[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private host: string,
    private port: number,
    private password: string,
    private user = '',
    /** A unix socket instead of host:port. */
    private socketPath = '',
    /** TLS options (rediss://). */
    private tls: ConnectionOptions | undefined = undefined,
    private timeoutMs = 10_000,
  ) {}

  private connect(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    return new Promise((resolve, reject) => {
      const s: Socket = this.socketPath
        ? createConnection({ path: this.socketPath })
        : this.tls
          ? tlsConnect({ host: this.host, port: this.port, servername: this.host, ...this.tls })
          : createConnection({ host: this.host, port: this.port });
      s.setTimeout(this.timeoutMs);
      s.once(this.tls && !this.socketPath ? 'secureConnect' : 'connect', () => {
        s.setTimeout(0);
        this.sock = s;
        resolve(s);
      });
      s.on('data', (d) => this.onData(d));
      s.on('error', (e) => {
        reject(e);
        this.fail(e);
      });
      s.on('close', () => this.fail(new Error('Connection closed')));
      s.on('timeout', () => {
        s.destroy();
        reject(new Error(`${this.socketPath || `${this.host}:${this.port}`} did not answer in ${Math.round(this.timeoutMs / 1000)} s`));
      });
    });
  }

  private fail(e: Error) {
    const q = this.queue;
    this.queue = [];
    for (const p of q) p.reject(e);
    this.sock = null;
    this.buf = Buffer.alloc(0) as Buffer;
  }

  private onData(d: Buffer) {
    this.buf = (this.buf.length ? Buffer.concat([this.buf, d]) : d) as Buffer;
    for (;;) {
      const r = parseResp(this.buf, 0);
      if (!r) return;
      this.buf = this.buf.subarray(r.end) as Buffer;
      const p = this.queue.shift();
      if (p) r.value instanceof Error ? p.reject(r.value) : p.resolve(r.value);
    }
  }

  async command(...args: (string | number)[]): Promise<Resp> {
    const run = async () => {
      const s = await this.connect();
      if (!this.authed) {
        this.authed = true;
        if (this.password) {
          try {
            await this.raw(s, this.user ? ['AUTH', this.user, this.password] : ['AUTH', this.password]);
          } catch (e) {
            this.authed = false;
            throw e;
          }
        }
      }
      return this.raw(s, args);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
  private authed = false;

  private raw(s: Socket, args: (string | number)[]): Promise<Resp> {
    const parts = args.map((a) => {
      const b = Buffer.from(String(a));
      return Buffer.concat([Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')]);
    });
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      s.write(Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...parts]));
    });
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
    this.authed = false;
  }
}

function parseResp(b: Buffer, i: number): { value: Resp; end: number } | null {
  if (i >= b.length) return null;
  const t = b[i];
  const nl = b.indexOf('\r\n', i + 1);
  if (nl < 0) return null;
  const line = b.toString('utf8', i + 1, nl);
  const end = nl + 2;
  if (t === 0x2b) return { value: line, end }; // +
  if (t === 0x2d) return { value: new Error(line), end }; // -
  if (t === 0x3a) return { value: Number(line), end }; // :
  if (t === 0x24) {
    // $
    const n = Number(line);
    if (n < 0) return { value: null, end };
    if (b.length < end + n + 2) return null;
    return { value: b.toString('utf8', end, end + n), end: end + n + 2 };
  }
  if (t === 0x2a) {
    // *
    const n = Number(line);
    if (n < 0) return { value: null, end };
    const out: Resp[] = [];
    let p = end;
    for (let k = 0; k < n; k++) {
      const r = parseResp(b, p);
      if (!r) return null;
      out.push(r.value);
      p = r.end;
    }
    return { value: out, end: p };
  }
  throw new Error(`Unexpected RESP byte ${String.fromCharCode(t)}`);
}

/** Splits a redis-cli line into arguments (quotes and \\ escapes as redis-cli). */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let cur = '';
    if (line[i] === '"' || line[i] === "'") {
      const q = line[i++];
      while (i < line.length && line[i] !== q) {
        if (line[i] === '\\' && q === '"' && i + 1 < line.length) {
          const n = line[++i];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else cur += line[i];
        i++;
      }
      i++;
    } else {
      while (i < line.length && !/\s/.test(line[i])) cur += line[i++];
    }
    out.push(cur);
  }
  return out;
}

export const quoteArg = (s: string) => (/^[A-Za-z0-9_:.\-/@]+$/.test(s) && s ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`);

const KEY_PAGE = 500;
const VALUE_CAP = 1000;

export class RedisDriver implements Driver {
  private c: RespClient;
  constructor(
    readonly engine: DvEngine,
    s: ConnectSettings,
  ) {
    this.c = new RespClient(s.host, s.port, typeof s.password === 'string' ? s.password : '', s.user === 'default' ? '' : s.user, s.socket ?? '', tlsOf(s), (s.options?.connectTimeout ?? 15) * 1000);
  }

  private async select(db: string) {
    if (db) await this.c.command('SELECT', db.replace(/^db/, ''));
  }

  async version() {
    const info = String(await this.c.command('INFO', 'server'));
    const v = /(?:valkey|redis)_version:(\S+)/.exec(info)?.[1] ?? '?';
    return `${/valkey_version/.test(info) ? 'Valkey' : 'Redis'} ${v}`;
  }

  /** db0 … dbN with their key counts (`databases` config, 16 by default). */
  async databases() {
    let n = 16;
    try {
      const r = (await this.c.command('CONFIG', 'GET', 'databases')) as string[];
      if (r?.[1]) n = Number(r[1]);
    } catch {
      /* CONFIG may be disabled */
    }
    return Array.from({ length: n }, (_, i) => `db${i}`);
  }

  /** One "table" per key type that has keys, with counts (scanned up to a cap). */
  async tables(db: string): Promise<DvTable[]> {
    await this.select(db);
    const info = String(await this.c.command('INFO', 'keyspace'));
    const m = new RegExp(`^${db}:keys=(\\d+)`, 'm').exec(info);
    return [{ name: 'keys', type: 'table', rows: m ? Number(m[1]) : 0, size: null }];
  }

  async structure(): Promise<DvStructure> {
    return { columns: [], indexes: [], foreignKeys: [], primaryKey: ['key'], ddl: '' };
  }

  async keys(db: string, pattern: string, limit: number): Promise<{ keys: DvKey[]; total: number }> {
    await this.select(db);
    const names: string[] = [];
    let cursor = '0';
    let total = 0;
    const cap = Math.max(limit, 1);
    do {
      const r = (await this.c.command('SCAN', cursor, 'MATCH', pattern || '*', 'COUNT', KEY_PAGE)) as [string, string[]];
      cursor = r[0];
      total += r[1].length;
      for (const k of r[1]) if (names.length < cap) names.push(k);
    } while (cursor !== '0' && total < 100_000);
    names.sort();
    const keys: DvKey[] = [];
    for (const key of names) {
      const type = String(await this.c.command('TYPE', key));
      keys.push({ key, type, ttl: Number(await this.c.command('TTL', key)), size: await this.sizeOf(key, type) });
    }
    return { keys, total };
  }

  private async sizeOf(key: string, type: string): Promise<number> {
    const cmd = { string: 'STRLEN', list: 'LLEN', hash: 'HLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' }[type];
    if (!cmd) return 0;
    try {
      return Number(await this.c.command(cmd, key));
    } catch {
      return 0;
    }
  }

  async key(db: string, key: string): Promise<DvKeyValue> {
    await this.select(db);
    const type = String(await this.c.command('TYPE', key));
    if (type === 'none') throw new Error(`Key ${key} does not exist`);
    const ttl = Number(await this.c.command('TTL', key));
    const size = await this.sizeOf(key, type);
    let value: DvKeyValue['value'];
    let shown = size;
    if (type === 'string') value = String((await this.c.command('GET', key)) ?? '');
    else if (type === 'list') {
      value = ((await this.c.command('LRANGE', key, 0, VALUE_CAP - 1)) as string[]) ?? [];
      shown = value.length;
    } else if (type === 'set') {
      const r = (await this.c.command('SSCAN', key, 0, 'COUNT', VALUE_CAP)) as [string, string[]];
      value = r[1].sort();
      shown = value.length;
    } else if (type === 'hash') {
      const r = (await this.c.command('HSCAN', key, 0, 'COUNT', VALUE_CAP)) as [string, string[]];
      value = pairs(r[1]);
      shown = value.length;
    } else if (type === 'zset') {
      value = pairs((await this.c.command('ZRANGE', key, 0, VALUE_CAP - 1, 'WITHSCORES')) as string[]);
      shown = value.length;
    } else if (type === 'stream') {
      value = JSON.stringify(await this.c.command('XRANGE', key, '-', '+', 'COUNT', 200), null, 2);
    } else if (type === 'ReJSON-RL') {
      value = String((await this.c.command('JSON.GET', key)) ?? '');
    } else value = `(${type} values cannot be shown)`;
    return { key, type, ttl, size, value, shown };
  }

  async keySet(db: string, input: DvKeyInput) {
    await this.select(db);
    const k = input.key;
    await this.c.command('DEL', k);
    const v = input.value;
    if (input.type === 'string') await this.c.command('SET', k, String(v));
    else if (input.type === 'list' && Array.isArray(v) && v.length) await this.c.command('RPUSH', k, ...(v as string[]));
    else if (input.type === 'set' && Array.isArray(v) && v.length) await this.c.command('SADD', k, ...(v as string[]));
    else if (input.type === 'hash' && Array.isArray(v) && v.length) await this.c.command('HSET', k, ...(v as [string, string][]).flat());
    else if (input.type === 'zset' && Array.isArray(v) && v.length) await this.c.command('ZADD', k, ...(v as [string, string][]).flatMap(([m, s]) => [s, m]));
    if (input.ttl !== null && input.ttl >= 0) await this.c.command('EXPIRE', k, input.ttl);
  }

  async keyDelete(db: string, keys: string[]) {
    await this.select(db);
    return keys.length ? Number(await this.c.command('DEL', ...keys)) : 0;
  }

  async keyRename(db: string, from: string, to: string) {
    await this.select(db);
    await this.c.command('RENAME', from, to);
  }

  async flush(db: string) {
    await this.select(db);
    await this.c.command('FLUSHDB');
  }

  /** The query tab runs redis-cli lines; the reply is shown as rows. */
  async query(db: string, line: string): Promise<QueryResult> {
    await this.select(db);
    const args = splitArgs(line);
    if (!args.length) return { columns: [], rows: [], affected: null };
    const r = await this.c.command(...args);
    return { columns: ['reply'], rows: flatten(r).map((x) => [x]), affected: null };
  }

  async exec(db: string, script: string) {
    await this.select(db);
    for (const line of script.split('\n')) {
      const args = splitArgs(line.trim());
      if (args.length && !line.trim().startsWith('#')) await this.c.command(...args);
    }
  }

  async close() {
    this.c.close();
  }
}

const pairs = (a: string[]): [string, string][] => {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]);
  return out;
};

function flatten(r: Resp, depth = 0): unknown[] {
  if (Array.isArray(r)) return r.length ? r.flatMap((x) => (Array.isArray(x) ? [JSON.stringify(x)] : flatten(x, depth + 1))) : ['(empty array)'];
  if (r === null) return ['(nil)'];
  if (r instanceof Error) return [`(error) ${r.message}`];
  return [r];
}

// ------------------------------------------------------------------ Documents (shared)

/** Flattens documents to a grid: a column per top-level field in order of first appearance. */
export function documentGrid(docs: Record<string, unknown>[], idField = '_id'): { columns: string[]; rows: unknown[][] } {
  const columns: string[] = [idField];
  for (const d of docs) for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);
  const rows = docs.map((d) => columns.map((c) => docCell(d[c])));
  return { columns, rows };
}

const docCell = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (v instanceof ObjectId) return v.toHexString();
  if (v instanceof Date) return cell(v);
  if (v && typeof v === 'object') return JSON.stringify(v);
  return cell(v);
};

/** A value typed in a grid cell back to a document value (JSON when it parses as object / array / number / bool). */
export function docValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (/^[{[]/.test(t) || t === 'true' || t === 'false' || t === 'null' || /^-?\d+(\.\d+)?$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

/** Relaxed JSON for queries: unquoted keys, single quotes, trailing commas, ObjectId("…") / ISODate("…"). */
export function relaxedJson(src: string): unknown {
  const t = src.trim();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fn = new Function('ObjectId', 'ISODate', 'Date', `"use strict"; return (${t});`);
  return fn((s: string) => new ObjectId(s), (s: string) => new Date(s), Date);
}

/** Sample documents → columns (field: observed types). */
function sampleColumns(docs: Record<string, unknown>[], idField: string) {
  const types = new Map<string, Set<string>>();
  for (const d of docs)
    for (const [k, v] of Object.entries(d)) {
      const t = v === null ? 'null' : v instanceof ObjectId ? 'ObjectId' : v instanceof Date ? 'Date' : Array.isArray(v) ? 'array' : typeof v;
      (types.get(k) ?? types.set(k, new Set()).get(k)!).add(t);
    }
  return [...types.entries()].map(([name, ts]) => ({ name, type: [...ts].join(' | '), nullable: !docs.every((d) => d[name] !== undefined && d[name] !== null), default: null, key: name === idField, autoIncrement: false, comment: null, extra: null }));
}

// ------------------------------------------------------------------ MongoDB

export class MongoDriver implements Driver {
  readonly engine: DvEngine = 'mongodb';
  private client: MongoClient;
  constructor(s: ConnectSettings) {
    const pw = typeof s.password === 'string' ? s.password : '';
    const auth = s.user ? `${encodeURIComponent(s.user)}:${encodeURIComponent(pw)}@` : '';
    const o = s.options ?? {};
    const timeout = (o.connectTimeout ?? 15) * 1000;
    const where = s.socket ? encodeURIComponent(s.socket) : o.srv ? s.host : `${s.host}:${s.port}`;
    const params = new URLSearchParams({ serverSelectionTimeoutMS: String(timeout), connectTimeoutMS: String(timeout) });
    if (!o.srv) params.set('directConnection', 'true');
    if (o.requireSsl) {
      params.set('tls', 'true');
      if (o.verifyCert === false) params.set('tlsAllowInvalidCertificates', 'true');
    }
    if (s.user && s.database) params.set('authSource', s.database);
    this.client = new MongoClient(`${o.srv ? 'mongodb+srv' : 'mongodb'}://${auth}${where}/?${params}`, s.ca ? { ca: s.ca } : {});
  }

  async version() {
    const r = await this.client.db('admin').command({ buildInfo: 1 });
    return `MongoDB ${r.version}`;
  }

  async databases() {
    const r = await this.client.db('admin').admin().listDatabases();
    return r.databases.map((d) => d.name).sort();
  }

  async tables(db: string): Promise<DvTable[]> {
    const cols = await this.client.db(db).listCollections().toArray();
    const out: DvTable[] = [];
    for (const c of cols.sort((a, b) => a.name.localeCompare(b.name))) {
      if (c.type === 'view') {
        out.push({ name: c.name, type: 'view', rows: null, size: null });
        continue;
      }
      let rows: number | null = null;
      let size: number | null = null;
      try {
        const st = await this.client.db(db).command({ collStats: c.name });
        rows = Number(st.count);
        size = Number(st.storageSize ?? st.size);
      } catch {
        rows = await this.client.db(db).collection(c.name).estimatedDocumentCount();
      }
      out.push({ name: c.name, type: 'table', rows, size });
    }
    return out;
  }

  async structure(db: string, table: string): Promise<DvStructure> {
    const col = this.client.db(db).collection(table);
    const docs = (await col.find({}).limit(100).toArray()) as Record<string, unknown>[];
    const columns = sampleColumns(docs, '_id');
    let indexes: DvStructure['indexes'] = [];
    try {
      indexes = (await col.indexes()).map((i) => ({ name: String(i.name), columns: Object.keys(i.key), unique: !!i.unique, primary: i.name === '_id_' }));
    } catch {
      /* views have none */
    }
    const info = (await this.client.db(db).listCollections({ name: table }).toArray())[0] as { options?: Document } | undefined;
    return { columns, indexes, foreignKeys: [], primaryKey: ['_id'], ddl: JSON.stringify({ options: info?.options ?? {}, indexes }, null, 2) };
  }

  async rows(db: string, table: string, q: DvRowsQuery): Promise<DvRows> {
    const t0 = Date.now();
    const col = this.client.db(db).collection(table);
    const filter = (q.where ? relaxedJson(q.where) : {}) as Document;
    const cursor = col.find(filter).skip(q.offset).limit(q.limit);
    if (q.orderBy) cursor.sort({ [q.orderBy]: q.desc ? -1 : 1 });
    const docs = (await cursor.toArray()) as Record<string, unknown>[];
    const total = q.where ? await col.countDocuments(filter) : await col.estimatedDocumentCount();
    return { ...documentGrid(docs), total, primaryKey: ['_id'], ms: Date.now() - t0 };
  }

  private id(v: unknown) {
    return typeof v === 'string' && ObjectId.isValid(v) && v.length === 24 ? new ObjectId(v) : docValue(v);
  }

  async updateRow(db: string, table: string, key: Record<string, unknown>, changes: Record<string, unknown>) {
    const $set: Document = {};
    const $unset: Document = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) $unset[k] = '';
      else $set[k] = docValue(v);
    }
    const update: Document = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length) await this.client.db(db).collection(table).updateOne({ _id: this.id(key._id) as ObjectId }, update);
  }

  async insertRow(db: string, table: string, values: Record<string, unknown>) {
    const doc: Document = {};
    for (const [k, v] of Object.entries(values)) if (v !== null && v !== '') doc[k] = k === '_id' ? this.id(v) : docValue(v);
    await this.client.db(db).collection(table).insertOne(doc);
  }

  async deleteRows(db: string, table: string, keys: Record<string, unknown>[]) {
    const r = await this.client.db(db).collection(table).deleteMany({ _id: { $in: keys.map((k) => this.id(k._id)) as ObjectId[] } });
    return r.deletedCount;
  }

  /**
   * The query tab takes mongosh-like lines: `db.users.find({…}).sort({…}).limit(n)`,
   * `db.users.aggregate([…])`, `countDocuments`, `insertOne/Many`, `updateOne/Many`,
   * `deleteOne/Many`, `drop`, or a raw command as JSON (`{ ping: 1 }`).
   */
  async query(db: string, text: string): Promise<QueryResult> {
    const t = text.trim().replace(/;$/, '');
    const d = this.client.db(db);
    if (t.startsWith('{')) {
      const r = await d.command(relaxedJson(t) as Document);
      return single(r);
    }
    const parsed = parseCall(t);
    if (!parsed) throw new Error('Expected db.<collection>.<method>(…) or a command document');
    const col = d.collection(parsed.collection);
    const method = parsed.method;
    const args = parsed.args.trim() ? (relaxedJson(`[${parsed.args}]`) as unknown[]) : [];
    const mods = parsed.mods.map((x) => [x.name, x.args.trim() ? relaxedJson(x.args) : undefined] as const);
    const asGrid = (docs: Record<string, unknown>[]) => ({ ...documentGrid(docs), affected: null });
    switch (method) {
      case 'find': {
        let c = col.find((args[0] as Document) ?? {}, args[1] ? { projection: args[1] as Document } : {});
        let limited = false;
        for (const [k, v] of mods) {
          if (k === 'sort') c = c.sort(v as Document);
          else if (k === 'limit') {
            c = c.limit(Number(v));
            limited = true;
          } else if (k === 'skip') c = c.skip(Number(v));
          else if (k === 'project') c = c.project(v as Document);
        }
        if (!limited) c = c.limit(1000);
        return asGrid((await c.toArray()) as Record<string, unknown>[]);
      }
      case 'findOne':
        return asGrid([((await col.findOne((args[0] as Document) ?? {})) ?? {}) as Record<string, unknown>]);
      case 'aggregate':
        return asGrid((await col.aggregate((args[0] as Document[]) ?? []).limit(1000).toArray()) as Record<string, unknown>[]);
      case 'countDocuments':
      case 'count':
        return single({ count: await col.countDocuments((args[0] as Document) ?? {}) });
      case 'estimatedDocumentCount':
        return single({ count: await col.estimatedDocumentCount() });
      case 'distinct':
        return { columns: [String(args[0])], rows: (await col.distinct(String(args[0]), (args[1] as Document) ?? {})).map((v) => [docCell(v)]), affected: null };
      case 'insertOne':
        return single({ ...(await col.insertOne(args[0] as Document)) }, 1);
      case 'insertMany': {
        const r = await col.insertMany(args[0] as Document[]);
        return single({ insertedCount: r.insertedCount }, r.insertedCount);
      }
      case 'updateOne':
      case 'updateMany': {
        const r = await col[method](args[0] as Document, args[1] as Document, (args[2] as Document) ?? {});
        return single({ matched: r.matchedCount, modified: r.modifiedCount, upserted: r.upsertedCount }, r.modifiedCount);
      }
      case 'replaceOne': {
        const r = await col.replaceOne(args[0] as Document, args[1] as Document);
        return single({ matched: r.matchedCount, modified: r.modifiedCount }, r.modifiedCount);
      }
      case 'deleteOne':
      case 'deleteMany': {
        const r = await col[method]((args[0] as Document) ?? {});
        return single({ deleted: r.deletedCount }, r.deletedCount);
      }
      case 'drop':
        await col.drop();
        return single({ dropped: true }, 0);
      case 'createIndex':
        return single({ index: await col.createIndex(args[0] as Document, (args[1] as Document) ?? {}) }, 0);
      case 'dropIndex':
        await col.dropIndex(String(args[0]));
        return single({ dropped: args[0] }, 0);
      case 'getIndexes':
      case 'indexes':
        return asGrid((await col.indexes()) as Record<string, unknown>[]);
      default:
        throw new Error(`${method} is not supported here`);
    }
  }

  async exec(db: string, text: string) {
    for (const line of text.split(/\n(?=db\.|\{)/)) if (line.trim()) await this.query(db, line);
  }

  async createDatabase(name: string) {
    // A database exists once it has a collection.
    await this.client.db(name).createCollection('_devcatz').then(() => this.client.db(name).collection('_devcatz').drop());
  }
  async dropDatabase(name: string) {
    await this.client.db(name).dropDatabase();
  }
  async createTable(db: string, table: string, _columns: DvColumnDef[]) {
    await this.client.db(db).createCollection(table);
  }
  async dropTable(db: string, table: string) {
    await this.client.db(db).collection(table).drop();
  }
  async truncate(db: string, table: string) {
    await this.client.db(db).collection(table).deleteMany({});
  }
  async renameTable(db: string, from: string, to: string) {
    await this.client.db(db).collection(from).rename(to);
  }
  async addIndex(db: string, table: string, name: string, columns: string[], unique: boolean) {
    await this.client.db(db).collection(table).createIndex(Object.fromEntries(columns.map((c) => [c, 1])), { name, unique });
  }
  async dropIndex(db: string, table: string, name: string) {
    await this.client.db(db).collection(table).dropIndex(name);
  }
  /** All documents of a collection, for exports. */
  async *documents(db: string, table: string): AsyncGenerator<Record<string, unknown>> {
    for await (const d of this.client.db(db).collection(table).find({})) yield d as Record<string, unknown>;
  }
  async insertDocuments(db: string, table: string, docs: Record<string, unknown>[]) {
    if (docs.length) await this.client.db(db).collection(table).insertMany(docs.map((d) => (typeof d._id === 'string' && ObjectId.isValid(d._id) && d._id.length === 24 ? { ...d, _id: new ObjectId(d._id) } : d)) as Document[], { ordered: false });
  }

  async close() {
    await this.client.close();
  }
}

/** `db.<coll>.<method>(args).mod(args)…` with balanced parentheses (strings and nested braces inside args are fine). */
function parseCall(t: string): { collection: string; method: string; args: string; mods: { name: string; args: string }[] } | null {
  const head = /^db(?:\.getCollection\(["']([^"']+)["']\)|\.([A-Za-z0-9_.-]+))\.(\w+)\s*\(/.exec(t);
  if (!head) return null;
  const collection = head[1] ?? head[2];
  let i = head[0].length - 1;
  const readArgs = (): string | null => {
    // i is at '('
    let depth = 0;
    let quote = '';
    const start = i + 1;
    for (; i < t.length; i++) {
      const c = t[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) return t.slice(start, i);
      }
    }
    return null;
  };
  const args = readArgs();
  if (args === null) return null;
  i++;
  const mods: { name: string; args: string }[] = [];
  for (;;) {
    const m = /^\s*\.(\w+)\s*\(/.exec(t.slice(i));
    if (!m) break;
    i += m[0].length - 1;
    const a = readArgs();
    if (a === null) return null;
    i++;
    mods.push({ name: m[1], args: a });
  }
  if (t.slice(i).trim()) return null;
  return { collection, method: head[3], args, mods };
}

const single = (obj: Record<string, unknown>, affected: number | null = null): QueryResult => {
  const o = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  return { columns: Object.keys(o), rows: [Object.values(o).map(docCell)], affected };
};

// ------------------------------------------------------------------ Elasticsearch

export class EsDriver implements Driver {
  readonly engine: DvEngine = 'elasticsearch';
  private base: string;
  private headers: Record<string, string>;
  private tls: ReturnType<typeof tlsOf>;
  private timeoutMs: number;
  constructor(s: ConnectSettings) {
    this.tls = tlsOf(s);
    this.base = `${this.tls ? 'https' : 'http'}://${s.host}:${s.port}`;
    const pw = typeof s.password === 'string' ? s.password : '';
    this.headers = { 'content-type': 'application/json', ...(s.user ? { authorization: `Basic ${Buffer.from(`${s.user}:${pw}`).toString('base64')}` } : {}) };
    this.timeoutMs = (s.options?.connectTimeout ?? 15) * 1000;
  }

  /** node:http(s) rather than fetch, so self-signed certificates can be allowed. */
  async http(method: string, path: string, body?: unknown): Promise<any> {
    const url = new URL(this.base + (path.startsWith('/') ? path : `/${path}`));
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const { status, statusText, text } = await new Promise<{ status: number; statusText: string; text: string }>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: { ...this.headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }, timeout: this.timeoutMs, ...(this.tls ?? {}) }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, statusText: r.statusMessage ?? '', text: Buffer.concat(chunks).toString('utf8') }));
        r.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`${url.host} did not answer in ${Math.round(this.timeoutMs / 1000)} s`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    let json: any = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* plain text (_cat) */
    }
    if (status < 200 || status >= 300) throw new Error(json?.error?.reason ?? json?.error?.root_cause?.[0]?.reason ?? (typeof json === 'string' && json ? json : `${status} ${statusText}`));
    return json;
  }

  async version() {
    const r = await this.http('GET', '/');
    return `Elasticsearch ${r.version?.number ?? '?'}`;
  }

  /** One logical database: the cluster. */
  async databases() {
    const r = await this.http('GET', '/');
    return [String(r.cluster_name ?? 'elasticsearch')];
  }

  async tables(): Promise<DvTable[]> {
    const r = (await this.http('GET', '/_cat/indices?format=json&bytes=b&h=index,docs.count,store.size&expand_wildcards=open')) as { index: string; 'docs.count': string; 'store.size': string }[];
    const aliases = (await this.http('GET', '/_cat/aliases?format=json&h=alias')) as { alias: string }[];
    return [
      ...r.filter((i) => !i.index.startsWith('.')).map((i) => ({ name: i.index, type: 'table' as const, rows: Number(i['docs.count'] ?? 0), size: Number(i['store.size'] ?? 0) })),
      ...aliases.filter((a) => !a.alias.startsWith('.')).map((a) => ({ name: a.alias, type: 'view' as const, rows: null, size: null })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  async structure(_db: string, table: string): Promise<DvStructure> {
    const m = await this.http('GET', `/${encodeURIComponent(table)}/_mapping`);
    const idx = Object.keys(m)[0];
    const props = (m[idx]?.mappings?.properties ?? {}) as Record<string, { type?: string; properties?: unknown }>;
    const columns = [{ name: '_id', type: 'keyword', nullable: false, default: null, key: true, autoIncrement: true, comment: null, extra: null }, ...Object.entries(props).map(([name, p]) => ({ name, type: p.type ?? (p.properties ? 'object' : 'unknown'), nullable: true, default: null, key: false, autoIncrement: false, comment: null, extra: null }))];
    const settings = await this.http('GET', `/${encodeURIComponent(table)}/_settings`);
    return { columns, indexes: [], foreignKeys: [], primaryKey: ['_id'], ddl: JSON.stringify({ mappings: m[idx]?.mappings ?? {}, settings: settings[idx]?.settings?.index ?? {} }, null, 2) };
  }

  private hits(r: any): Record<string, unknown>[] {
    return ((r.hits?.hits ?? []) as { _id: string; _source: Record<string, unknown>; _score?: number }[]).map((h) => ({ _id: h._id, ...h._source }));
  }

  async rows(_db: string, table: string, q: DvRowsQuery): Promise<DvRows> {
    const t0 = Date.now();
    const body: Record<string, unknown> = { from: q.offset, size: q.limit, track_total_hits: true };
    body.query = q.where ? (q.where.trim().startsWith('{') ? relaxedJson(q.where) : { query_string: { query: q.where } }) : { match_all: {} };
    if (q.orderBy) body.sort = [q.orderBy === '_id' ? { _doc: { order: q.desc ? 'desc' : 'asc' } } : { [q.orderBy]: { order: q.desc ? 'desc' : 'asc', unmapped_type: 'keyword' } }];
    const r = await this.http('POST', `/${encodeURIComponent(table)}/_search`, body);
    return { ...documentGrid(this.hits(r)), total: Number(r.hits?.total?.value ?? 0), primaryKey: ['_id'], ms: Date.now() - t0 };
  }

  async updateRow(_db: string, table: string, key: Record<string, unknown>, changes: Record<string, unknown>) {
    const doc: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [k, v] of Object.entries(changes)) v === null ? unset.push(k) : (doc[k] = docValue(v));
    if (unset.length) await this.http('POST', `/${encodeURIComponent(table)}/_update/${encodeURIComponent(String(key._id))}?refresh=true`, { script: { source: unset.map((u) => `ctx._source.remove('${u.replace(/'/g, "\\'")}')`).join('; ') } });
    if (Object.keys(doc).length) await this.http('POST', `/${encodeURIComponent(table)}/_update/${encodeURIComponent(String(key._id))}?refresh=true`, { doc });
  }

  async insertRow(_db: string, table: string, values: Record<string, unknown>) {
    const { _id, ...rest } = values;
    const doc: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== null && v !== '') doc[k] = docValue(v);
    await this.http(_id ? 'PUT' : 'POST', `/${encodeURIComponent(table)}/_doc${_id ? `/${encodeURIComponent(String(_id))}` : ''}?refresh=true`, doc);
  }

  async deleteRows(_db: string, table: string, keys: Record<string, unknown>[]) {
    let n = 0;
    for (const k of keys) {
      await this.http('DELETE', `/${encodeURIComponent(table)}/_doc/${encodeURIComponent(String(k._id))}?refresh=true`);
      n++;
    }
    return n;
  }

  /** The query tab takes Kibana console lines: `GET /index/_search` followed by a JSON body. */
  async query(_db: string, text: string): Promise<QueryResult> {
    const m = /^\s*(GET|POST|PUT|DELETE|HEAD)\s+(\S+)\s*([\s\S]*)$/i.exec(text);
    if (!m) throw new Error('Expected METHOD /path, then an optional JSON body');
    const body = m[3].trim() ? relaxedJson(m[3]) : undefined;
    const r = await this.http(m[1].toUpperCase(), m[2], body);
    if (typeof r === 'string') return { columns: ['response'], rows: r.split('\n').filter(Boolean).map((l) => [l]), affected: null };
    if (r?.hits?.hits) return { ...documentGrid(this.hits(r)), affected: null };
    if (Array.isArray(r)) return { ...documentGrid(r as Record<string, unknown>[], Object.keys(r[0] ?? { index: 1 })[0]), affected: null };
    return single(r ?? {});
  }

  async exec(db: string, text: string) {
    for (const part of text.split(/\n(?=(?:GET|POST|PUT|DELETE|HEAD)\s)/i)) if (part.trim()) await this.query(db, part);
  }

  async createTable(_db: string, table: string, columns: DvColumnDef[]) {
    const properties = Object.fromEntries(columns.filter((c) => c.name !== '_id').map((c) => [c.name, { type: c.type || 'keyword' }]));
    await this.http('PUT', `/${encodeURIComponent(table)}`, Object.keys(properties).length ? { mappings: { properties } } : {});
  }
  async dropTable(_db: string, table: string) {
    await this.http('DELETE', `/${encodeURIComponent(table)}`);
  }
  async truncate(_db: string, table: string) {
    await this.http('POST', `/${encodeURIComponent(table)}/_delete_by_query?refresh=true&conflicts=proceed`, { query: { match_all: {} } });
  }
  async *documents(_db: string, table: string): AsyncGenerator<Record<string, unknown>> {
    let r = await this.http('POST', `/${encodeURIComponent(table)}/_search?scroll=2m`, { size: 500, query: { match_all: {} } });
    try {
      while (r.hits?.hits?.length) {
        for (const d of this.hits(r)) yield d;
        r = await this.http('POST', '/_search/scroll', { scroll: '2m', scroll_id: r._scroll_id });
      }
    } finally {
      if (r._scroll_id) await this.http('DELETE', '/_search/scroll', { scroll_id: r._scroll_id }).catch(() => undefined);
    }
  }
  async insertDocuments(_db: string, table: string, docs: Record<string, unknown>[]) {
    if (!docs.length) return;
    const lines = docs.flatMap((d) => {
      const { _id, ...src } = d;
      return [JSON.stringify({ index: _id ? { _id } : {} }), JSON.stringify(src)];
    });
    const r = await this.http('POST', `/${encodeURIComponent(table)}/_bulk?refresh=true`, `${lines.join('\n')}\n`);
    const bad = (r.items as { index: { error?: { reason: string } } }[]).find((i) => i.index.error);
    if (bad) throw new Error(bad.index.error!.reason);
  }

  async close() {
    /* HTTP: nothing to close */
  }
}
