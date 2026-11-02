import type { DbEngine } from '@shared/types';

/**
 * SQL autocomplete for the query editor: keywords at the start of a statement
 * (`sel` → SELECT, `ins` → INSERT INTO …), table names after FROM / JOIN /
 * UPDATE / INTO, and column names of the tables the statement uses (also
 * `alias.col` / `table.col`). Pure: the editor passes the text and cursor,
 * the query tab passes the tables and the columns it knows.
 */

export type SuggestKind = 'keyword' | 'table' | 'column' | 'function' | 'key' | 'option';
export interface Suggestion {
  label: string;
  /** Text put in place of the word being typed. */
  insert: string;
  kind: SuggestKind;
  /** Shown on the right: a column's table and type, a table's kind. */
  detail?: string;
}
export interface Completion {
  /** The word being replaced: [from, to) in the text. */
  from: number;
  to: number;
  items: Suggestion[];
}
export interface CompleteContext {
  engine: DbEngine;
  tables: string[];
  /** Columns of a table when known; undefined starts loading them (`need`). */
  columns: (table: string) => { name: string; type: string }[] | undefined;
  need: (table: string) => void;
}

/** Statements a line starts with. */
const STARTERS = ['SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'WITH', 'CREATE TABLE', 'CREATE INDEX', 'CREATE VIEW', 'CREATE DATABASE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'SHOW TABLES', 'SHOW DATABASES', 'SHOW COLUMNS FROM', 'SHOW CREATE TABLE', 'DESCRIBE', 'EXPLAIN', 'USE', 'BEGIN', 'COMMIT', 'ROLLBACK'];
/** Keywords inside a statement. */
const CLAUSES = [
  'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'CROSS JOIN', 'ON', 'USING', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'ASC', 'DESC', 'UNION', 'UNION ALL', 'VALUES', 'SET',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'TRUE', 'FALSE', 'DEFAULT', 'INTO',
];
const PG_ONLY = ['ILIKE', 'RETURNING', 'ON CONFLICT', 'DO NOTHING'];
const MYSQL_ONLY = ['ON DUPLICATE KEY UPDATE', 'REGEXP'];
const FUNCTIONS = ['COUNT(*)', 'COUNT()', 'SUM()', 'AVG()', 'MIN()', 'MAX()', 'COALESCE()', 'NOW()', 'LOWER()', 'UPPER()', 'LENGTH()', 'CONCAT()', 'ROUND()', 'CAST()', 'DATE()'];

/** Keywords after which a table name comes. */
const TABLE_AFTER = /^(FROM|JOIN|INTO|UPDATE|TABLE|DESCRIBE|DESC|EXPLAIN|TRUNCATE|EXISTS)$/i;
/** Keywords after which a column (or an expression) comes. */
const COLUMN_AFTER = /^(SELECT|WHERE|AND|OR|ON|SET|BY|HAVING|DISTINCT|NOT|WHEN|THEN|ELSE|CASE|USING|RETURNING)$/i;

/** Blank out strings and comments (same length), so keywords inside them are not read. */
function maskLiterals(s: string): string {
  return s.replace(/'(?:[^'\\]|\\.|'')*'?|"(?:[^"\\]|\\.)*"?|`[^`]*`?|--[^\n]*|#[^\n]*|\/\*[\s\S]*?(\*\/|$)/g, (m) => ' '.repeat(m.length));
}

/** The statement around the cursor: from the previous ';' to the next one. */
function statementAt(text: string, cursor: number): { start: number; body: string } {
  const masked = maskLiterals(text);
  const start = masked.lastIndexOf(';', cursor - 1) + 1;
  const endAt = masked.indexOf(';', cursor);
  const end = endAt === -1 ? text.length : endAt;
  return { start, body: masked.slice(start, end) };
}

/** Tables the statement names (FROM / JOIN / UPDATE / INTO …) with their aliases. */
function tablesOf(stmt: string, known: Set<string>): { table: string; alias: string | null }[] {
  const out: { table: string; alias: string | null }[] = [];
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([`"[]?[\w$.]+[`"\]]?)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
  for (const m of stmt.matchAll(re)) {
    const table = m[1].replace(/^[`"[]|[`"\]]$/g, '');
    const alias = m[2] && !/^(WHERE|ON|SET|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|GROUP|ORDER|LIMIT|VALUES|USING|HAVING|UNION|AS|SELECT|NATURAL|FULL)$/i.test(m[2]) ? m[2] : null;
    if (known.has(table) || [...known].some((k) => k.toLowerCase() === table.toLowerCase())) out.push({ table: [...known].find((k) => k.toLowerCase() === table.toLowerCase()) ?? table, alias });
  }
  // FROM a, b
  for (const m of stmt.matchAll(/\bFROM\s+([\w$.]+(?:\s*,\s*[\w$.]+)+)/gi))
    for (const t of m[1].split(',').map((x) => x.trim())) if (known.has(t) && !out.some((o) => o.table === t)) out.push({ table: t, alias: null });
  return out;
}

const score = (label: string, word: string) => {
  const l = label.toLowerCase();
  const w = word.toLowerCase();
  if (!w) return 1;
  if (l === w) return 0; // an exact match is not worth suggesting
  if (l.startsWith(w)) return 3;
  if (l.split(/[_\s.]/).some((part) => part.startsWith(w))) return 2;
  return l.includes(w) ? 1 : 0;
};

/** Keyword text in the case the user is typing in (sel → select, SEL → SELECT). */
const inCase = (kw: string, typed: string) => (typed && typed === typed.toLowerCase() && /[a-z]/.test(typed) ? kw.toLowerCase() : kw);

/**
 * Suggestions at `cursor`. `explicit` (Ctrl+Space) also suggests with nothing typed yet.
 */
export function sqlComplete(text: string, cursor: number, ctx: CompleteContext, explicit = false): Completion | null {
  const before = text.slice(0, cursor);
  // Inside a string or comment: nothing.
  const maskedBefore = maskLiterals(before);
  if (maskedBefore.length && maskedBefore[maskedBefore.length - 1] === ' ' && before[before.length - 1] !== ' ' && before[before.length - 1] !== '\n') return null;
  const qualified = /([A-Za-z_][\w$]*)\.([\w$]*)$/.exec(before);
  const word = qualified ? qualified[2] : (/[\w$]*$/.exec(before)?.[0] ?? '');
  const from = cursor - word.length;
  const after = /^[\w$]*/.exec(text.slice(cursor))?.[0] ?? '';
  const to = cursor + after.length;
  if (!word && !qualified && !explicit) return null;

  const known = new Set(ctx.tables);
  const { start, body } = statementAt(text, cursor);
  const stmtBefore = maskLiterals(text.slice(start, from));
  const prevTokens = stmtBefore.match(/[A-Za-z_][\w$]*|[(),*=<>]/g) ?? [];
  const prev = prevTokens[prevTokens.length - 1] ?? '';
  const prev2 = prevTokens[prevTokens.length - 2] ?? '';
  const used = tablesOf(body, known);
  const items: (Suggestion & { s: number })[] = [];
  const add = (sug: Suggestion) => {
    const s = score(sug.label, word);
    // Keywords and functions only by their start (or a word in them); names may match anywhere.
    if ((sug.kind === 'keyword' || sug.kind === 'function') && s < 2 && word) return;
    if (s > 0 && !items.some((i) => i.label === sug.label && i.kind === sug.kind)) items.push({ ...sug, s });
  };
  const columnsOf = (table: string) => {
    const cols = ctx.columns(table);
    if (!cols) ctx.need(table);
    return cols ?? [];
  };

  // table.col / alias.col
  if (qualified) {
    const q = qualified[1];
    const target = used.find((u) => u.alias?.toLowerCase() === q.toLowerCase())?.table ?? ctx.tables.find((t) => t.toLowerCase() === q.toLowerCase()) ?? null;
    if (!target) return null;
    for (const c of columnsOf(target)) add({ label: c.name, insert: c.name, kind: 'column', detail: c.type });
    return finish();
  }

  const atStart = prevTokens.length === 0;
  if (atStart) {
    for (const k of STARTERS) add({ label: k, insert: `${inCase(k, word)} `, kind: 'keyword' });
    return finish();
  }

  const engineExtra = ctx.engine === 'postgresql' ? PG_ONLY : ctx.engine === 'mysql' || ctx.engine === 'mariadb' ? MYSQL_ONLY : [];
  const tableSlot = TABLE_AFTER.test(prev) || (prev === ',' && /\bFROM\b[^;]*$/i.test(stmtBefore) && !/\b(WHERE|GROUP|ORDER|HAVING|LIMIT|SET|ON)\b[^;]*$/i.test(stmtBefore.slice(stmtBefore.search(/\bFROM\b[^;]*$/i))));
  if (tableSlot) {
    for (const t of ctx.tables) add({ label: t, insert: t, kind: 'table', detail: 'table' });
    if (/^FROM$/i.test(prev)) add({ label: '(SELECT …)', insert: '(SELECT ', kind: 'keyword' });
    return finish();
  }

  // After a table name in FROM / JOIN: an alias, or the next clause.
  const afterTable = known.has(prev) && TABLE_AFTER.test(prev2);
  const columnSlot = COLUMN_AFTER.test(prev) || ['(', ',', '=', '<', '>', '*'].includes(prev) || /^(LIKE|IN|IS|BETWEEN)$/i.test(prev);
  if (columnSlot && !afterTable) {
    for (const u of used) for (const c of columnsOf(u.table)) add({ label: c.name, insert: c.name, kind: 'column', detail: used.length > 1 ? `${u.alias ?? u.table} · ${c.type}` : c.type });
    if (/^(SELECT|WHERE|AND|OR|HAVING|SET|BY|ON|THEN|ELSE|WHEN|DISTINCT|,|\()$/i.test(prev)) for (const f of FUNCTIONS) add({ label: f, insert: inCase(f, word), kind: 'function' });
    if (/^(SELECT|,)$/i.test(prev) && !used.length) for (const t of ctx.tables) add({ label: t, insert: t, kind: 'table', detail: 'table' });
  }
  for (const k of [...CLAUSES, ...engineExtra]) add({ label: k, insert: `${inCase(k, word)} `, kind: 'keyword' });
  return finish();

  function finish(): Completion | null {
    const order: Record<SuggestKind, number> = { column: 0, table: 1, function: 2, keyword: 3, key: 4, option: 5 };
    items.sort((a, b) => b.s - a.s || order[a.kind] - order[b.kind] || a.label.length - b.label.length || a.label.localeCompare(b.label));
    const list = items.slice(0, 40).map(({ s: _s, ...rest }) => rest);
    return list.length ? { from, to, items: list } : null;
  }
}

// ---------------------------------------------------------------- Redis / Valkey

export interface RedisContext {
  /** Keys starting with a prefix when known (from a SCAN); undefined starts loading them. */
  keys: (prefix: string) => { key: string; type: string }[] | undefined;
}

/**
 * Commands with their arguments: `k` = the argument positions that are keys
 * ('all' = every argument, as in DEL / MGET), `opts` = flags the command
 * takes, `args` = the syntax shown beside it, `group` = what it works on.
 */
interface RedisCommand {
  args: string;
  group: string;
  k?: number[] | 'all' | 'odd';
  opts?: string[];
}
const R = (args: string, group: string, k?: RedisCommand['k'], opts?: string[]): RedisCommand => ({ args, group, k, opts });
const REDIS: Record<string, RedisCommand> = {
  // strings
  GET: R('key', 'string', [1]),
  SET: R('key value [EX s | PX ms] [NX | XX] [GET]', 'string', [1], ['EX', 'PX', 'EXAT', 'PXAT', 'NX', 'XX', 'KEEPTTL', 'GET']),
  SETNX: R('key value', 'string', [1]),
  SETEX: R('key seconds value', 'string', [1]),
  GETSET: R('key value', 'string', [1]),
  GETDEL: R('key', 'string', [1]),
  GETEX: R('key [EX s | PX ms | PERSIST]', 'string', [1], ['EX', 'PX', 'EXAT', 'PXAT', 'PERSIST']),
  MGET: R('key [key …]', 'string', 'all'),
  MSET: R('key value [key value …]', 'string', 'odd'),
  APPEND: R('key value', 'string', [1]),
  STRLEN: R('key', 'string', [1]),
  INCR: R('key', 'string', [1]),
  INCRBY: R('key increment', 'string', [1]),
  INCRBYFLOAT: R('key increment', 'string', [1]),
  DECR: R('key', 'string', [1]),
  DECRBY: R('key decrement', 'string', [1]),
  GETRANGE: R('key start end', 'string', [1]),
  SETRANGE: R('key offset value', 'string', [1]),
  // keys
  DEL: R('key [key …]', 'keys', 'all'),
  UNLINK: R('key [key …]', 'keys', 'all'),
  EXISTS: R('key [key …]', 'keys', 'all'),
  TOUCH: R('key [key …]', 'keys', 'all'),
  TYPE: R('key', 'keys', [1]),
  TTL: R('key', 'keys', [1]),
  PTTL: R('key', 'keys', [1]),
  EXPIRE: R('key seconds [NX | XX | GT | LT]', 'keys', [1], ['NX', 'XX', 'GT', 'LT']),
  PEXPIRE: R('key ms [NX | XX | GT | LT]', 'keys', [1], ['NX', 'XX', 'GT', 'LT']),
  EXPIREAT: R('key unix-time [NX | XX | GT | LT]', 'keys', [1], ['NX', 'XX', 'GT', 'LT']),
  EXPIRETIME: R('key', 'keys', [1]),
  PERSIST: R('key', 'keys', [1]),
  RENAME: R('key newkey', 'keys', [1, 2]),
  RENAMENX: R('key newkey', 'keys', [1, 2]),
  COPY: R('source destination [DB n] [REPLACE]', 'keys', [1, 2], ['DB', 'REPLACE']),
  DUMP: R('key', 'keys', [1]),
  OBJECT: R('ENCODING | FREQ | IDLETIME | REFCOUNT key', 'keys', [2], ['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT', 'HELP']),
  MEMORY: R('USAGE key [SAMPLES n] | STATS | DOCTOR', 'server', [2], ['USAGE', 'STATS', 'DOCTOR', 'SAMPLES']),
  KEYS: R('pattern', 'keys'),
  SCAN: R('cursor [MATCH pattern] [COUNT n] [TYPE type]', 'keys', undefined, ['MATCH', 'COUNT', 'TYPE']),
  RANDOMKEY: R('', 'keys'),
  // hashes
  HGET: R('key field', 'hash', [1]),
  HSET: R('key field value [field value …]', 'hash', [1]),
  HSETNX: R('key field value', 'hash', [1]),
  HMGET: R('key field [field …]', 'hash', [1]),
  HMSET: R('key field value [field value …]', 'hash', [1]),
  HGETALL: R('key', 'hash', [1]),
  HDEL: R('key field [field …]', 'hash', [1]),
  HEXISTS: R('key field', 'hash', [1]),
  HKEYS: R('key', 'hash', [1]),
  HVALS: R('key', 'hash', [1]),
  HLEN: R('key', 'hash', [1]),
  HINCRBY: R('key field increment', 'hash', [1]),
  HINCRBYFLOAT: R('key field increment', 'hash', [1]),
  HSCAN: R('key cursor [MATCH pattern] [COUNT n]', 'hash', [1], ['MATCH', 'COUNT', 'NOVALUES']),
  HSTRLEN: R('key field', 'hash', [1]),
  HRANDFIELD: R('key [count [WITHVALUES]]', 'hash', [1], ['WITHVALUES']),
  // lists
  LPUSH: R('key element [element …]', 'list', [1]),
  RPUSH: R('key element [element …]', 'list', [1]),
  LPOP: R('key [count]', 'list', [1]),
  RPOP: R('key [count]', 'list', [1]),
  LRANGE: R('key start stop', 'list', [1]),
  LLEN: R('key', 'list', [1]),
  LINDEX: R('key index', 'list', [1]),
  LSET: R('key index element', 'list', [1]),
  LREM: R('key count element', 'list', [1]),
  LTRIM: R('key start stop', 'list', [1]),
  LINSERT: R('key BEFORE | AFTER pivot element', 'list', [1], ['BEFORE', 'AFTER']),
  LPOS: R('key element [RANK r] [COUNT n] [MAXLEN n]', 'list', [1], ['RANK', 'COUNT', 'MAXLEN']),
  LMOVE: R('source destination LEFT | RIGHT LEFT | RIGHT', 'list', [1, 2], ['LEFT', 'RIGHT']),
  BLPOP: R('key [key …] timeout', 'list', 'all'),
  BRPOP: R('key [key …] timeout', 'list', 'all'),
  // sets
  SADD: R('key member [member …]', 'set', [1]),
  SREM: R('key member [member …]', 'set', [1]),
  SMEMBERS: R('key', 'set', [1]),
  SISMEMBER: R('key member', 'set', [1]),
  SMISMEMBER: R('key member [member …]', 'set', [1]),
  SCARD: R('key', 'set', [1]),
  SPOP: R('key [count]', 'set', [1]),
  SRANDMEMBER: R('key [count]', 'set', [1]),
  SINTER: R('key [key …]', 'set', 'all'),
  SUNION: R('key [key …]', 'set', 'all'),
  SDIFF: R('key [key …]', 'set', 'all'),
  SMOVE: R('source destination member', 'set', [1, 2]),
  SSCAN: R('key cursor [MATCH pattern] [COUNT n]', 'set', [1], ['MATCH', 'COUNT']),
  // sorted sets
  ZADD: R('key [NX | XX] [GT | LT] [CH] [INCR] score member …', 'zset', [1], ['NX', 'XX', 'GT', 'LT', 'CH', 'INCR']),
  ZREM: R('key member [member …]', 'zset', [1]),
  ZRANGE: R('key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]', 'zset', [1], ['BYSCORE', 'BYLEX', 'REV', 'LIMIT', 'WITHSCORES']),
  ZREVRANGE: R('key start stop [WITHSCORES]', 'zset', [1], ['WITHSCORES']),
  ZRANGEBYSCORE: R('key min max [WITHSCORES] [LIMIT offset count]', 'zset', [1], ['WITHSCORES', 'LIMIT']),
  ZSCORE: R('key member', 'zset', [1]),
  ZMSCORE: R('key member [member …]', 'zset', [1]),
  ZRANK: R('key member [WITHSCORE]', 'zset', [1], ['WITHSCORE']),
  ZREVRANK: R('key member [WITHSCORE]', 'zset', [1], ['WITHSCORE']),
  ZCARD: R('key', 'zset', [1]),
  ZCOUNT: R('key min max', 'zset', [1]),
  ZINCRBY: R('key increment member', 'zset', [1]),
  ZPOPMIN: R('key [count]', 'zset', [1]),
  ZPOPMAX: R('key [count]', 'zset', [1]),
  ZREMRANGEBYSCORE: R('key min max', 'zset', [1]),
  ZREMRANGEBYRANK: R('key start stop', 'zset', [1]),
  ZSCAN: R('key cursor [MATCH pattern] [COUNT n]', 'zset', [1], ['MATCH', 'COUNT']),
  // streams
  XADD: R('key [NOMKSTREAM] [MAXLEN ~ n] * | id field value …', 'stream', [1], ['NOMKSTREAM', 'MAXLEN', 'MINID']),
  XRANGE: R('key start end [COUNT n]', 'stream', [1], ['COUNT']),
  XREVRANGE: R('key end start [COUNT n]', 'stream', [1], ['COUNT']),
  XLEN: R('key', 'stream', [1]),
  XDEL: R('key id [id …]', 'stream', [1]),
  XTRIM: R('key MAXLEN | MINID [~] threshold', 'stream', [1], ['MAXLEN', 'MINID']),
  XINFO: R('STREAM key | GROUPS key | CONSUMERS key group', 'stream', [2], ['STREAM', 'GROUPS', 'CONSUMERS', 'HELP']),
  XREAD: R('[COUNT n] [BLOCK ms] STREAMS key [key …] id [id …]', 'stream', undefined, ['COUNT', 'BLOCK', 'STREAMS']),
  // JSON (RedisJSON / valkey-json)
  'JSON.GET': R('key [path …]', 'json', [1]),
  'JSON.SET': R('key path value [NX | XX]', 'json', [1], ['NX', 'XX']),
  'JSON.DEL': R('key [path]', 'json', [1]),
  'JSON.TYPE': R('key [path]', 'json', [1]),
  // pub/sub
  PUBLISH: R('channel message', 'pubsub'),
  PUBSUB: R('CHANNELS [pattern] | NUMSUB [channel …] | NUMPAT', 'pubsub', undefined, ['CHANNELS', 'NUMSUB', 'NUMPAT', 'SHARDCHANNELS']),
  // server / connection
  PING: R('[message]', 'connection'),
  ECHO: R('message', 'connection'),
  SELECT: R('index', 'connection'),
  DBSIZE: R('', 'server'),
  INFO: R('[section …]', 'server', undefined, ['server', 'clients', 'memory', 'persistence', 'stats', 'replication', 'cpu', 'commandstats', 'keyspace', 'all', 'everything']),
  TIME: R('', 'server'),
  LASTSAVE: R('', 'server'),
  CONFIG: R('GET parameter | SET parameter value | RESETSTAT | REWRITE', 'server', undefined, ['GET', 'SET', 'RESETSTAT', 'REWRITE']),
  CLIENT: R('LIST | INFO | ID | SETNAME name | GETNAME | KILL …', 'connection', undefined, ['LIST', 'INFO', 'ID', 'SETNAME', 'GETNAME', 'KILL', 'NO-EVICT', 'PAUSE', 'UNPAUSE']),
  SLOWLOG: R('GET [count] | LEN | RESET', 'server', undefined, ['GET', 'LEN', 'RESET']),
  FLUSHDB: R('[ASYNC | SYNC]', 'server', undefined, ['ASYNC', 'SYNC']),
  FLUSHALL: R('[ASYNC | SYNC]', 'server', undefined, ['ASYNC', 'SYNC']),
  BGSAVE: R('', 'server'),
  MULTI: R('', 'transaction'),
  EXEC: R('', 'transaction'),
  DISCARD: R('', 'transaction'),
  EVAL: R('script numkeys [key …] [arg …]', 'scripting'),
  COMMAND: R('[COUNT | DOCS | INFO | LIST]', 'server', undefined, ['COUNT', 'DOCS', 'INFO', 'LIST']),
};
/** Commands whose first argument is a sub-command; the key then comes one place later. */
const SUBCOMMAND_KEY: Record<string, string[]> = { OBJECT: ['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT'], MEMORY: ['USAGE'], XINFO: ['STREAM', 'GROUPS', 'CONSUMERS'] };

/** Words of a redis-cli line up to the cursor, quotes respected ('a b' is one word). */
function redisWords(line: string): string[] {
  return line.match(/"(?:[^"\\]|\\.)*"?|'[^']*'?|\S+/g) ?? [];
}

/**
 * Suggestions for a redis-cli line: the command (first word), then key names
 * where the command takes a key, its options and flags after that.
 */
export function redisComplete(text: string, cursor: number, ctx: RedisContext, explicit = false): Completion | null {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  const before = text.slice(lineStart, cursor);
  if (/^\s*#/.test(before)) return null;
  // Inside an unfinished quote: no suggestions.
  if (((before.match(/"/g) ?? []).length - (before.match(/\\"/g) ?? []).length) % 2 === 1) return null;
  const word = /[^\s"']*$/.exec(before)?.[0] ?? '';
  if (!word && !explicit) return null;
  const from = cursor - word.length;
  const after = /^[^\s]*/.exec(text.slice(cursor))?.[0] ?? '';
  const to = cursor + after.length;
  const words = redisWords(before.slice(0, before.length - word.length));
  const items: (Suggestion & { s: number })[] = [];
  const add = (sug: Suggestion, onlyPrefix = false) => {
    const s = score(sug.label, word);
    if ((onlyPrefix && s < 2 && word) || s <= 0) return;
    if (!items.some((i) => i.label === sug.label && i.kind === sug.kind)) items.push({ ...sug, s });
  };

  if (!words.length) {
    // The command.
    for (const [name, c] of Object.entries(REDIS)) add({ label: name, insert: `${inCase(name, word)} `, kind: 'keyword', detail: c.args ? `${c.args}` : c.group }, true);
  } else {
    const name = words[0].toUpperCase();
    const cmd = REDIS[name];
    if (!cmd) return null;
    const pos = words.length; // the argument being typed: 1 = first after the command
    const sub = SUBCOMMAND_KEY[name];
    const keyHere =
      cmd.k === 'all' ? true : cmd.k === 'odd' ? pos % 2 === 1 : Array.isArray(cmd.k) && cmd.k.includes(pos) && (!sub || pos > 1) && (!sub || sub.includes((words[1] ?? '').toUpperCase()));
    if (keyHere && !word.startsWith('-')) {
      const keys = ctx.keys(word);
      // Keys of the type the command works on come first (HGET → hashes).
      const want = ['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(cmd.group) ? cmd.group : cmd.group === 'json' ? 'ReJSON-RL' : null;
      for (const k of keys ?? []) {
        add({ label: k.key, insert: /[\s"']/.test(k.key) ? JSON.stringify(k.key) : k.key, kind: 'key', detail: k.type });
        const it = items.find((i) => i.kind === 'key' && i.label === k.key);
        if (it && want && k.type.toLowerCase() === want.toLowerCase()) it.s += 1;
      }
    }
    // Options and sub-commands, in the command's own words.
    const usedOpts = new Set(words.slice(1).map((w) => w.toUpperCase()));
    for (const o of cmd.opts ?? []) if (!usedOpts.has(o) || o === 'LEFT' || o === 'RIGHT') add({ label: o, insert: `${inCase(o, word)} `, kind: 'option', detail: name }, true);
  }
  const order: Record<SuggestKind, number> = { key: 0, option: 1, keyword: 2, column: 3, table: 4, function: 5 };
  items.sort((a, b) => b.s - a.s || order[a.kind] - order[b.kind] || a.label.length - b.label.length || a.label.localeCompare(b.label));
  const list = items.slice(0, 40).map(({ s: _s, ...rest }) => rest);
  return list.length ? { from, to, items: list } : null;
}

// ---------------------------------------------------------------- MongoDB

/** Collection methods the query tab runs (nosql.ts MongoDriver.query), with their arguments. */
const MONGO_METHODS: Record<string, string> = {
  find: 'filter, projection',
  findOne: 'filter',
  aggregate: '[stages]',
  countDocuments: 'filter',
  estimatedDocumentCount: '',
  distinct: "'field', filter",
  insertOne: 'document',
  insertMany: '[documents]',
  updateOne: 'filter, update, options',
  updateMany: 'filter, update, options',
  replaceOne: 'filter, document',
  deleteOne: 'filter',
  deleteMany: 'filter',
  createIndex: 'keys, options',
  dropIndex: "'name'",
  getIndexes: '',
  drop: '',
};
/** What can follow find(…). */
const MONGO_CURSOR: Record<string, string> = { sort: '{ field: 1 | -1 }', limit: 'n', skip: 'n', project: '{ field: 1 }' };
const MONGO_QUERY_OPS: Record<string, string> = {
  $eq: 'equal', $ne: 'not equal', $gt: 'greater than', $gte: 'greater or equal', $lt: 'less than', $lte: 'less or equal', $in: '[values]', $nin: 'not in [values]',
  $and: '[conditions]', $or: '[conditions]', $nor: '[conditions]', $not: '{ condition }', $exists: 'true | false', $type: "'string' …", $regex: "'pattern'", $options: "'i'",
  $elemMatch: '{ condition }', $size: 'array length', $all: '[values]', $expr: '{ expression }', $text: '{ $search }',
};
const MONGO_UPDATE_OPS: Record<string, string> = {
  $set: '{ field: value }', $unset: "{ field: '' }", $inc: '{ field: n }', $mul: '{ field: n }', $rename: "{ field: 'new' }", $min: '{ field: value }', $max: '{ field: value }',
  $currentDate: '{ field: true }', $setOnInsert: '{ field: value }', $push: '{ field: value }', $addToSet: '{ field: value }', $pull: '{ field: condition }', $pop: '{ field: 1 | -1 }',
};
const MONGO_STAGES: Record<string, string> = {
  $match: '{ filter }', $group: "{ _id: '$field', n: { $sum: 1 } }", $project: '{ field: 1 }', $sort: '{ field: 1 | -1 }', $limit: 'n', $skip: 'n', $count: "'name'",
  $unwind: "'$field'", $lookup: '{ from, localField, foreignField, as }', $addFields: '{ field: expression }', $set: '{ field: expression }', $unset: "'field'",
  $replaceRoot: '{ newRoot }', $facet: '{ name: [stages] }', $bucket: '{ groupBy, boundaries }', $sample: '{ size: n }', $sortByCount: "'$field'", $out: "'collection'",
};
const MONGO_EXPR_OPS: Record<string, string> = {
  $sum: 'total', $avg: 'average', $min: 'smallest', $max: 'largest', $first: 'first', $last: 'last', $push: 'array', $addToSet: 'set', $count: 'count',
  $concat: '[strings]', $toLower: 'text', $toUpper: 'text', $cond: '{ if, then, else }', $ifNull: '[value, fallback]', $size: 'array length', $dateToString: '{ format, date }',
  $eq: '[a, b]', $gt: '[a, b]', $lt: '[a, b]', $and: '[…]', $or: '[…]',
};

/** A statement starts on a line beginning with db. or { (as MongoDriver.exec splits them). */
function mongoStatementStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0) {
    const nl = text.lastIndexOf('\n', i - 1);
    const lineStart = nl + 1;
    if (/^\s*(db\.|\{)/.test(text.slice(lineStart, cursor))) return lineStart;
    if (nl < 0) return 0;
    i = nl;
  }
  return 0;
}

/**
 * Suggestions for the mongosh-like query tab: collections after `db.`, methods after `db.<collection>.`, sort / limit …
 * after find(…), and inside the arguments the collection's fields (read from a sample of documents), query and
 * update operators, and aggregation stages.
 */
export function mongoComplete(text: string, cursor: number, ctx: CompleteContext, explicit = false): Completion | null {
  const start = mongoStatementStart(text, cursor);
  const before = text.slice(start, cursor);
  const word = /[\w$]*$/.exec(before)?.[0] ?? '';
  const from = cursor - word.length;
  const to = cursor + (/^[\w$]*/.exec(text.slice(cursor))?.[0] ?? '').length;
  const head = before.slice(0, before.length - word.length);
  const prevChar = head.trimEnd().slice(-1);
  const items: (Suggestion & { s: number })[] = [];
  const add = (sug: Suggestion) => {
    const s = score(sug.label, word);
    if (s > 0 && !items.some((i) => i.label === sug.label && i.kind === sug.kind)) items.push({ ...sug, s });
  };
  const fieldsOf = (c: string) => {
    const cols = ctx.columns(c);
    if (!cols) ctx.need(c);
    return cols ?? [];
  };
  const finish = (): Completion | null => {
    // Same score: fields first, then the lists' own order (most used first).
    const order: Record<SuggestKind, number> = { column: 0, table: 1, function: 2, keyword: 3, option: 4, key: 5 };
    items.sort((a, b) => b.s - a.s || order[a.kind] - order[b.kind]);
    const list = items.slice(0, 40).map(({ s: _s, ...rest }) => rest);
    return list.length ? { from, to, items: list } : null;
  };

  // db.<collection>
  if (/^\s*db\.$/.test(head)) {
    if (!word && !explicit && prevChar !== '.') return null;
    for (const t of ctx.tables) add({ label: t, insert: /^[A-Za-z_$][\w$]*$/.test(t) ? `${t}.` : t, kind: 'table', detail: 'collection' });
    return finish();
  }
  // db.<collection>.<method>
  const m = /^\s*db\.([^(]+)\.$/.exec(head);
  if (m) {
    for (const [name, args] of Object.entries(MONGO_METHODS)) add({ label: name, insert: `${name}(`, kind: 'function', detail: args ? `(${args})` : '()' });
    return finish();
  }
  // The start of a statement: db.
  if (!head.trim()) {
    if (!word && !explicit) return null;
    add({ label: 'db', insert: 'db.', kind: 'keyword', detail: 'db.<collection>.<method>(…)' });
    return finish();
  }

  const call = /^\s*db\.(.+?)\.(\w+)\(/.exec(head);
  if (!call) return null;
  const [, collection, method] = call;
  // Walk the arguments: strings skipped, brackets on a stack, commas at the call's own level counted.
  const rest = head.slice(call[0].length);
  const stack: string[] = [];
  let arg = 0;
  let closed = false;
  let quote = '';
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[' || ch === '(') stack.push(ch);
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (stack.length) stack.pop();
      else closed = true; // the call's own ')'
    } else if (ch === ',' && !stack.length && !closed) arg++;
  }
  if (quote) return null;

  // After find(…): .sort( .limit( …
  if (closed) {
    if (!/\.$/.test(head) || method !== 'find') return null;
    for (const [name, args] of Object.entries(MONGO_CURSOR)) add({ label: name, insert: `${name}(`, kind: 'function', detail: `(${args})` });
    return finish();
  }

  const top = stack[stack.length - 1];
  const keySlot = top === '{' && (prevChar === '{' || prevChar === ',');
  const valueSlot = prevChar === ':' || (top === '[' && (prevChar === '[' || prevChar === ','));
  if (!word && !explicit && prevChar !== '{') return null;

  if (keySlot) {
    if (word.startsWith('$') || !word) {
      if (method === 'aggregate' && stack.length === 2 && stack[0] === '[') for (const [k, d] of Object.entries(MONGO_STAGES)) add({ label: k, insert: `${k}: `, kind: 'keyword', detail: d });
      else if (/^(update|replace)/.test(method) && arg === 1 && stack.length === 1) for (const [k, d] of Object.entries(MONGO_UPDATE_OPS)) add({ label: k, insert: `${k}: `, kind: 'keyword', detail: d });
      else {
        for (const [k, d] of Object.entries(MONGO_QUERY_OPS)) add({ label: k, insert: `${k}: `, kind: 'keyword', detail: d });
        if (method === 'aggregate') for (const [k, d] of Object.entries(MONGO_EXPR_OPS)) add({ label: k, insert: `${k}: `, kind: 'function', detail: d });
      }
    }
    if (!word.startsWith('$') && !(method === 'aggregate' && stack.length === 2)) {
      for (const f of fieldsOf(collection)) add({ label: f.name, insert: /^[A-Za-z_$][\w$]*$/.test(f.name) ? `${f.name}: ` : `${JSON.stringify(f.name)}: `, kind: 'column', detail: f.type });
    }
    return finish();
  }
  // '$field' references in aggregation expressions.
  if (valueSlot && method === 'aggregate' && word.startsWith('$')) {
    for (const f of fieldsOf(collection)) add({ label: `$${f.name}`, insert: `'$${f.name}'`, kind: 'column', detail: f.type });
    for (const [k, d] of Object.entries(MONGO_EXPR_OPS)) add({ label: k, insert: `{ ${k}: `, kind: 'function', detail: d });
    return finish();
  }
  return null;
}

// ---------------------------------------------------------------- Elasticsearch

const ES_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'];
/** Paths without an index. */
const ES_ROOT_PATHS: Record<string, string> = { '_cat/indices?v': 'every index', '_cluster/health': 'cluster state', '_search': 'search every index', '_cat/aliases?v': 'aliases', '_nodes/stats': 'node stats' };
/** What can follow /<index>/. */
const ES_INDEX_PATHS: Record<string, string> = {
  _search: 'search', _count: 'count documents', _doc: '_doc/<id>: one document', _mapping: 'fields and types', _settings: 'index settings',
  _update: '_update/<id>: change one document', _delete_by_query: 'delete what a query finds', _update_by_query: 'change what a query finds', _refresh: 'make writes searchable',
};
const ES_BODY: Record<string, string> = { query: '{ … }', size: 'how many hits', from: 'skip', sort: '[{ field: "asc" }]', _source: '[fields]', aggs: '{ name: { … } }', track_total_hits: 'true', highlight: '{ fields }' };
const ES_QUERIES: Record<string, string> = {
  match: '{ field: "text" }', match_phrase: '{ field: "words in order" }', multi_match: '{ query, fields }', term: '{ field: value }', terms: '{ field: [values] }',
  range: '{ field: { gte, lte } }', bool: '{ must, should, filter, must_not }', exists: '{ field }', match_all: '{}', wildcard: '{ field: "a*" }', prefix: '{ field: "ab" }',
  query_string: '{ query: "a AND b" }', ids: '{ values: [] }', nested: '{ path, query }',
};
const ES_BOOL: Record<string, string> = { must: '[queries]: must match, scored', filter: '[queries]: must match, not scored', should: '[queries]: any may match', must_not: '[queries]: must not match', minimum_should_match: 'n' };
const ES_RANGE: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<', format: 'date format' };
const ES_AGGS: Record<string, string> = { terms: '{ field, size }', avg: '{ field }', sum: '{ field }', min: '{ field }', max: '{ field }', value_count: '{ field }', cardinality: '{ field }', date_histogram: '{ field, calendar_interval }', histogram: '{ field, interval }', filter: '{ query }', top_hits: '{ size }' };
const ES_AGG_PARAMS: Record<string, string> = { field: '"field"', size: 'n', order: '{ _count: "desc" }', calendar_interval: '"day" | "month"', interval: 'n', missing: 'value' };
/** Query types whose object is keyed by field. */
const ES_FIELD_KEYED = /^(match|match_phrase|match_phrase_prefix|term|terms|range|wildcard|prefix|fuzzy|regexp|sort|properties)$/;

/**
 * Suggestions for the Elasticsearch request tab: the method and path on a request's first line (index names, then
 * _search, _doc …), and in the JSON body the keys that fit where the cursor is (query types under query, must / filter
 * under bool, gte / lte under a range field, aggregation types under aggs) and the index's fields from its mapping.
 */
export function esComplete(text: string, cursor: number, ctx: CompleteContext, explicit = false): Completion | null {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  const line = text.slice(lineStart, cursor);
  const items: (Suggestion & { s: number })[] = [];
  let word = '';
  const add = (sug: Suggestion) => {
    const s = score(sug.label, word);
    if (s > 0 && !items.some((i) => i.label === sug.label && i.kind === sug.kind)) items.push({ ...sug, s });
  };
  const fieldsOf = (index: string | null) => {
    if (!index) return [];
    const cols = ctx.columns(index);
    if (!cols) ctx.need(index);
    return (cols ?? []).filter((c) => c.name !== '_id');
  };
  const done = (from: number, to: number): Completion | null => {
    const order: Record<SuggestKind, number> = { column: 0, table: 1, function: 2, keyword: 3, option: 4, key: 5 };
    items.sort((a, b) => b.s - a.s || order[a.kind] - order[b.kind]);
    const list = items.slice(0, 40).map(({ s: _s, ...rest }) => rest);
    return list.length ? { from, to, items: list } : null;
  };

  // The request line: METHOD /path
  const reqLine = /^\s*([A-Za-z]*)$/.exec(line) && !/^\s*[{["]/.test(line);
  if (reqLine) {
    word = line.trim();
    if (!word && !explicit) return null;
    for (const m of ES_METHODS) add({ label: m, insert: `${m} /`, kind: 'keyword' });
    return done(cursor - word.length, cursor + (/^[A-Za-z]*/.exec(text.slice(cursor))?.[0] ?? '').length);
  }
  const path = /^\s*(?:GET|POST|PUT|DELETE|HEAD)\s+(\/?)([^\s]*)$/i.exec(line);
  if (path) {
    const p = path[2];
    const slash = p.lastIndexOf('/');
    word = p.slice(slash + 1);
    const from = cursor - word.length;
    const to = cursor + (/^[^\s/]*/.exec(text.slice(cursor))?.[0] ?? '').length;
    if (slash < 0) {
      for (const t of ctx.tables) add({ label: t, insert: `${t}/`, kind: 'table', detail: 'index' });
      for (const [k, d] of Object.entries(ES_ROOT_PATHS)) add({ label: k, insert: k, kind: 'keyword', detail: d });
    } else if (slash === p.indexOf('/') && !p.startsWith('_')) {
      for (const [k, d] of Object.entries(ES_INDEX_PATHS)) add({ label: k, insert: k === '_doc' || k === '_update' ? `${k}/` : k, kind: 'keyword', detail: d });
    }
    if (!word && !explicit && !/\/$/.test(line)) return null;
    return done(from, to);
  }

  // The JSON body: the request it belongs to is the last METHOD line above.
  const reqAt = [...text.slice(0, lineStart).matchAll(/^\s*(GET|POST|PUT|DELETE|HEAD)\s+\/?(\S*)/gim)].pop();
  if (!reqAt) return null;
  const reqPath = reqAt[2];
  const index = reqPath && !reqPath.startsWith('_') ? reqPath.split(/[/?]/)[0] : null;
  const bodyStart = (reqAt.index ?? 0) + reqAt[0].length;
  const before = text.slice(bodyStart, cursor);
  const m = /("?)([\w.@$-]*)$/.exec(before)!;
  word = m[2];
  const quoted = m[1] === '"';
  const from = cursor - word.length - (quoted ? 1 : 0);
  const tail = /^[\w.@$-]*"?/.exec(text.slice(cursor))?.[0] ?? '';
  const to = cursor + tail.length;
  const head = before.slice(0, before.length - word.length - (quoted ? 1 : 0));

  // Walk the JSON: each { or [ remembers the key it is the value of.
  const stack: { ch: string; key: string | null }[] = [];
  let lastToken: string | null = null;
  let lastKey: string | null = null;
  let prev = '';
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (/\s/.test(ch)) continue;
    if (ch === '"') {
      let j = i + 1;
      while (j < head.length && head[j] !== '"') j += head[j] === '\\' ? 2 : 1;
      if (j >= head.length) return null; // inside a string value
      lastToken = head.slice(i + 1, j);
      i = j;
      prev = 's';
      continue;
    }
    if (/[\w$]/.test(ch)) {
      const w = /^[\w$.-]+/.exec(head.slice(i))![0];
      lastToken = w;
      i += w.length - 1;
      prev = 's';
      continue;
    }
    if (ch === ':') lastKey = lastToken;
    else if (ch === '{' || ch === '[') stack.push({ ch, key: prev === ':' ? lastKey : stack[stack.length - 1]?.key ?? null });
    else if (ch === '}' || ch === ']') stack.pop();
    prev = ch;
  }
  const top = stack[stack.length - 1];
  const parent = top?.key ?? null;
  const grand = stack.length > 1 ? stack[stack.length - 2].key : null;
  const great = stack.length > 2 ? stack[stack.length - 3].key : null;
  const key = (k: string, d: string, kind: SuggestKind = 'keyword') => add({ label: k, insert: `"${k}": `, kind, detail: d });
  const fields = (asKey: boolean) => {
    for (const f of fieldsOf(index)) add({ label: f.name, insert: asKey ? `"${f.name}": ` : `"${f.name}"`, kind: 'column', detail: f.type });
  };
  if (!word && !explicit && !quoted && prev !== '{') return null;

  if (top?.ch === '{' && (prev === '{' || prev === ',')) {
    const isMapping = /(^|\/)_mapping/.test(reqPath);
    if (stack.length === 1 && !parent) {
      if (isMapping) key('properties', '{ field: { type } }');
      else if (/^PUT$/i.test(reqAt[1]) && !reqPath.includes('/')) {
        key('mappings', '{ properties }');
        key('settings', '{ number_of_shards }');
      } else if (/\/(_doc|_create)\b/.test(reqPath) || /^(PUT|POST)$/i.test(reqAt[1]) && /\/_doc/.test(reqPath)) fields(true);
      else if (/\/_update\//.test(reqPath)) key('doc', '{ field: value }');
      else for (const [k, d] of Object.entries(ES_BODY)) key(k, d);
    } else if (parent === 'query' || parent === 'filter' && grand !== 'aggs' || /^(must|should|must_not)$/.test(parent ?? '')) {
      for (const [k, d] of Object.entries(ES_QUERIES)) key(k, d, 'function');
    } else if (parent === 'bool') {
      for (const [k, d] of Object.entries(ES_BOOL)) key(k, d);
    } else if (grand === 'range') {
      for (const [k, d] of Object.entries(ES_RANGE)) key(k, d, 'option');
    } else if (parent === 'aggs' || parent === 'aggregations') {
      return null; // a name of your own comes first
    } else if (grand === 'aggs' || grand === 'aggregations') {
      for (const [k, d] of Object.entries(ES_AGGS)) key(k, d, 'function');
      key('aggs', 'sub-aggregations');
    } else if (great === 'aggs' || great === 'aggregations') {
      for (const [k, d] of Object.entries(ES_AGG_PARAMS)) key(k, d, 'option');
    } else if (parent === 'exists') {
      key('field', '"field"', 'option');
    } else if (parent === 'doc' || ES_FIELD_KEYED.test(parent ?? '')) {
      fields(true);
    } else if (parent === 'properties' && grand === 'properties') return null;
    else if (grand === 'properties') key('type', '"keyword" | "text" …', 'option');
    return done(from, to);
  }
  // Values that name a field: "field": …, _source: [ … ], fields: [ … ]
  if ((prev === ':' && lastKey === 'field') || (top?.ch === '[' && /^(_source|fields)$/.test(parent ?? '') && (prev === '[' || prev === ','))) {
    fields(false);
    return done(from, to);
  }
  if (prev === ':' && lastKey === 'type' && grand === 'properties') {
    for (const t of ['keyword', 'text', 'integer', 'long', 'float', 'double', 'boolean', 'date', 'object', 'nested', 'geo_point', 'ip']) add({ label: t, insert: `"${t}"`, kind: 'option' });
    return done(from, to);
  }
  return null;
}
