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
