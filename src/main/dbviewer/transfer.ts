import { createReadStream, createWriteStream, mkdtempSync, readdirSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import type { DvExportOptions, DvImportOptions } from '@shared/types';
import { DV_DOCUMENT, DV_KEYVALUE, DV_SQL } from '@shared/types';
import { literal, quoteIdent, quoteTable, splitStatements, type Driver } from './driver';
import { quoteArg } from './nosql';
import { checkName, insertRow } from './ops';

/**
 * Export (SQL, CSV, JSON, XML, DOT, redis script), import (SQL / .sql.gz /
 * DevCatz .tar.gz backups, CSV, NDJSON, redis script) and tar.gz backups of
 * whole connections, all through the drivers so they work for every engine
 * and for user connections alike. Progress goes to a job list.
 */

const PAGE = 1000;

export type Progress = (detail: string, done?: number, total?: number) => void;

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csv = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function write(out: WriteStream, chunk: string): Promise<void> {
  return out.write(chunk) ? Promise.resolve() : new Promise((r) => out.once('drain', () => r()));
}

/** Rows of a table in pages, ordered by the primary key when there is one. */
async function* pages(d: Driver, db: string, table: string, pk: string[]): AsyncGenerator<{ columns: string[]; rows: unknown[][] }> {
  if (d.documents) {
    let buf: Record<string, unknown>[] = [];
    const flush = () => {
      const columns = ['_id'];
      for (const b of buf) for (const k of Object.keys(b)) if (!columns.includes(k)) columns.push(k);
      const rows = buf.map((b) => columns.map((c) => (b[c] === undefined ? null : b[c])));
      buf = [];
      return { columns, rows };
    };
    for await (const doc of d.documents(db, table)) {
      buf.push(doc);
      if (buf.length >= PAGE) yield flush();
    }
    if (buf.length) yield flush();
    return;
  }
  const order = pk.length ? ` ORDER BY ${pk.map((c) => quoteIdent(d.engine, c)).join(', ')}` : '';
  for (let offset = 0; ; offset += PAGE) {
    const r = await d.query(db, `SELECT * FROM ${quoteTable(d.engine, table)}${order} LIMIT ${PAGE} OFFSET ${offset}`);
    if (!r.rows.length) break;
    yield r;
    if (r.rows.length < PAGE) break;
  }
}

/** Writes one SQL dump of the tables (all when empty) to `out`. */
export async function dumpSql(d: Driver, db: string, tables: string[], out: WriteStream, o: Pick<DvExportOptions, 'structure' | 'data' | 'dropFirst'>, progress: Progress) {
  const e = d.engine;
  const all = await d.tables(db);
  const list = tables.length ? all.filter((t) => tables.includes(t.name)) : all;
  await write(out, `-- DevCatz DBCatz export\n-- Engine: ${e}  Database: ${db}  ${new Date().toISOString()}\n\n`);
  if (e === 'mysql' || e === 'mariadb') await write(out, 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n');
  if (e === 'sqlite') await write(out, 'PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n');
  let i = 0;
  for (const t of list) {
    progress(`${db}.${t.name}`, i++, list.length);
    const st = await d.structure(db, t.name);
    if (o.structure) {
      if (o.dropFirst) await write(out, `DROP ${t.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${quoteTable(e, t.name)};\n`);
      await write(out, `${st.ddl.trim().replace(/;?$/, ';')}\n\n`);
    }
    if (o.data && t.type === 'table') {
      let n = 0;
      for await (const page of pages(d, db, t.name, st.primaryKey)) {
        const cols = page.columns.map((c) => quoteIdent(e, c)).join(', ');
        const values = page.rows.map((r) => `(${r.map((v) => literal(e, v)).join(', ')})`);
        await write(out, `INSERT INTO ${quoteTable(e, t.name)} (${cols}) VALUES\n${values.join(',\n')};\n`);
        n += page.rows.length;
        progress(`${db}.${t.name}: ${n} rows`, i - 1, list.length);
      }
      await write(out, '\n');
    }
  }
  if (e === 'mysql' || e === 'mariadb') await write(out, 'SET FOREIGN_KEY_CHECKS = 1;\n');
  if (e === 'sqlite') await write(out, 'COMMIT;\n');
}

export async function exportTo(d: Driver, path: string, o: DvExportOptions, progress: Progress) {
  const out = createWriteStream(path);
  const close = () => new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  const db = o.database;
  try {
    if (o.format === 'sql') {
      if (!DV_SQL.includes(d.engine)) throw new Error('SQL export is for SQL engines; use JSON here');
      await dumpSql(d, db, o.tables, out, o, progress);
      return;
    }
    if (o.format === 'redis') {
      if (!d.keys || !d.key) throw new Error('A redis script is for Redis / Valkey');
      await write(out, `# DevCatz DBCatz export · ${db}\nSELECT ${db.replace(/^db/, '')}\n`);
      const { keys } = await d.keys(db, o.tables[0] || '*', 1_000_000);
      let n = 0;
      for (const k of keys) {
        const v = await d.key(db, k.key);
        const q = quoteArg;
        if (v.type === 'string') await write(out, `SET ${q(k.key)} ${q(String(v.value))}\n`);
        else if (v.type === 'list') await write(out, `DEL ${q(k.key)}\nRPUSH ${q(k.key)} ${(v.value as string[]).map(q).join(' ')}\n`);
        else if (v.type === 'set') await write(out, `DEL ${q(k.key)}\nSADD ${q(k.key)} ${(v.value as string[]).map(q).join(' ')}\n`);
        else if (v.type === 'hash') await write(out, `DEL ${q(k.key)}\nHSET ${q(k.key)} ${(v.value as [string, string][]).map(([f, x]) => `${q(f)} ${q(x)}`).join(' ')}\n`);
        else if (v.type === 'zset') await write(out, `DEL ${q(k.key)}\nZADD ${q(k.key)} ${(v.value as [string, string][]).map(([m, s]) => `${s} ${q(m)}`).join(' ')}\n`);
        else continue;
        if (v.ttl > 0) await write(out, `EXPIRE ${q(k.key)} ${v.ttl}\n`);
        progress(`${++n} / ${keys.length} keys`, n, keys.length);
      }
      return;
    }
    if (DV_KEYVALUE.includes(d.engine)) {
      // CSV / JSON / XML of keys: key, type, ttl, value (JSON for structured values).
      const { keys } = await d.keys!(db, o.tables[0] || '*', 1_000_000);
      const rows: unknown[][] = [];
      let n = 0;
      for (const k of keys) {
        const v = await d.key!(db, k.key);
        rows.push([k.key, v.type, v.ttl, typeof v.value === 'string' ? v.value : JSON.stringify(v.value)]);
        progress(`${++n} / ${keys.length} keys`, n, keys.length);
      }
      await writeTable(out, o.format, db, 'keys', ['key', 'type', 'ttl', 'value'], rows, true, true);
      return;
    }
    if (o.format === 'dot') {
      if (!DV_SQL.includes(d.engine)) throw new Error('A DOT diagram needs foreign keys; this engine has none');
      await writeDot(d, db, o.tables, out, progress);
      return;
    }
    const all = await d.tables(db);
    const list = (o.tables.length ? all.filter((t) => tables(o).includes(t.name)) : all).filter((t) => t.type === 'table' || DV_DOCUMENT.includes(d.engine));
    if (o.format === 'json' && d.documents) {
      // Documents as they are (no column filling), one per line, with the collection they came from.
      let i = 0;
      for (const t of list) {
        progress(`${db}.${t.name}`, i++, list.length);
        let n = 0;
        for await (const doc of d.documents(db, t.name)) {
          await write(out, `${JSON.stringify({ _table: t.name, ...doc })}\n`);
          if (++n % 500 === 0) progress(`${db}.${t.name}: ${n} documents`, i - 1, list.length);
        }
      }
      return;
    }
    if (o.format === 'xml') await write(out, `<?xml version="1.0" encoding="UTF-8"?>\n<database name="${esc(db)}">\n`);
    let i = 0;
    for (const t of list) {
      progress(`${db}.${t.name}`, i++, list.length);
      const st = await d.structure(db, t.name);
      let first = true;
      let n = 0;
      for await (const page of pages(d, db, t.name, st.primaryKey)) {
        await writeTable(out, o.format, db, t.name, page.columns, page.rows, first, false);
        first = false;
        n += page.rows.length;
        progress(`${db}.${t.name}: ${n} rows`, i - 1, list.length);
      }
      if (first) await writeTable(out, o.format, db, t.name, st.columns.map((c) => c.name), [], true, false);
      if (o.format === 'xml') await write(out, '  </table>\n');
      if (o.format === 'csv' && list.length > 1) await write(out, '\n');
    }
    if (o.format === 'xml') await write(out, '</database>\n');
  } finally {
    await close();
  }
}

const tables = (o: DvExportOptions) => o.tables;

/** One page of a table in csv / json (NDJSON, one object per line with a `_table` field when several tables) / xml. */
async function writeTable(out: WriteStream, format: DvExportOptions['format'], db: string, table: string, columns: string[], rows: unknown[][], first: boolean, single: boolean) {
  const val = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  if (format === 'csv') {
    if (first) await write(out, `${columns.map(csv).join(',')}\n`);
    await write(out, rows.map((r) => r.map((v) => csv(val(v))).join(',')).join('\n') + (rows.length ? '\n' : ''));
  } else if (format === 'json') {
    await write(out, rows.map((r) => JSON.stringify({ ...(single ? {} : { _table: table }), ...Object.fromEntries(columns.map((c, i) => [c, r[i]])) })).join('\n') + (rows.length ? '\n' : ''));
  } else if (format === 'xml') {
    if (first) await write(out, `  <table name="${esc(table)}">\n`);
    await write(out, rows.map((r) => `    <row>\n${columns.map((c, i) => (r[i] === null ? `      <${esc(c)} null="true"/>` : `      <${esc(c)}>${esc(val(r[i]))}</${esc(c)}>`)).join('\n')}\n    </row>`).join('\n') + (rows.length ? '\n' : ''));
  } else throw new Error(`${format} is not available for ${db}`);
}

/** Graphviz: one record per table, an edge per foreign key. */
async function writeDot(d: Driver, db: string, only: string[], out: WriteStream, progress: Progress) {
  const all = (await d.tables(db)).filter((t) => t.type === 'table' && (!only.length || only.includes(t.name)));
  await write(out, `digraph "${db}" {\n  graph [rankdir=LR, splines=ortho, nodesep=0.6, fontname="Helvetica"];\n  node [shape=plain, fontname="Helvetica", fontsize=10];\n  edge [color="#64748b", arrowsize=0.7];\n\n`);
  const edges: string[] = [];
  let i = 0;
  for (const t of all) {
    progress(t.name, i++, all.length);
    const st = await d.structure(db, t.name);
    const rows = st.columns.map((c) => `      <tr><td align="left" port="${esc(c.name)}">${c.key ? '🔑 ' : ''}${esc(c.name)}</td><td align="left"><font color="#64748b">${esc(c.type)}</font></td></tr>`).join('\n');
    await write(out, `  "${t.name}" [label=<\n    <table border="0" cellborder="1" cellspacing="0" cellpadding="4">\n      <tr><td colspan="2" bgcolor="#e2e8f0"><b>${esc(t.name)}</b></td></tr>\n${rows}\n    </table>>];\n`);
    for (const fk of st.foreignKeys) if (!only.length || only.includes(fk.refTable)) edges.push(`  "${t.name}":"${fk.columns[0]}" -> "${fk.refTable}":"${fk.refColumns[0]}" [label="${esc(fk.name)}", fontsize=8, fontcolor="#94a3b8"];`);
  }
  await write(out, `\n${edges.join('\n')}\n}\n`);
}

// ------------------------------------------------------------------ Import

export async function importFrom(d: Driver, path: string, o: DvImportOptions, progress: Progress): Promise<string> {
  const name = basename(path);
  if (/\.tar\.gz$|\.tgz$/i.test(name)) return importBackup(d, path, progress);
  if (o.format === 'sql') {
    const text = await readText(path);
    const statements = splitStatements(text);
    let n = 0;
    for (const s of statements) {
      await d.exec(o.database, s);
      if (++n % 20 === 0 || n === statements.length) progress(`${n} / ${statements.length} statements`, n, statements.length);
    }
    return `${n} statements run in ${o.database}`;
  }
  if (o.format === 'redis') {
    const text = await readText(path);
    const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    let n = 0;
    for (const l of lines) {
      await d.exec(o.database, l);
      if (++n % 50 === 0 || n === lines.length) progress(`${n} / ${lines.length} commands`, n, lines.length);
    }
    return `${n} commands run`;
  }
  if (o.format === 'json') {
    if (!d.insertDocuments) throw new Error('NDJSON import is for MongoDB / Elasticsearch; use CSV or SQL here');
    checkName(o.table, 'Collection');
    const size = statSync(path).size;
    let n = 0;
    let buf: Record<string, unknown>[] = [];
    const flush = async () => {
      await d.insertDocuments!(o.database, o.table, buf);
      n += buf.length;
      buf = [];
      progress(`${n} documents`, n, Math.max(n, Math.round(size / 200)));
    };
    const text = await readText(path);
    const trimmed = text.trim();
    const docs: unknown[] = trimmed.startsWith('[') ? (JSON.parse(trimmed) as unknown[]) : trimmed.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    for (const doc of docs) {
      const { _table, ...rest } = doc as Record<string, unknown>;
      void _table;
      buf.push(rest);
      if (buf.length >= 500) await flush();
    }
    if (buf.length) await flush();
    return `${n} documents into ${o.table}`;
  }
  // CSV into a table: the header names the columns (else the table's columns in order).
  checkName(o.table, 'Table');
  const st = await d.structure(o.database, o.table).catch(() => null);
  const size = statSync(path).size;
  let columns: string[] | null = o.header ? null : (st?.columns.map((c) => c.name) ?? null);
  let n = 0;
  let bytes = 0;
  const rl = createInterface({ input: createReadStream(path) });
  let pending = '';
  for await (const raw of rl) {
    bytes += raw.length + 1;
    pending = pending ? `${pending}\n${raw}` : raw;
    if ((pending.match(/"/g) ?? []).length % 2 === 1) continue; // a quoted field spans lines
    const fields = parseCsvLine(pending);
    pending = '';
    if (!columns) {
      columns = fields.map((f) => f.trim());
      continue;
    }
    if (fields.length === 1 && fields[0] === '') continue;
    const values: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      if (i < fields.length) values[c] = fields[i] === '' ? (st?.columns.find((x) => x.name === c)?.nullable ? null : '') : fields[i];
    });
    await insertRow(d, o.database, o.table, values);
    if (++n % 50 === 0) progress(`${n} rows`, bytes, size);
  }
  progress(`${n} rows`, size, size);
  return `${n} rows into ${o.table}`;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function readText(path: string): Promise<string> {
  if (!/\.gz$/i.test(path)) return readFile(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const c of createReadStream(path).pipe(createGunzip())) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ------------------------------------------------------------------ Backup

/** Dumps each database to <db>.sql (or .ndjson / .redis) and packs them as one .tar.gz. */
export async function backupTo(d: Driver, path: string, databases: string[], progress: Progress) {
  const dir = mkdtempSync(join(tmpdir(), 'dbcatz-'));
  try {
    let i = 0;
    for (const db of databases) {
      progress(db, i++, databases.length);
      const ext = DV_SQL.includes(d.engine) ? 'sql' : DV_KEYVALUE.includes(d.engine) ? 'redis' : 'ndjson';
      const file = join(dir, `${db.replace(/[/\\]/g, '_')}.${ext}`);
      await exportTo(d, file, { database: db, tables: [], format: ext === 'sql' ? 'sql' : ext === 'redis' ? 'redis' : 'json', structure: true, data: true, dropFirst: true }, (detail, done, total) => progress(`${db}: ${detail}`, done, total));
    }
    await writeFile(join(dir, 'dbcatz.json'), JSON.stringify({ engine: d.engine, databases, created: new Date().toISOString(), version: 1 }, null, 2));
    progress('Packing', databases.length, databases.length + 1);
    await tar.create({ gzip: true, file: path, cwd: dir, portable: true }, readdirSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A DevCatz backup: each file goes into the database of its name (made when missing). */
async function importBackup(d: Driver, path: string, progress: Progress): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dbcatz-'));
  try {
    await tar.extract({ file: path, cwd: dir });
    const files = readdirSync(dir).filter((f) => /\.(sql|ndjson|redis)$/i.test(f));
    if (!files.length) throw new Error('No .sql / .ndjson / .redis files in the archive');
    const existing = await d.databases();
    let i = 0;
    const done: string[] = [];
    for (const f of files) {
      const db = f.replace(/\.(sql|ndjson|redis)$/i, '');
      progress(db, i++, files.length);
      if (!existing.includes(db) && d.engine !== 'sqlite' && !DV_KEYVALUE.includes(d.engine)) {
        if (d.createDatabase) await d.createDatabase(db);
        else await d.query('', d.engine === 'postgresql' ? `CREATE DATABASE ${quoteIdent(d.engine, db)}` : `CREATE DATABASE ${quoteIdent(d.engine, db)} CHARACTER SET utf8mb4`);
      }
      const ext = extname(f).slice(1).toLowerCase();
      if (ext === 'ndjson') {
        // one line per document with its _table.
        const text = await readFile(join(dir, f), 'utf8');
        const byTable = new Map<string, Record<string, unknown>[]>();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const { _table, ...doc } = JSON.parse(line) as Record<string, unknown>;
          const t = String(_table ?? 'imported');
          (byTable.get(t) ?? byTable.set(t, []).get(t)!).push(doc);
        }
        for (const [t, docs] of byTable) {
          if (d.createTable) await d.createTable(db, t, []).catch(() => undefined);
          for (let k = 0; k < docs.length; k += 500) await d.insertDocuments!(db, t, docs.slice(k, k + 500));
        }
      } else await importFrom(d, join(dir, f), { database: db, format: ext === 'redis' ? 'redis' : 'sql', table: '', header: true }, (detail, a, b) => progress(`${db}: ${detail}`, a, b));
      done.push(db);
    }
    return `Restored ${done.join(', ')}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
