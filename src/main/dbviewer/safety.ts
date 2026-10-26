import type { DvAlterOp, DvColumn, DvColumnDef, DvEngine, DvRisk, DvRiskItem, DvStructure } from '@shared/types';
import { DV_SQL } from '@shared/types';
import { quoteIdent, quoteTable, type Driver } from './driver';

/**
 * Checks a structure change before it runs: the primary key (drop, type,
 * NULL, auto increment), foreign keys pointing at the table (types must keep
 * matching, referenced columns cannot go), values that would not fit the new
 * type (length, number range, NULLs, ENUM values, non-numbers), duplicates for
 * a new UNIQUE index, and long table rebuilds. Every query is a read.
 */

interface IncomingFk {
  name: string;
  table: string;
  columns: string[];
  refColumns: string[];
}

/** Foreign keys of other tables (or this one) that reference `table`. */
export async function incomingFks(d: Driver, db: string, table: string): Promise<IncomingFk[]> {
  const e = d.engine;
  try {
    if (e === 'mysql' || e === 'mariadb') {
      const r = await d.query(db, 'SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION', [db, table]);
      const map = new Map<string, IncomingFk>();
      for (const [name, t, c, rc] of r.rows as string[][]) {
        const f = map.get(`${t}.${name}`) ?? { name, table: t, columns: [], refColumns: [] };
        f.columns.push(c);
        f.refColumns.push(rc);
        map.set(`${t}.${name}`, f);
      }
      return [...map.values()];
    }
    if (e === 'postgresql') {
      const [schema, name] = table.includes('.') ? table.split('.', 2) : ['public', table];
      const r = await d.query(
        db,
        `SELECT con.conname, src.relname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class dst ON dst.oid = con.confrelid JOIN pg_namespace n ON n.oid = dst.relnamespace JOIN pg_class src ON src.oid = con.conrelid
         WHERE con.contype = 'f' AND n.nspname = ? AND dst.relname = ?`,
        [schema, name],
      );
      return (r.rows as string[][]).map(([n, t, def]) => {
        const m = /FOREIGN KEY \(([^)]+)\) REFERENCES [^(]+\(([^)]+)\)/.exec(def) ?? [];
        const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
        return { name: n, table: t, columns: list(m[1]), refColumns: list(m[2]) };
      });
    }
    if (e === 'sqlite') {
      const out: IncomingFk[] = [];
      for (const t of await d.tables(db)) {
        if (t.type !== 'table') continue;
        const r = await d.query(db, `PRAGMA foreign_key_list(${quoteIdent('sqlite', t.name)})`);
        const ci = (n: string) => r.columns.indexOf(n);
        const map = new Map<string, IncomingFk>();
        for (const row of r.rows) {
          if (String(row[ci('table')]) !== table) continue;
          const id = String(row[ci('id')]);
          const f = map.get(id) ?? { name: `${t.name} fk ${id}`, table: t.name, columns: [], refColumns: [] };
          f.columns.push(String(row[ci('from')]));
          f.refColumns.push(String(row[ci('to')] ?? ''));
          map.set(id, f);
        }
        out.push(...map.values());
      }
      return out;
    }
  } catch {
    /* the check is best effort; the server still refuses what it cannot do */
  }
  return [];
}

// ---------------------------------------------------------------- type helpers

const baseOf = (t: string) => t.toLowerCase().replace(/\s+unsigned|\s+zerofill/g, '').replace(/\(.*$/, '').trim();
const lenOf = (t: string) => {
  const m = /\(\s*(\d+)/.exec(t);
  return m ? Number(m[1]) : null;
};
const same = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, '') === b.toLowerCase().replace(/\s+/g, '');
const isText = (b: string) => /^(varchar|char|character varying|character|text|tinytext|mediumtext|longtext|nvarchar|nchar|citext|string)$/.test(b);
const isInt = (b: string) => /^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|smallserial|int2|int4|int8)$/.test(b);
const isNum = (b: string) => isInt(b) || /^(decimal|numeric|float|double|double precision|real|float4|float8|money)$/.test(b);
const isTemporal = (b: string) => /^(date|datetime|timestamp|timestamptz|time|timetz|year|timestamp with time zone|timestamp without time zone)$/.test(b);
const textCap = (t: string): number | null => {
  const b = baseOf(t);
  if (b === 'tinytext') return 255;
  if (b === 'text' && !/\(/.test(t)) return null;
  return /^(varchar|char|character varying|character|nvarchar|nchar)$/.test(b) ? lenOf(t) : null;
};
const INT_RANGE: Record<string, [number, number, number]> = {
  // signed min, signed max, unsigned max
  tinyint: [-128, 127, 255],
  smallint: [-32768, 32767, 65535],
  int2: [-32768, 32767, 65535],
  smallserial: [1, 32767, 32767],
  mediumint: [-8388608, 8388607, 16777215],
  int: [-2147483648, 2147483647, 4294967295],
  integer: [-2147483648, 2147483647, 4294967295],
  int4: [-2147483648, 2147483647, 4294967295],
  serial: [1, 2147483647, 2147483647],
};
const enumValues = (t: string) => (/^(enum|set)\s*\((.*)\)$/i.exec(t.trim())?.[2] ?? '').split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((v) => v.trim().replace(/^'|'$/g, '').replace(/''/g, "'")).filter(Boolean);

const lengthFn = (e: DvEngine) => (e === 'sqlite' ? 'LENGTH' : 'CHAR_LENGTH');

async function scalar(d: Driver, db: string, sql: string, params: unknown[] = []): Promise<number | null> {
  try {
    const r = await d.query(db, sql, params);
    const v = r.rows[0]?.[0];
    return v === null || v === undefined ? null : Number(v);
  } catch {
    return null;
  }
}

const fmt = (n: number) => n.toLocaleString('en-US');

// ---------------------------------------------------------------- the check

export async function analyzeAlter(d: Driver, db: string, table: string, ops: DvAlterOp[]): Promise<DvRisk> {
  const items: DvRiskItem[] = [];
  const e = d.engine;
  let confirmWord = table;
  if (!DV_SQL.includes(e)) return { level: 'none', items, confirmWord };
  let st: DvStructure;
  try {
    st = await d.structure(db, table);
  } catch {
    return { level: 'none', items, confirmWord };
  }
  const t = quoteTable(e, table);
  const q = (c: string) => quoteIdent(e, c);
  const pk = st.primaryKey;
  const incoming = await incomingFks(d, db, table);
  const rowsEst = (await d.tables(db).catch(() => [])).find((x) => x.name === table)?.rows ?? null;
  const add = (level: DvRiskItem['level'], title: string, detail: string) => items.push({ level, title, detail });
  const refsTo = (c: string) => incoming.filter((f) => f.refColumns.includes(c));
  const refList = (fs: IncomingFk[]) => fs.map((f) => `${f.table}.${f.columns.join(', ')} (${f.name})`).join('; ');
  const colOf = (n: string): DvColumn | undefined => st.columns.find((c) => c.name === n);
  const bigRebuild = () => {
    if (rowsEst !== null && rowsEst > 500_000) add('warn', 'Large table rebuild', `${table} has about ${fmt(rowsEst)} rows: the change rewrites the table and can lock it for minutes. Run it at a quiet moment, or with an online migration tool.`);
  };

  if (ops.length === 1 && 'name' in ops[0] && (ops[0].op === 'dropColumn' || ops[0].op === 'dropIndex')) confirmWord = ops[0].name;
  if (ops.length === 1 && ops[0].op === 'modifyColumn') confirmWord = ops[0].column.name;

  for (const op of ops) {
    switch (op.op) {
      case 'dropColumn': {
        const c = op.name;
        if (st.columns.length <= 1) {
          add('block', 'Last column', `A table needs at least one column: drop the table instead.`);
          break;
        }
        const refs = refsTo(c);
        if (refs.length) add('block', `${c} is referenced by a foreign key`, `Referenced by ${refList(refs)}. Drop or change those foreign keys first; dropping it here would break them.`);
        if (pk.includes(c)) add('danger', `${c} is ${pk.length > 1 ? 'part of ' : ''}the primary key`, 'The table loses its row identity: DBCatz and most apps (ORMs, replication) can no longer update or delete single rows reliably.');
        const own = st.foreignKeys.filter((f) => f.columns.includes(c));
        if (own.length) add('warn', 'Its foreign key goes too', `${own.map((f) => `${f.name} → ${f.refTable}`).join(', ')} is dropped with it.`);
        const idx = st.indexes.filter((i) => !i.primary && i.columns.includes(c));
        if (idx.length) add('warn', 'Indexes change', `${idx.map((i) => i.name).join(', ')} ${idx.length === 1 ? 'uses' : 'use'} this column and ${idx.length === 1 ? 'is' : 'are'} dropped or narrowed.`);
        add('danger', `Every value of ${c} is deleted`, rowsEst ? `About ${fmt(rowsEst)} rows lose this value. There is no undo; export the table first if you may need it.` : 'There is no undo; export the table first if you may need it.');
        bigRebuild();
        break;
      }
      case 'renameColumn': {
        if (pk.includes(op.from) || refsTo(op.from).length) add('warn', `${op.from} is a key column`, `${pk.includes(op.from) ? 'It is in the primary key. ' : ''}${refsTo(op.from).length ? `Referenced by ${refList(refsTo(op.from))} (updated by the server). ` : ''}Apps and queries that name it break.`);
        else add('warn', 'Apps using the old name break', `Code, views and queries that name ${op.from} must change to ${op.to}.`);
        break;
      }
      case 'modifyColumn': {
        const nc: DvColumnDef = op.column;
        const old = colOf(nc.name);
        if (!old) break;
        const oldB = baseOf(old.type);
        const newB = baseOf(nc.type);
        const typeChanged = !same(old.type, nc.type);
        const c = nc.name;
        const qc = q(c);
        const inPk = pk.includes(c);
        if (inPk && nc.nullable) add('block', 'A primary key cannot allow NULL', `Keep ${c} NOT NULL, or drop the primary key first.`);
        if (inPk && typeChanged) add('danger', `Changes the primary key's type`, `${c}: ${old.type} → ${nc.type}. Every index and foreign key on it is rebuilt; apps that store the id elsewhere may no longer match.`);
        if (inPk && old.autoIncrement && !nc.autoIncrement) add('danger', 'Auto increment turned off on the primary key', 'Inserts that leave the id out will fail.');
        const refs = refsTo(c);
        if (refs.length && typeChanged) add('block', `${c} is referenced by a foreign key`, `Referenced by ${refList(refs)}: the referencing column must keep the same type. Change those first, or drop the foreign keys.`);
        const own = st.foreignKeys.filter((f) => f.columns.includes(c));
        if (own.length && typeChanged) add('block', `${c} has a foreign key`, `${own.map((f) => `${f.name} → ${f.refTable}(${f.refColumns.join(', ')})`).join(', ')}: the type must match the referenced column.`);
        // NULLs into NOT NULL.
        if (old.nullable && !nc.nullable) {
          const n = await scalar(d, db, `SELECT COUNT(*) FROM ${t} WHERE ${qc} IS NULL`);
          if (n) add('block', `${fmt(n)} rows are NULL in ${c}`, `Fill them first (UPDATE ${table} SET ${c} = … WHERE ${c} IS NULL), or keep NULL allowed.`);
        }
        // Character set / collation.
        const csChanged = (nc.charset ?? '') !== '' && (old.charset ?? '') !== '' && nc.charset!.toLowerCase() !== old.charset!.toLowerCase();
        const coChanged = (nc.collation ?? '') !== '' && (old.collation ?? '') !== '' && nc.collation!.toLowerCase() !== old.collation!.toLowerCase();
        if ((csChanged || coChanged) && (refs.length || own.length))
          add('block', 'Foreign keys need the same character set and collation', `${c} is ${refs.length ? `referenced by ${refList(refs)}` : `a foreign key column`}: both sides must keep matching. Change them together, or drop the foreign key first.`);
        if (csChanged) {
          const narrow = /^(latin1|ascii|latin2|cp1250|cp1251|cp1252|tis620|sjis|gbk|big5|euckr|ujis|utf8mb3|utf8)$/i.test(nc.charset!) && /^utf8mb4$/i.test(old.charset!);
          add(narrow ? 'danger' : 'warn', `Character set ${old.charset} → ${nc.charset}`, narrow ? `${nc.charset} has fewer characters than ${old.charset}: emoji and many scripts become “?” or make the change fail.` : 'Values are re-encoded; check text afterwards.');
        }
        if (coChanged && !csChanged) add('warn', `Collation ${old.collation} → ${nc.collation}`, `Sorting and comparisons change (case / accent sensitivity); a UNIQUE index on ${c} may start to treat values as duplicates.`);
        if (typeChanged) {
          // Text: values longer than the new length.
          const cap = textCap(nc.type);
          if (cap !== null && (isText(oldB) || isNum(oldB) || isTemporal(oldB))) {
            const n = await scalar(d, db, `SELECT COUNT(*) FROM ${t} WHERE ${lengthFn(e)}(${e === 'postgresql' ? `${qc}::text` : qc}) > ?`, [cap]);
            if (n) {
              const longest = await scalar(d, db, `SELECT MAX(${lengthFn(e)}(${e === 'postgresql' ? `${qc}::text` : qc})) FROM ${t}`);
              add('block', `${fmt(n)} values are longer than ${cap}`, `The longest is ${longest ?? '?'} characters: they would be cut or the change would fail. Use at least ${nc.type.replace(/\(\s*\d+/, `(${longest ?? cap}`)}.`);
            }
          }
          // Numbers: values outside the new integer range.
          if (isInt(newB) && INT_RANGE[newB] && (isNum(oldB) || isText(oldB))) {
            const [min, max, umax] = INT_RANGE[newB];
            const unsigned = /unsigned/i.test(nc.type);
            const lo = unsigned ? 0 : min;
            const hi = unsigned ? umax : max;
            const cast = isText(oldB) ? (e === 'postgresql' ? `NULLIF(${qc}, '')::numeric` : `CAST(${qc} AS DECIMAL(65,10))`) : qc;
            const n = isNum(oldB) || e !== 'postgresql' ? await scalar(d, db, `SELECT COUNT(*) FROM ${t} WHERE ${cast} < ? OR ${cast} > ?`, [lo, hi]) : null;
            if (n) add('block', `${fmt(n)} values do not fit ${nc.type}`, `${nc.type} holds ${fmt(lo)} … ${fmt(hi)}. Pick a larger type (e.g. BIGINT).`);
            if (isNum(oldB) && !isInt(oldB)) {
              const f = await scalar(d, db, `SELECT COUNT(*) FROM ${t} WHERE ${qc} <> ROUND(${qc})`);
              if (f) add('danger', `${fmt(f)} values have decimals`, 'Turning them into whole numbers rounds them.');
            }
          }
          // Text → number: values that are not numbers.
          if (isNum(newB) && isText(oldB) && e !== 'sqlite') {
            const notNum = e === 'postgresql' ? `${qc} !~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$'` : `${qc} NOT REGEXP '^[[:space:]]*-?[0-9]+(\\\\.[0-9]+)?[[:space:]]*$'`;
            const n = await scalar(d, db, `SELECT COUNT(*) FROM ${t} WHERE ${qc} IS NOT NULL AND ${qc} <> '' AND ${notNum}`);
            if (n) add('block', `${fmt(n)} values are not numbers`, `${c} holds text that ${nc.type} cannot store. Clean those rows first.`);
          }
          // ENUM / SET: values missing from the new list.
          const vals = enumValues(nc.type);
          if (vals.length && (e === 'mysql' || e === 'mariadb')) {
            const n = /^enum/i.test(nc.type) ? await scalar(d, db, `SELECT COUNT(*) FROM ${t} WHERE ${qc} IS NOT NULL AND ${qc} <> '' AND ${qc} NOT IN (${vals.map(() => '?').join(', ')})`, vals) : null;
            if (n) add('block', `${fmt(n)} values are not in the new list`, `Allowed: ${vals.join(', ')}. Change those rows first, or add their values.`);
          }
          if (isText(oldB) && (isTemporal(newB) || newB === 'json' || newB === 'jsonb')) add('warn', `Text to ${newB}`, `Values that are not valid ${newB} make the change fail${e === 'mysql' || e === 'mariadb' ? ' (or become zero / NULL outside strict mode)' : ''}.`);
          if (!items.some((i) => i.title.startsWith('Changes the primary key')) && !items.some((i) => i.level === 'block')) add('warn', `Type change: ${old.type} → ${nc.type}`, 'Values are converted by the server; check the data afterwards.');
          bigRebuild();
        }
        break;
      }
      case 'dropIndex': {
        const idx = st.indexes.find((i) => i.name === op.name);
        if (!idx) break;
        if (idx.primary) add('danger', 'Drops the primary key', 'The table loses its row identity: single rows can no longer be updated or deleted reliably.');
        const usedByFk = (e === 'mysql' || e === 'mariadb') && st.foreignKeys.find((f) => f.columns.every((c, k) => idx.columns[k] === c));
        if (usedByFk && !st.indexes.some((o) => o !== idx && usedByFk.columns.every((c, k) => o.columns[k] === c))) add('block', `Foreign key ${usedByFk.name} needs this index`, 'MySQL keeps an index for every foreign key: drop the foreign key first.');
        if (idx.unique && !idx.primary) add('warn', 'Duplicates become possible', `${idx.columns.join(', ')} no longer has to be unique; code that relies on it may misbehave.`);
        if (!idx.unique && !idx.primary) add('warn', 'Queries may get slower', `Lookups on ${idx.columns.join(', ')} lose their index.`);
        break;
      }
      case 'addIndex': {
        if (op.unique && op.columns.length) {
          const cols = op.columns.map(q).join(', ');
          const nulls = op.columns.map((c) => `${q(c)} IS NOT NULL`).join(' AND ');
          const n = await scalar(d, db, `SELECT COUNT(*) FROM (SELECT 1 FROM ${t} WHERE ${nulls} GROUP BY ${cols} HAVING COUNT(*) > 1) dup`);
          if (n) add('block', `${fmt(n)} duplicate ${op.columns.length > 1 ? 'combinations' : 'values'}`, `${op.columns.join(', ')} already repeats in ${fmt(n)} ${n === 1 ? 'case' : 'cases'}: remove the duplicates before making it unique.`);
        }
        if (rowsEst !== null && rowsEst > 500_000) add('warn', 'Building an index on a large table', `About ${fmt(rowsEst)} rows: it can take a while and slow the server meanwhile.`);
        break;
      }
      case 'addColumn': {
        const c = op.column;
        // Estimates can be 0 for a table never analyzed: ask whether a row exists.
        const hasRows = (rowsEst ?? 0) > 0 || !!(await scalar(d, db, `SELECT COUNT(*) FROM (SELECT 1 FROM ${t} LIMIT 1) one`));
        if (!c.nullable && !c.default.trim() && !c.autoIncrement && hasRows)
          add(e === 'postgresql' || e === 'sqlite' ? 'block' : 'warn', 'NOT NULL without a default', e === 'postgresql' || e === 'sqlite' ? 'Existing rows need a value: give the column a default, or allow NULL.' : `Existing rows get an implicit value (0, '' or a zero date). Give it a default to choose.`);
        if (c.unique && hasRows && !c.nullable && !c.autoIncrement) add('block', 'UNIQUE on a new NOT NULL column', 'Every existing row would get the same value: allow NULL or add the unique index later.');
        bigRebuild();
        break;
      }
      case 'renameTable': {
        const refs = incoming.filter((f) => f.table !== table);
        add('warn', 'Apps using the old name break', `Code, views and queries that name ${table} must change to ${op.to}.${refs.length ? ` Foreign keys from ${[...new Set(refs.map((f) => f.table))].join(', ')} follow the rename.` : ''}`);
        break;
      }
    }
  }
  const level = items.some((i) => i.level === 'block') ? 'block' : items.some((i) => i.level === 'danger') ? 'danger' : items.length ? 'warn' : 'none';
  return { level, items, confirmWord };
}

/** Dropping / emptying a whole table: other tables that point at it. */
export async function analyzeTableRemoval(d: Driver, db: string, table: string): Promise<DvRiskItem[]> {
  if (!DV_SQL.includes(d.engine)) return [];
  const refs = (await incomingFks(d, db, table)).filter((f) => f.table !== table);
  return refs.length ? [{ level: 'block', title: 'Other tables reference it', detail: `${[...new Set(refs.map((f) => `${f.table} (${f.name})`))].join(', ')} point at ${table}. Drop those foreign keys (or the tables) first.` }] : [];
}
