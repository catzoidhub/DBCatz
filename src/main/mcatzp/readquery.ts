import { statementKind, stripSql } from '@shared/dbsafety';
import { splitQuery } from '@shared/sqlsplit';
import type { DbEngine } from '@shared/types';

/**
 * What MCatzP's read tier may run without asking. Stricter than the Read-only mode's check, which the user's own typing
 * goes through: here the text comes from an AI, with no dialog in front of it. MySQL, MariaDB and PostgreSQL also run it
 * on a read-only session (manager.reader); this list stops what that session lets through, or could be talked out of.
 */
const SQL_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'WITH', 'PRAGMA']);
/** A write hidden in a read (PostgreSQL: WITH d AS (DELETE …) SELECT). */
const SQL_WRITE = /\b(INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|UPDATE\s+\S+\s+SET|TRUNCATE\s|DROP\s|ALTER\s|CREATE\s)/i;
/** Functions a SELECT can call with effects: settings, other sessions, files, sequences, locks, waiting. */
const SQL_EFFECT = /\b(set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_sleep\w*|lo_\w+|dblink\w*|nextval|setval|load_file|sleep|benchmark|get_lock|load_extension|writefile|readfile)\s*\(/i;
const PRAGMA_READ = /^PRAGMA\s+(\w+\.)?(table_info|table_xinfo|index_list|index_info|index_xinfo|foreign_key_list|table_list|database_list|collation_list|function_list)\b/i;
/** Listed as reads for the user's own console, but no use here: other clients' details, the session's database, a wait. */
const REDIS_NO = new Set(['CLIENT', 'SELECT', 'XREAD', 'MEMORY', 'SLOWLOG', 'COMMAND', 'ROLE']);

const no = (statement: string, why: string) => new Error(`run_read_query only reads: "${statement.replace(/\s+/g, ' ').slice(0, 80)}" ${why}`);

function checkSql(engine: DbEngine, p: string): void {
  // MySQL runs what is in these comments; stripSql would hide it.
  if (/\/\*M?!/.test(p)) throw no(p, 'has an executable comment');
  // PostgreSQL ends a string at \' where stripSql reads on, and could hide a call that way.
  if (engine === 'postgresql' && /\\'/.test(p)) throw no(p, "has \\' in it: write '' instead");
  const verb = /^\(?\s*(\w+)/.exec(stripSql(p))?.[1]?.toUpperCase() ?? '';
  if (!SQL_VERBS.has(verb)) throw no(p, 'is not a SELECT, SHOW, EXPLAIN or DESCRIBE');
  if (verb === 'PRAGMA' && !PRAGMA_READ.test(p.trim())) throw no(p, 'is not a PRAGMA that only reads');
  if (verb === 'SHOW' || verb === 'DESCRIBE' || verb === 'DESC' || verb === 'PRAGMA') return;
  // Without stripSql's # rule: # is a comment in MySQL but an operator in PostgreSQL, and what follows it still runs there.
  const code = p
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '``');
  if (SQL_WRITE.test(code)) throw no(p, 'has a write inside it');
  const call = SQL_EFFECT.exec(code);
  if (call) throw no(p, `calls ${call[1]}, which does more than read`);
}

/** Throws, naming the statement and why, unless every statement in the text only reads. */
export function assertReadQuery(engine: DbEngine, text: string): void {
  const parts = splitQuery(engine, text).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('The query is empty');
  for (const p of parts) {
    if (!statementKind(engine, p).read) throw no(p, 'would change data or structure');
    if (engine === 'mysql' || engine === 'mariadb' || engine === 'postgresql' || engine === 'sqlite') checkSql(engine, p);
    else if (engine === 'redis' || engine === 'valkey') {
      const cmd = (p.split(/\s+/)[0] ?? '').toUpperCase();
      if (REDIS_NO.has(cmd)) throw no(p, 'is not offered here');
    } else if (engine === 'mongodb' && /\$(function|accumulator|where)\b/.test(p)) throw no(p, 'runs JavaScript on the server');
  }
}
