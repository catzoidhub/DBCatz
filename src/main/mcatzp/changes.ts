import type { ActionDef, CallResult } from '@catzoid/mcatzp-host';
import { statementKind } from '@shared/dbsafety';
import { splitQuery } from '@shared/sqlsplit';
import type { DbCatzApi, DvAlterOp, DvConnection, DvExportFormat, DvKeyInput, DvRisk, McatzpAsk } from '@shared/types';
import { DV_KEYVALUE } from '@shared/types';
import { findConnection, reply, resultsOut, type Scopes } from './actions';
import { ALTER_OPS, alterOps, COLUMN, column } from './schema';

/**
 * DBCatz's changes for MCatzP (TODO §16): each calls the same `api()` method its UI uses, so the app's own rules still
 * hold (a read-only connection refuses, drops check foreign keys). Every one asks first, in a dialog built here from
 * the real target, never from the assistant's words. Sorted case by case: what is really gone asks for a name to be
 * typed, every time; what can be had back or keeps the data is one dialog. A client never sets or sees a secret:
 * add_connection takes no password, and editing a connection, which could lift its Read-only mode, stays in the window.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description: string, maxLength = 512) => ({ type: 'string', minLength: 1, maxLength, description });
const CONNECTION = S("The connection's id or name (see list_connections).");
const DATABASE = S('The database (see list_databases). Redis / Valkey: db0, db1 …');
const TABLE = S('The table or view. MongoDB: a collection. Elasticsearch: an index.');
const SCALAR = { type: ['string', 'number', 'boolean', 'null'] };
const VALUES = (description: string) => ({ type: 'object', minProperties: 1, maxProperties: 500, additionalProperties: SCALAR, description });
type Fact = Extract<McatzpAsk, { kind: 'change' }>['facts'][number];
/** Where DBCatz opens once the user allows it, so they watch it happen. */
export interface McatzpPage {
  connId: string | null;
  db?: string;
  table?: string;
}
export interface ChangeAction extends ActionDef {
  /** Only stops work: runs at once, since a dialog would hold up the stopping. Still logged. */
  noDialog?: boolean;
  preview(args: Record<string, unknown>): Promise<{ title: string; facts: Fact[]; page: McatzpPage | null; typeName?: string }>;
}
type Q = Awaited<ReturnType<ChangeAction['preview']>>;

const short = (t: string, m = 500) => (t.length > m ? `${t.slice(0, m)}…` : t);
const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);
const valuesFact = (v: Record<string, unknown>) => short(Object.entries(v).map(([k, x]) => `${k} = ${x === null ? 'NULL' : String(x)}`).join(', '));
const opText = (o: DvAlterOp) =>
  o.op === 'addColumn' ? `add column ${o.column.name} ${o.column.type}` : o.op === 'dropColumn' ? `drop column ${o.name}` : o.op === 'renameColumn' ? `rename column ${o.from} to ${o.to}` : o.op === 'modifyColumn' ? `change column ${o.column.name} to ${o.column.type}` : o.op === 'addIndex' ? `add ${o.unique ? 'unique ' : ''}index ${o.name} (${o.columns.join(', ')})` : o.op === 'dropIndex' ? `drop index ${o.name}` : `rename the table to ${o.to}`;

export function changeActions(api: DbCatzApi, scopes: Scopes, logQuery: (connId: string, r: { text: string; ms: number; affected: number | null; error: string | null }) => void, shareConnection: (id: string) => void): ChangeAction[] {
  if (!scopes.changes) return [];
  const conn = async (ref: unknown) => findConnection(await api.dvConnections(), String(ref));
  /** A write's target: a read-only connection answers here, before any question. */
  const target = async (ref: unknown) => {
    const c = await conn(ref);
    if (c.options.mode === 'readonly') throw new Error(`${c.name} is read-only: the user can change that in DBCatz, on the connection`);
    return c;
  };
  const where = (c: DvConnection, db?: unknown): Fact[] => [{ label: 'On', value: `${c.name}${db ? ` · ${String(db)}` : ''}` }, ...(c.options.mode === 'production' ? [{ label: 'Mode', value: 'Production' }] : [])];
  const kv = async (ref: unknown) => {
    const c = await target(ref);
    if (!DV_KEYVALUE.includes(c.engine)) throw new Error(`${c.name} is ${c.engine}: keys are for Redis / Valkey`);
    return c;
  };
  const bulkWord = (c: DvConnection, db: string) => (c.options.mode === 'production' ? c.name : db);

  /** One dialog. `session`: low-risk, so it may offer "allow for this session". */
  const asked = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], preview: (a: Record<string, unknown>) => Promise<Q>, run: ChangeAction['run'], session = false): ChangeAction => ({ name, title, description: `${description} DBCatz asks the user first.`, tier: 'change', allowSession: session, input: OBJECT(props, required), preview, run });
  /** The real thing is gone: the user types a name, every time. */
  const typed = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], preview: (a: Record<string, unknown>) => Promise<Q & { typeName: string }>, run: ChangeAction['run']): ChangeAction => ({ name, title, description: `${description} The user types a name in DBCatz to allow it, every time.`, tier: 'destructive', input: OBJECT(props, required), preview, run });
  const inDb = { connection: CONNECTION, database: DATABASE };
  const inTable = { ...inDb, table: TABLE };
  const done = (data: unknown): CallResult => reply(data);

  return [
    // ---- rows
    asked('insert_row', 'Insert a row', 'Adds a row (MongoDB: a document). Columns left out take their default.', { ...inTable, values: VALUES('Column → value.') }, ['connection', 'database', 'table', 'values'], async (a) => {
      const c = await target(a.connection);
      return { title: `Add a row to ${String(a.table)}?`, facts: [...where(c, a.database), { label: 'Values', value: valuesFact(a.values as Record<string, unknown>) }], page: { connId: c.id, db: String(a.database), table: String(a.table) } };
    }, async (a) => {
      const c = await target(a.connection);
      await api.dvInsertRow(c.id, String(a.database), String(a.table), a.values as Record<string, unknown>);
      return done({ inserted: 1 });
    }),
    asked('update_row', 'Update a row', 'Changes one row, found by its whole primary key (describe_table names it). To change many, use run_write_query.', { ...inTable, key: VALUES('Primary key column → value.'), changes: VALUES('Column → new value.') }, ['connection', 'database', 'table', 'key', 'changes'], async (a) => {
      const c = await target(a.connection);
      await wholeKey(c.id, a);
      return { title: `Change a row in ${String(a.table)}?`, facts: [...where(c, a.database), { label: 'Row', value: valuesFact(a.key as Record<string, unknown>) }, { label: 'Set', value: valuesFact(a.changes as Record<string, unknown>) }], page: { connId: c.id, db: String(a.database), table: String(a.table) } };
    }, async (a) => {
      const c = await target(a.connection);
      await api.dvUpdateRow(c.id, String(a.database), String(a.table), a.key as Record<string, unknown>, a.changes as Record<string, unknown>);
      return done({ updated: 1 });
    }),
    typed('delete_rows', 'Delete rows', 'Deletes rows, each found by its whole primary key.', { ...inTable, keys: { type: 'array', minItems: 1, maxItems: 1000, items: VALUES('Primary key column → value.') } }, ['connection', 'database', 'table', 'keys'], async (a) => {
      const c = await target(a.connection);
      const keys = a.keys as Record<string, unknown>[];
      for (const key of keys) await wholeKey(c.id, { ...a, key });
      return { title: `Delete ${keys.length === 1 ? 'a row' : `${keys.length} rows`} from ${String(a.table)}?`, facts: [...where(c, a.database), { label: 'Rows', value: short(keys.map(valuesFact).join(' · ')) }], page: { connId: c.id, db: String(a.database), table: String(a.table) }, typeName: String(a.table) };
    }, async (a) => {
      const c = await target(a.connection);
      return done({ deleted: await api.dvDeleteRows(c.id, String(a.database), String(a.table), a.keys as Record<string, unknown>[]) });
    }),

    // ---- queries
    asked(
      'run_write_query',
      'Run a query that writes',
      'Runs a query that changes data or structure, statement by statement until one fails. On Production, or for something that removes data (DROP, TRUNCATE, DELETE without WHERE, FLUSHALL …), the user also types the connection name. To read, use run_read_query: it asks nothing.',
      { ...inDb, query: { type: 'string', minLength: 1, maxLength: 100000 } },
      ['connection', 'database', 'query'],
      async (a) => {
        const c = await target(a.connection);
        const parts = splitQuery(c.engine, String(a.query)).map((p) => p.trim()).filter(Boolean);
        if (!parts.length) throw new Error('The query is empty');
        const kinds = parts.map((p) => statementKind(c.engine, p));
        const reasons = [...new Set(kinds.map((k) => k.reason).filter((r): r is string => !!r))];
        const heavy = reasons.length > 0 || c.options.mode === 'production';
        return {
          title: `Run ${parts.length === 1 ? 'this query' : `these ${parts.length} statements`} on ${c.name}?`,
          facts: [...where(c, a.database), { label: 'Query', value: short(parts.join(';\n'), 1500) }, ...fact('Removes', reasons.join('; '))],
          page: { connId: c.id, db: String(a.database) },
          ...(heavy ? { typeName: c.name } : {}),
        };
      },
      async (a) => {
        const c = await target(a.connection);
        const results = await api.dvQuery(c.id, String(a.database), String(a.query));
        for (const r of results) logQuery(c.id, { text: r.statement, ms: r.ms, affected: r.affected, error: r.error });
        return done(resultsOut(results, 100, c.engine));
      },
    ),
    asked('save_query', 'Save a query', 'Keeps a query under a name for this database, in the Saved list of the Query tab; the same name replaces it.', { ...inDb, name: S('Its name.', 200), text: { type: 'string', minLength: 1, maxLength: 100000 } }, ['connection', 'database', 'name', 'text'], async (a) => {
      const c = await conn(a.connection);
      return { title: `Save the query ${String(a.name)}?`, facts: [...where(c, a.database), { label: 'Query', value: short(String(a.text)) }], page: null };
    }, async (a) => {
      const c = await conn(a.connection);
      const same = (await api.dvSavedQueries(c.id, String(a.database))).find((q) => q.name === a.name);
      await api.dvSaveQuery(c.id, String(a.database), { ...(same ? { id: same.id } : {}), name: String(a.name), text: String(a.text) });
      return done({ saved: a.name });
    }, true),
    asked('delete_saved_query', 'Delete a saved query', 'Takes a query out of the Saved list. Only that entry: nothing in the database changes.', { ...inDb, name: S('Its name (list_saved_queries).', 200) }, ['connection', 'database', 'name'], async (a) => {
      const c = await conn(a.connection);
      const q = (await api.dvSavedQueries(c.id, String(a.database))).find((x) => x.name === a.name);
      if (!q) throw new Error(`No saved query ${String(a.name)} (list_saved_queries shows them)`);
      return { title: `Delete the saved query ${q.name}?`, facts: [...where(c, a.database), { label: 'Query', value: short(q.text) }], page: null };
    }, async (a) => {
      const c = await conn(a.connection);
      const q = (await api.dvSavedQueries(c.id, String(a.database))).find((x) => x.name === a.name);
      if (!q) throw new Error(`No saved query ${String(a.name)}`);
      await api.dvDeleteQuery(c.id, String(a.database), q.id);
      return done({ deleted: a.name });
    }),

    // ---- structure
    asked('create_database', 'Create a database', 'Creates an empty database (list_charsets shows what the server offers).', { connection: CONNECTION, name: S('The new name.', 128), charset: S('Optional.', 64), collation: S('Optional.', 64) }, ['connection', 'name'], async (a) => {
      const c = await target(a.connection);
      return { title: `Create the database ${String(a.name)}?`, facts: [...where(c), ...fact('Charset', a.charset), ...fact('Collation', a.collation)], page: { connId: c.id } };
    }, async (a) => {
      const c = await target(a.connection);
      await api.dvCreateDatabase(c.id, String(a.name), a.charset || a.collation ? { charset: String(a.charset ?? ''), collation: String(a.collation ?? '') } : undefined);
      return done({ created: a.name });
    }),
    typed('drop_database', 'Drop a database', 'Removes a database and everything in it.', { connection: CONNECTION, name: S('The database.', 512) }, ['connection', 'name'], async (a) => {
      const c = await target(a.connection);
      if (!(await api.dvDatabases(c.id)).includes(String(a.name))) throw new Error(`No database ${String(a.name)} (list_databases shows them)`);
      return { title: `Drop the database ${String(a.name)}?`, facts: [...where(c), { label: 'Goes', value: 'every table and row in it' }], page: { connId: c.id }, typeName: String(a.name) };
    }, async (a) => {
      const c = await target(a.connection);
      await api.dvDropDatabase(c.id, String(a.name), String(a.name));
      return done({ dropped: a.name });
    }),
    asked('create_table', 'Create a table', 'Creates a table (list_column_types shows the types). MongoDB: a collection, whose columns are ignored; Elasticsearch: an index.', { ...inTable, columns: { type: 'array', minItems: 1, maxItems: 500, items: COLUMN } }, ['connection', 'database', 'table', 'columns'], async (a) => {
      const c = await target(a.connection);
      const cols = (a.columns as Record<string, unknown>[]).map(column);
      return { title: `Create the table ${String(a.table)}?`, facts: [...where(c, a.database), { label: 'Columns', value: short(cols.map((x) => `${x.name} ${x.type}${x.primary ? ' primary key' : ''}`).join(', ')) }], page: { connId: c.id, db: String(a.database) } };
    }, async (a) => {
      const c = await target(a.connection);
      await api.dvCreateTable(c.id, String(a.database), String(a.table), (a.columns as Record<string, unknown>[]).map(column));
      return done({ created: a.table });
    }),
    asked('alter_table', 'Change a table', "Adds, drops, renames or changes columns and indexes, or renames the table. check_alter says first what it would risk. What loses data needs a name typed, as in DBCatz's own Structure tab; what DBCatz blocks there is refused here too.", { ...inTable, ops: ALTER_OPS }, ['connection', 'database', 'table', 'ops'], async (a) => {
      const c = await target(a.connection);
      const ops = alterOps(a.ops);
      const risk: DvRisk = await api.dvAlterCheck(c.id, String(a.database), String(a.table), ops);
      const block = risk.items.find((i) => i.level === 'block');
      if (block) throw new Error(`${block.title}: ${block.detail}`);
      return {
        title: `Change the table ${String(a.table)}?`,
        facts: [...where(c, a.database), { label: 'Changes', value: short(ops.map(opText).join('; ')) }, ...fact('Risk', short(risk.items.map((i) => i.title).join('; ')))],
        page: { connId: c.id, db: String(a.database), table: String(a.table) },
        ...(risk.level === 'danger' ? { typeName: risk.confirmWord } : {}),
      };
    }, async (a) => {
      const c = await target(a.connection);
      const ops = alterOps(a.ops);
      const risk = await api.dvAlterCheck(c.id, String(a.database), String(a.table), ops);
      await api.dvAlterTable(c.id, String(a.database), String(a.table), ops, risk.level === 'danger' ? risk.confirmWord : undefined);
      return done({ changed: a.table });
    }),
    asked('duplicate_table', 'Duplicate a table', 'Makes a copy under a new name, with or without its rows.', { ...inTable, to: S('The new name.', 128), with_rows: { type: 'boolean', description: 'Copy the rows too; yes when left out.' } }, ['connection', 'database', 'table', 'to'], async (a) => {
      const c = await target(a.connection);
      return { title: `Copy ${String(a.table)} to ${String(a.to)}?`, facts: [...where(c, a.database), { label: 'Rows', value: a.with_rows === false ? 'Not copied' : 'Copied too' }], page: { connId: c.id, db: String(a.database), table: String(a.to) } };
    }, async (a) => {
      const c = await target(a.connection);
      await api.dvDuplicateTable(c.id, String(a.database), String(a.table), String(a.to), a.with_rows !== false);
      return done({ created: a.to });
    }),
    typed('drop_tables', 'Drop tables', 'Removes tables with their rows. Tables other tables point at are reported as failed.', { ...inDb, tables: { type: 'array', minItems: 1, maxItems: 500, items: TABLE } }, ['connection', 'database', 'tables'], async (a) => {
      const c = await target(a.connection);
      const t = a.tables as string[];
      return { title: `Drop ${t.length === 1 ? t[0] : `${t.length} tables`}?`, facts: [...where(c, a.database), { label: 'Tables', value: short(t.join(', ')) }, { label: 'Goes', value: 'their rows, for good' }], page: { connId: c.id, db: String(a.database) }, typeName: t.length === 1 && c.options.mode !== 'production' ? t[0] : bulkWord(c, String(a.database)) };
    }, async (a) => {
      const c = await target(a.connection);
      return done(await api.dvDropTables(c.id, String(a.database), a.tables as string[], bulkWord(c, String(a.database)), false));
    }),
    typed('truncate_tables', 'Empty tables', 'Removes every row of the tables; the tables stay. Tables other tables point at are reported as failed.', { ...inDb, tables: { type: 'array', minItems: 1, maxItems: 500, items: TABLE } }, ['connection', 'database', 'tables'], async (a) => {
      const c = await target(a.connection);
      const t = a.tables as string[];
      return { title: `Empty ${t.length === 1 ? t[0] : `${t.length} tables`}?`, facts: [...where(c, a.database), { label: 'Tables', value: short(t.join(', ')) }, { label: 'Goes', value: 'every row, for good' }], page: { connId: c.id, db: String(a.database) }, typeName: t.length === 1 && c.options.mode !== 'production' ? t[0] : bulkWord(c, String(a.database)) };
    }, async (a) => {
      const c = await target(a.connection);
      return done(await api.dvTruncateTables(c.id, String(a.database), a.tables as string[], bulkWord(c, String(a.database)), false));
    }),

    // ---- keys
    asked('set_key', 'Set a key', 'Redis / Valkey: creates a key or replaces its whole value, and sets its TTL.', { ...inDb, key: S('The key.'), type: { enum: ['string', 'list', 'set', 'hash', 'zset'], description: 'string when left out.' }, value: { description: 'string: text. list / set: an array of texts. hash: [field, value] pairs. zset: [member, score] pairs.', oneOf: [{ type: 'string' }, { type: 'array', maxItems: 10000, items: { oneOf: [{ type: 'string' }, { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } }] } }] }, ttl: { type: 'integer', minimum: -1, description: 'Seconds; left out or -1: no expiry.' } }, ['connection', 'database', 'key', 'value'], async (a) => {
      const c = await kv(a.connection);
      return { title: `Set the key ${String(a.key)}?`, facts: [...where(c, a.database), { label: 'Value', value: short(typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) }, ...fact('Expires', typeof a.ttl === 'number' && a.ttl >= 0 ? `in ${a.ttl} s` : null)], page: { connId: c.id, db: String(a.database), table: String(a.key) } };
    }, async (a) => {
      const c = await kv(a.connection);
      const input: DvKeyInput = { key: String(a.key), type: (a.type as DvKeyInput['type'] | undefined) ?? 'string', value: a.value as DvKeyInput['value'], ttl: typeof a.ttl === 'number' ? a.ttl : null };
      await api.dvKeySet(c.id, String(a.database), input);
      return done({ set: a.key });
    }),
    asked('rename_key', 'Rename a key', 'Redis / Valkey.', { ...inDb, from: S('The key.'), to: S('Its new name.') }, ['connection', 'database', 'from', 'to'], async (a) => {
      const c = await kv(a.connection);
      return { title: `Rename ${String(a.from)} to ${String(a.to)}?`, facts: where(c, a.database), page: { connId: c.id, db: String(a.database), table: String(a.to) } };
    }, async (a) => {
      const c = await kv(a.connection);
      await api.dvKeyRename(c.id, String(a.database), String(a.from), String(a.to));
      return done({ renamed: a.to });
    }),
    typed('delete_keys', 'Delete keys', 'Redis / Valkey: removes keys and their values.', { ...inDb, keys: { type: 'array', minItems: 1, maxItems: 1000, items: S('A key.') } }, ['connection', 'database', 'keys'], async (a) => {
      const c = await kv(a.connection);
      const k = a.keys as string[];
      return { title: `Delete ${k.length === 1 ? k[0] : `${k.length} keys`}?`, facts: [...where(c, a.database), { label: 'Keys', value: short(k.join(', ')) }], page: { connId: c.id, db: String(a.database) }, typeName: k.length === 1 ? k[0] : String(a.database) };
    }, async (a) => {
      const c = await kv(a.connection);
      return done({ deleted: await api.dvKeyDelete(c.id, String(a.database), a.keys as string[]) });
    }),
    typed('flush_keys', 'Flush a database', 'Redis / Valkey: removes every key in one database.', inDb, ['connection', 'database'], async (a) => {
      const c = await kv(a.connection);
      return { title: `Flush ${String(a.database)}?`, facts: [...where(c, a.database), { label: 'Goes', value: 'every key in it' }], page: { connId: c.id, db: String(a.database) }, typeName: String(a.database) };
    }, async (a) => {
      const c = await kv(a.connection);
      await api.dvFlush(c.id, String(a.database), String(a.database));
      return done({ flushed: a.database });
    }),

    // ---- files: DBCatz asks where, in the window, so no path ever comes from or goes to a client
    asked('export_data', 'Export', 'Writes tables to a file: the user picks where in DBCatz. Answers once it has started: list_jobs shows how far it is.', { ...inDb, tables: { type: 'array', minItems: 1, maxItems: 5000, items: TABLE, description: 'Left out: every table.' }, format: { enum: ['sql', 'csv', 'json', 'xml', 'dot', 'redis'] }, structure: { type: 'boolean' }, data: { type: 'boolean' }, drop_first: { type: 'boolean' } }, ['connection', 'database', 'format'], async (a) => {
      const c = await conn(a.connection);
      return { title: `Export from ${String(a.database)}?`, facts: [...where(c, a.database), { label: 'Tables', value: a.tables ? short((a.tables as string[]).join(', ')) : 'All' }, { label: 'Format', value: String(a.format) }, { label: 'Next', value: 'DBCatz asks you where to save it' }], page: { connId: c.id, db: String(a.database) } };
    }, async (a) => {
      const c = await conn(a.connection);
      const tables = (a.tables as string[] | undefined) ?? (await api.dvTables(c.id, String(a.database))).map((t) => t.name);
      const path = await api.dvExport(c.id, { database: String(a.database), tables, format: a.format as DvExportFormat, structure: a.structure !== false, data: a.data !== false, dropFirst: a.drop_first === true });
      return done(path ? { started: true, next: 'list_jobs shows how far it is; tell the user how it ends' } : { started: false, why: 'The user closed the save dialog' });
    }),
    asked('backup', 'Back up', 'Writes whole databases to a backup file: the user picks where in DBCatz. Answers once it has started: list_jobs shows how far it is.', { connection: CONNECTION, databases: { type: 'array', minItems: 1, maxItems: 500, items: DATABASE } }, ['connection', 'databases'], async (a) => {
      const c = await conn(a.connection);
      return { title: `Back up ${(a.databases as string[]).length === 1 ? (a.databases as string[])[0] : `${(a.databases as string[]).length} databases`}?`, facts: [...where(c), { label: 'Databases', value: short((a.databases as string[]).join(', ')) }, { label: 'Next', value: 'DBCatz asks you where to save it' }], page: { connId: c.id } };
    }, async (a) => {
      const c = await conn(a.connection);
      const path = await api.dvBackup(c.id, a.databases as string[]);
      return done(path ? { started: true, next: 'list_jobs shows how far it is; tell the user how it ends' } : { started: false, why: 'The user closed the save dialog' });
    }),
    asked('import_file', 'Import a file', 'Runs a file into a database: the user picks the file in DBCatz. Answers once it has started: list_jobs shows how far it is.', { ...inDb, format: { enum: ['sql', 'csv', 'json', 'redis'] }, table: S('csv / json: the table, collection or index it goes into.'), header: { type: 'boolean', description: 'csv: the first row names the columns.' } }, ['connection', 'database', 'format'], async (a) => {
      const c = await target(a.connection);
      if ((a.format === 'csv' || a.format === 'json') && !a.table) throw new Error(`A ${String(a.format)} import needs table`);
      return { title: `Import into ${String(a.database)}?`, facts: [...where(c, a.database), { label: 'Format', value: String(a.format) }, ...fact('Into', a.table), { label: 'Next', value: 'DBCatz asks you for the file; what it holds then runs without asking again' }], page: { connId: c.id, db: String(a.database) }, ...(c.options.mode === 'production' ? { typeName: c.name } : {}) };
    }, async (a) => {
      const c = await target(a.connection);
      const path = await api.dvImport(c.id, { database: String(a.database), format: a.format as 'sql', table: String(a.table ?? ''), header: a.header !== false });
      return done(path ? { started: true, next: 'list_jobs shows how far it is; tell the user how it ends' } : { started: false, why: 'The user closed the file dialog' });
    }),
    {
      name: 'cancel_job',
      title: 'Cancel a job',
      description: 'Stops a running export, import or backup (list_jobs shows them). Runs at once: it only stops work. What an import already wrote stays.',
      tier: 'change',
      noDialog: true,
      input: OBJECT({ id: S('The job id from list_jobs.', 100) }, ['id']),
      preview: async () => ({ title: 'Cancel a job', facts: [], page: null }),
      run: async (a) => {
        const job = (await api.dvJobs()).find((j) => j.id === a.id);
        const shared = job && scopes.connection(findConnection(await api.dvConnections(), job.connId));
        if (!job || !shared) throw new Error(`No job ${String(a.id)} (list_jobs shows them)`);
        await api.dvCancelJob(job.id);
        return done({ cancelled: job.id });
      },
    },
    asked('clear_finished_jobs', 'Clear finished jobs', 'Takes finished jobs on the shared connections off the Jobs list. Their files stay.', {}, [], async () => {
      return { title: 'Clear finished jobs from the list?', facts: [{ label: 'Stays', value: 'the files they wrote' }], page: null };
    }, async () => {
      const [jobs, all] = await Promise.all([api.dvJobs(), api.dvConnections()]);
      const shared = new Set(all.filter((c) => scopes.connection(c)).map((c) => c.id));
      await api.dvClearJobs(jobs.filter((j) => j.finished && shared.has(j.connId)).map((j) => j.id));
      return done({ cleared: true });
    }, true),

    // ---- the list and the window
    asked('add_connection', 'Add a connection', 'Saves a plain connection, shared with you from then on, in Normal mode and without a password: the user adds that in DBCatz, on the connection. SSH, AWS and Vault are set up there too.', { name: S('Its name.', 120), engine: { enum: ['mysql', 'mariadb', 'postgresql', 'redis', 'valkey', 'mongodb', 'elasticsearch', 'sqlite'] }, host: S('Host name.', 255), port: { type: 'integer', minimum: 1, maximum: 65535 }, user: S('User name.', 128), database: S('The database to open first.', 255), file: S('SQLite: the database file or a folder of them.', 1024) }, ['name', 'engine'], async (a) => {
      return { title: `Add the connection ${String(a.name)}?`, facts: [{ label: 'Engine', value: String(a.engine) }, ...fact('Host', a.host), ...fact('Port', a.port), ...fact('User', a.user), ...fact('File', a.file), { label: 'Password', value: 'None: add it on the connection if it needs one' }], page: { connId: null } };
    }, async (a) => {
      const c = await api.dvSaveConnection({ name: String(a.name), engine: a.engine as DvConnection['engine'], host: String(a.host ?? '127.0.0.1'), port: Number(a.port ?? 0), user: String(a.user ?? ''), password: '', database: String(a.database ?? ''), file: String(a.file ?? ''), color: null, method: 'tcp', socket: '' });
      shareConnection(c.id);
      return done({ added: c.id, name: c.name, password: 'not set: the user adds it in DBCatz if the server needs one' });
    }),
    typed('delete_connection', 'Delete a saved connection', 'Removes a saved connection and the password DBCatz keeps for it, which cannot be read back. Nothing on the server changes. Services from DevCatz and DoCatz are removed there.', { connection: CONNECTION }, ['connection'], async (a) => {
      const c = await conn(a.connection);
      if (c.serviceId) throw new Error(`${c.name} comes from ${c.serviceApp}: it is removed there`);
      return { title: `Delete the connection ${c.name}?`, facts: [{ label: 'Goes', value: `its settings and stored secrets${c.hasPassword ? ', including the password' : ''}` }, { label: 'Stays', value: 'everything on the server' }], page: { connId: null }, typeName: c.name };
    }, async (a) => {
      const c = await conn(a.connection);
      await api.dvDeleteConnection(c.id);
      return done({ deleted: c.name });
    }),
    asked('disconnect', 'Disconnect', "Closes DBCatz's open connection to the server. Its tab shows Reconnect.", { connection: CONNECTION }, ['connection'], async (a) => {
      const c = await conn(a.connection);
      return { title: `Disconnect ${c.name}?`, facts: [{ label: 'Stays', value: 'the connection, in the list' }], page: null };
    }, async (a) => {
      await api.dvDisconnect((await conn(a.connection)).id);
      return done({ disconnected: true });
    }, true),
    asked('set_favorite', 'Set a favorite', 'Puts a connection in Favorites or takes it out.', { connection: CONNECTION, favorite: { type: 'boolean' } }, ['connection', 'favorite'], async (a) => {
      const c = await conn(a.connection);
      return { title: `${a.favorite ? 'Add' : 'Remove'} ${c.name} ${a.favorite ? 'to' : 'from'} Favorites?`, facts: [], page: null };
    }, async (a) => {
      const c = await conn(a.connection);
      const l = await api.dvLayout();
      const rest = l.favorites.filter((x) => x !== c.id);
      await api.dvSetLayout({ ...l, favorites: a.favorite ? [...rest, c.id] : rest });
      return done({ favorite: a.favorite });
    }, true),
    asked('set_group', 'Set a group', "Moves a connection to one of the user's groups, making it if needed; left out, it leaves its group.", { connection: CONNECTION, group: S('The group.', 60) }, ['connection'], async (a) => {
      const c = await conn(a.connection);
      return { title: a.group ? `Move ${c.name} to ${String(a.group)}?` : `Take ${c.name} out of its group?`, facts: [], page: null };
    }, async (a) => {
      const c = await conn(a.connection);
      const l = await api.dvLayout();
      const groups = l.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== c.id) }));
      if (a.group) {
        const g = groups.find((x) => x.name === a.group);
        if (g) g.members.push(c.id);
        else groups.push({ name: String(a.group), members: [c.id], collapsed: false });
      }
      await api.dvSetLayout({ ...l, groups });
      return done({ group: a.group ?? null });
    }, true),
    asked('star_database', 'Star a database', 'Stars a database in the picker, or takes the star off.', { ...inDb, starred: { type: 'boolean' } }, ['connection', 'database', 'starred'], async (a) => {
      const c = await conn(a.connection);
      return { title: `${a.starred ? 'Star' : 'Unstar'} ${String(a.database)}?`, facts: where(c), page: null };
    }, async (a) => {
      const c = await conn(a.connection);
      const p = await api.dvDbPrefs(c.id);
      const rest = p.favorites.filter((x) => x !== a.database);
      await api.dvSetDbPrefs(c.id, { ...p, favorites: a.starred ? [...rest, String(a.database)] : rest });
      return done({ starred: a.starred });
    }, true),
    asked('open_in_window', 'Show in DBCatz', "Shows a connection, a database or a table's rows in the user's window. Changes nothing but what they see.", { connection: CONNECTION, database: DATABASE, table: TABLE }, ['connection'], async (a) => {
      const c = await conn(a.connection);
      return { title: `Show ${String(a.table ?? a.database ?? c.name)} in DBCatz?`, facts: where(c, a.database), page: { connId: c.id, ...(a.database ? { db: String(a.database) } : {}), ...(a.table ? { table: String(a.table) } : {}) } };
    }, async () => done({ shown: true })),
    asked('open_in_service_app', 'Open in DevCatz or DoCatz', 'Opens the app that runs a service, at that service: where a stopped one can be started.', { connection: CONNECTION }, ['connection'], async (a) => {
      const c = await conn(a.connection);
      if (!c.serviceId) throw new Error(`${c.name} is saved in DBCatz: no other app runs it`);
      return { title: `Open ${c.name} in ${c.serviceApp}?`, facts: fact('Status', c.running ? 'Running' : 'Stopped'), page: null };
    }, async (a) => {
      const c = await conn(a.connection);
      const found = c.serviceApp === 'DoCatz' ? await api.openInDoCatz(c.serviceId!) : await api.openInDevCatz(c.serviceId!);
      if (!found) throw new Error(`${c.serviceApp} is not installed: the user can get it from the Connections tab`);
      return done({ opened: c.serviceApp });
    }, true),
  ];

  /** One row at a time, found by its whole primary key: a partial key could match many. */
  async function wholeKey(id: string, a: Record<string, unknown>): Promise<void> {
    const pk = (await api.dvStructure(id, String(a.database), String(a.table))).primaryKey;
    if (!pk.length) throw new Error(`${String(a.table)} has no primary key: use run_write_query, which shows the user the statement`);
    const have = Object.keys(a.key as object).sort();
    if (have.join('\0') !== [...pk].sort().join('\0')) throw new Error(`The key must be the primary key: ${pk.join(', ')} (describe_table shows it)`);
  }
}

