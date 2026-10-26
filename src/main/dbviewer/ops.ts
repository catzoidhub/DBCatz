import type { DvAlterOp, DvColumnDef, DvEngine, DvResult, DvRows, DvRowsQuery } from '@shared/types';
import { DV_SQL } from '@shared/types';
import { quoteIdent, quoteTable, splitStatements, type Driver } from './driver';

/**
 * Grid operations and DDL for the SQL engines, built from SQL; document
 * engines do the same through their driver methods (see driver.ts).
 */

const isSql = (d: Driver) => DV_SQL.includes(d.engine);
const NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function checkName(name: string, what = 'name'): string {
  if (!NAME.test(name)) throw new Error(`${what} may only have letters, digits and _ (${name || 'empty'})`);
  return name;
}

/** `name` is a user-typed column; quoted when it is a plain identifier, rejected otherwise. */
const col = (engine: DvEngine, name: string) => quoteIdent(engine, checkName(name, 'Column'));

function keyWhere(engine: DvEngine, key: Record<string, unknown>): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(key)) {
    if (v === null) parts.push(`${col(engine, k)} IS NULL`);
    else {
      parts.push(`${col(engine, k)} = ?`);
      params.push(v);
    }
  }
  if (!parts.length) throw new Error('The table has no primary key; edit it with a query');
  return { sql: parts.join(' AND '), params };
}

/** A grid value back to a bind value: '' stays '', numbers / strings as typed; `null` is NULL. */
const bind = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

export async function rows(d: Driver, db: string, table: string, q: DvRowsQuery): Promise<DvRows> {
  if (d.rows) return d.rows(db, table, q);
  if (!isSql(d)) throw new Error('No rows for this engine');
  const t0 = Date.now();
  const e = d.engine;
  const t = quoteTable(e, table);
  const where = q.where.trim() ? ` WHERE ${q.where.trim()}` : '';
  const order = q.orderBy ? ` ORDER BY ${col(e, q.orderBy)}${q.desc ? ' DESC' : ''}` : '';
  const st = await d.structure(db, table);
  const [data, count] = await Promise.all([
    d.query(db, `SELECT * FROM ${t}${where}${order} LIMIT ${Math.max(1, Math.floor(q.limit))} OFFSET ${Math.max(0, Math.floor(q.offset))}`),
    d.query(db, `SELECT COUNT(*) FROM ${t}${where}`),
  ]);
  return { columns: data.columns, rows: data.rows, total: Number(count.rows[0]?.[0] ?? 0), primaryKey: st.primaryKey, ms: Date.now() - t0 };
}

export async function updateRow(d: Driver, db: string, table: string, key: Record<string, unknown>, changes: Record<string, unknown>) {
  if (d.updateRow) return d.updateRow(db, table, key, changes);
  const e = d.engine;
  const sets = Object.keys(changes).map((k) => `${col(e, k)} = ?`);
  if (!sets.length) return;
  const w = keyWhere(e, key);
  const r = await d.query(db, `UPDATE ${quoteTable(e, table)} SET ${sets.join(', ')} WHERE ${w.sql}`, [...Object.values(changes).map(bind), ...w.params]);
  if (r.affected === 0) throw new Error('No row matched the primary key (it may have changed)');
}

export async function insertRow(d: Driver, db: string, table: string, values: Record<string, unknown>) {
  if (d.insertRow) return d.insertRow(db, table, values);
  const e = d.engine;
  const keys = Object.keys(values);
  // Every column left to its default: MySQL / MariaDB spell it `() VALUES ()`, the others DEFAULT VALUES.
  const sql = keys.length
    ? `INSERT INTO ${quoteTable(e, table)} (${keys.map((k) => col(e, k)).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    : e === 'mysql' || e === 'mariadb'
      ? `INSERT INTO ${quoteTable(e, table)} () VALUES ()`
      : `INSERT INTO ${quoteTable(e, table)} DEFAULT VALUES`;
  await d.query(db, sql, Object.values(values).map(bind));
}

export async function deleteRows(d: Driver, db: string, table: string, keys: Record<string, unknown>[]): Promise<number> {
  if (d.deleteRows) return d.deleteRows(db, table, keys);
  let n = 0;
  for (const key of keys) {
    const w = keyWhere(d.engine, key);
    const r = await d.query(db, `DELETE FROM ${quoteTable(d.engine, table)} WHERE ${w.sql}`, w.params);
    n += r.affected ?? 0;
  }
  return n;
}

/** Runs a script statement by statement; an error stops at that statement. */
export async function runQuery(d: Driver, db: string, text: string): Promise<DvResult[]> {
  const statements = isSql(d) ? splitStatements(text) : d.engine === 'mongodb' ? text.split(/\n(?=db\.|\{)/).filter((s) => s.trim()) : d.engine === 'elasticsearch' ? text.split(/\n(?=(?:GET|POST|PUT|DELETE|HEAD)\s)/i).filter((s) => s.trim()) : text.split('\n').filter((s) => s.trim() && !s.trim().startsWith('#'));
  const out: DvResult[] = [];
  for (const statement of statements) {
    const t0 = Date.now();
    try {
      const r = await d.query(db, statement);
      out.push({ statement, columns: r.columns, rows: r.rows.slice(0, 5000), affected: r.affected, ms: Date.now() - t0, error: null });
    } catch (e) {
      out.push({ statement, columns: [], rows: [], affected: null, ms: Date.now() - t0, error: (e as Error).message });
      break;
    }
  }
  return out;
}

const CHARSET = /^[A-Za-z0-9_.@-]+$/;

export async function createDatabase(d: Driver, name: string, o?: { charset: string; collation: string }) {
  if (d.createDatabase) return d.createDatabase(name, o);
  if (!isSql(d) || d.engine === 'sqlite') throw new Error('Databases are made on the Database page for this engine');
  checkName(name, 'Database name');
  const charset = o?.charset.trim() ?? '';
  const collation = o?.collation.trim() ?? '';
  for (const v of [charset, collation]) if (v && !CHARSET.test(v)) throw new Error(`Unexpected name ${v}`);
  if (d.engine === 'postgresql') {
    // A non-default encoding or collation needs template0 (template1 is already encoded).
    const parts = [`CREATE DATABASE ${quoteIdent('postgresql', name)}`];
    if (charset) parts.push(`ENCODING '${charset}'`);
    if (collation) parts.push(`LC_COLLATE '${collation}' LC_CTYPE '${collation}'`);
    if (charset || collation) parts.push('TEMPLATE template0');
    await d.query('', parts.join(' '));
    return;
  }
  await d.query('', `CREATE DATABASE ${quoteIdent(d.engine, name)} CHARACTER SET ${charset || 'utf8mb4'}${collation ? ` COLLATE ${collation}` : charset ? '' : ' COLLATE utf8mb4_unicode_ci'}`);
}

export async function dropDatabase(d: Driver, name: string) {
  if (d.dropDatabase) return d.dropDatabase(name);
  if (!isSql(d) || d.engine === 'sqlite') throw new Error('Database files are removed on the Database page');
  await d.query('', `DROP DATABASE ${quoteIdent(d.engine, name)}`);
}

export function columnSql(e: DvEngine, c: DvColumnDef, forAlter = false): string {
  let type = c.type.trim() || (e === 'postgresql' ? 'text' : 'VARCHAR(255)');
  if (c.autoIncrement && e === 'postgresql' && /^(int|integer|int4)$/i.test(type)) type = 'serial';
  if (c.autoIncrement && e === 'postgresql' && /^(bigint|int8)$/i.test(type)) type = 'bigserial';
  const parts = [col(e, c.name), type];
  const cs = (c.charset ?? '').trim();
  const co = (c.collation ?? '').trim();
  for (const v of [cs, co]) if (v && !/^[A-Za-z0-9_.@-]+$/.test(v)) throw new Error(`Unexpected name ${v}`);
  if (e === 'mysql' || e === 'mariadb') {
    if (cs) parts.push(`CHARACTER SET ${cs}`);
    if (co) parts.push(`COLLATE ${co}`);
  } else if (co) parts.push(e === 'postgresql' ? `COLLATE "${co}"` : `COLLATE ${co}`);
  if (e === 'sqlite' && c.primary && c.autoIncrement) parts.push('PRIMARY KEY AUTOINCREMENT');
  if (!c.nullable && !(e === 'sqlite' && c.primary && c.autoIncrement)) parts.push('NOT NULL');
  if (c.default.trim()) parts.push(`DEFAULT ${defaultSql(c.default.trim())}`);
  if (c.autoIncrement && (e === 'mysql' || e === 'mariadb')) parts.push('AUTO_INCREMENT');
  if (c.autoIncrement && e === 'postgresql' && !/serial$/i.test(type)) parts.push('GENERATED BY DEFAULT AS IDENTITY');
  if (forAlter && c.primary && e !== 'sqlite') parts.push('PRIMARY KEY');
  if ((e === 'mysql' || e === 'mariadb') && c.comment?.trim()) parts.push(`COMMENT ${literalText(c.comment.trim())}`);
  return parts.join(' ');
}

const literalText = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/** PostgreSQL keeps comments apart: COMMENT ON COLUMN … IS … (NULL clears it). */
async function pgComment(d: Driver, db: string, table: string, c: DvColumnDef) {
  if (d.engine !== 'postgresql' || c.comment === undefined) return;
  await d.exec(db, `COMMENT ON COLUMN ${quoteTable('postgresql', table)}.${col('postgresql', c.name)} IS ${c.comment.trim() ? `'${c.comment.trim().replace(/'/g, "''")}'` : 'NULL'}`);
}

/** Typed defaults: SQL expressions and functions as is, everything else quoted. */
const defaultSql = (v: string) => (/^(NULL|CURRENT_TIMESTAMP(\(\))?|CURRENT_DATE|NOW\(\)|TRUE|FALSE|-?\d+(\.\d+)?|'.*'|\w+\(.*\)|gen_random_uuid\(\)|uuid\(\))$/i.test(v) ? v : `'${v.replace(/'/g, "''")}'`);

export async function createTable(d: Driver, db: string, table: string, columns: DvColumnDef[]) {
  if (d.createTable) return d.createTable(db, table, columns);
  const e = d.engine;
  checkName(table, 'Table name');
  if (!columns.length) throw new Error('A table needs at least one column');
  const lines = columns.map((c) => `  ${columnSql(e, c)}`);
  const pk = columns.filter((c) => c.primary);
  if (pk.length && !(e === 'sqlite' && pk.length === 1 && pk[0].autoIncrement)) lines.push(`  PRIMARY KEY (${pk.map((c) => col(e, c.name)).join(', ')})`);
  for (const c of columns) if (c.unique && !c.primary) lines.push(`  ${e === 'sqlite' ? '' : `CONSTRAINT ${quoteIdent(e, `${table}_${c.name}_unique`)} `}UNIQUE (${col(e, c.name)})`);
  const tail = e === 'mysql' || e === 'mariadb' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
  await d.exec(db, `CREATE TABLE ${quoteTable(e, table)} (\n${lines.join(',\n')}\n)${tail}`);
  for (const c of columns) if (c.comment?.trim()) await pgComment(d, db, table, c);
}

export async function alterTable(d: Driver, db: string, table: string, ops: DvAlterOp[]) {
  const e = d.engine;
  const t = quoteTable(e, table);
  for (const op of ops) {
    switch (op.op) {
      case 'renameTable':
        checkName(op.to, 'Table name');
        if (d.renameTable) await d.renameTable(db, table, op.to);
        else await d.exec(db, e === 'mysql' || e === 'mariadb' ? `RENAME TABLE ${t} TO ${quoteIdent(e, op.to)}` : `ALTER TABLE ${t} RENAME TO ${quoteIdent(e, op.to)}`);
        table = op.to;
        break;
      case 'addIndex':
        checkName(op.name, 'Index name');
        if (d.addIndex) await d.addIndex(db, table, op.name, op.columns, op.unique);
        else await d.exec(db, `CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(e, op.name)} ON ${t} (${op.columns.map((c) => col(e, c)).join(', ')})`);
        break;
      case 'dropIndex':
        if (d.dropIndex) await d.dropIndex(db, table, op.name);
        else await d.exec(db, e === 'mysql' || e === 'mariadb' ? `ALTER TABLE ${t} DROP INDEX ${quoteIdent(e, op.name)}` : `DROP INDEX ${quoteIdent(e, op.name)}`);
        break;
      case 'addColumn':
        if (!DV_SQL.includes(e)) throw new Error('Documents have no fixed columns; add fields on the rows');
        await d.exec(db, `ALTER TABLE ${t} ADD COLUMN ${columnSql(e, op.column, true)}${op.after && (e === 'mysql' || e === 'mariadb') ? ` AFTER ${col(e, op.after)}` : ''}`);
        if (op.column.unique && !op.column.primary) await d.exec(db, `CREATE UNIQUE INDEX ${quoteIdent(e, `${table}_${op.column.name}_unique`)} ON ${t} (${col(e, op.column.name)})`);
        if (op.column.comment?.trim()) await pgComment(d, db, table, op.column);
        break;
      case 'dropColumn':
        if (!DV_SQL.includes(e)) throw new Error('Documents have no fixed columns');
        await d.exec(db, `ALTER TABLE ${t} DROP COLUMN ${col(e, op.name)}`);
        break;
      case 'renameColumn':
        if (!DV_SQL.includes(e)) throw new Error('Documents have no fixed columns');
        await d.exec(db, `ALTER TABLE ${t} RENAME COLUMN ${col(e, op.from)} TO ${col(e, op.to)}`);
        break;
      case 'modifyColumn': {
        if (!DV_SQL.includes(e)) throw new Error('Documents have no fixed columns');
        const c = op.column;
        if (e === 'mysql' || e === 'mariadb') await d.exec(db, `ALTER TABLE ${t} MODIFY COLUMN ${columnSql(e, c)}`);
        else if (e === 'postgresql') {
          const n = col(e, c.name);
          const co = (c.collation ?? '').trim();
          if (co && !/^[A-Za-z0-9_.@-]+$/.test(co)) throw new Error(`Unexpected name ${co}`);
          const parts = [`ALTER COLUMN ${n} TYPE ${c.type}${co ? ` COLLATE "${co}"` : ''}`, `ALTER COLUMN ${n} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`, c.default.trim() ? `ALTER COLUMN ${n} SET DEFAULT ${defaultSql(c.default.trim())}` : `ALTER COLUMN ${n} DROP DEFAULT`];
          await d.exec(db, `ALTER TABLE ${t} ${parts.join(', ')}`);
          await pgComment(d, db, table, c);
        } else throw new Error('SQLite cannot change a column; create a new table and copy the rows');
        break;
      }
    }
  }
}

export async function dropTable(d: Driver, db: string, table: string) {
  if (d.dropTable) return d.dropTable(db, table);
  await d.exec(db, `DROP TABLE ${quoteTable(d.engine, table)}`);
}

export async function truncateTable(d: Driver, db: string, table: string) {
  if (d.truncate) return d.truncate(db, table);
  await d.exec(db, d.engine === 'sqlite' ? `DELETE FROM ${quoteTable('sqlite', table)}` : `TRUNCATE TABLE ${quoteTable(d.engine, table)}`);
}
