import type { DbEngine } from './types';

/**
 * What a statement / command does, for DBCatz's guards: read-only
 * connections refuse anything but reads; Production asks before writes; any
 * connection asks before destructive ones (DROP, TRUNCATE, UPDATE / DELETE
 * without WHERE, FLUSHALL, deleteMany({}) …).
 */

export interface StatementKind {
  /** Changes nothing (SELECT, SHOW, EXPLAIN, GET …). */
  read: boolean;
  /** Changes structure (CREATE / ALTER / DROP / RENAME / TRUNCATE …). */
  ddl: boolean;
  /** Removes data or structure, or touches every row: asks with a typed confirmation. */
  destructive: boolean;
  /** Why it is destructive (shown in the dialog). */
  reason: string | null;
}

const stripSql = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\s+/g, ' ')
    .trim();

function sqlKind(stmt: string): StatementKind {
  const s = stripSql(stmt);
  const u = s.toUpperCase();
  const first = /^\(?\s*(\w+)/.exec(u)?.[1] ?? '';
  const out = (read: boolean, ddl = false, reason: string | null = null): StatementKind => ({ read, ddl, destructive: !!reason, reason });
  // WITH … : the final verb decides.
  const verb = first === 'WITH' ? (/\)\s*(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/.exec(u)?.[1] ?? 'SELECT') : first;
  switch (verb) {
    case 'SELECT':
      return /\bINTO\s+(OUTFILE|DUMPFILE|\w)/.test(u) && !/\bINTO\s+@/.test(u) ? out(false) : /\bFOR\s+UPDATE\b/.test(u) ? out(false) : out(true);
    case 'SHOW':
    case 'DESCRIBE':
    case 'DESC':
    case 'USE':
    case 'VALUES':
    case 'TABLE':
      return out(true);
    case 'EXPLAIN':
      // EXPLAIN ANALYZE runs the statement.
      return /^EXPLAIN\s+(\(.*ANALYZE.*\)|ANALYZE)\b/.test(u) && !/\bANALYZE\b[\s\S]*\bSELECT\b/.test(u) ? out(false) : out(true);
    case 'PRAGMA':
      return /=/.test(u) ? out(false) : out(true);
    case 'SET':
      return /^SET\s+(GLOBAL|PERSIST)\b/.test(u) ? out(false, false, 'Changes a server-wide setting') : out(true);
    case 'BEGIN':
    case 'START':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
      return out(true);
    case 'UPDATE':
      return out(false, false, /\bWHERE\b/.test(u) ? null : 'UPDATE without WHERE changes every row');
    case 'DELETE':
      return out(false, false, /\bWHERE\b/.test(u) ? null : 'DELETE without WHERE removes every row');
    case 'DROP':
      return out(false, true, `DROP ${/^DROP\s+(\w+)/.exec(u)?.[1] ?? ''} removes it and its data for good`.replace(/\s+/g, ' '));
    case 'TRUNCATE':
      return out(false, true, 'TRUNCATE removes every row');
    case 'ALTER':
      return /\bDROP\b/.test(u) ? out(false, true, 'ALTER … DROP removes a column, index or key') : /\b(MODIFY|CHANGE|ALTER\s+COLUMN|TYPE)\b/.test(u) ? out(false, true, 'ALTER changes a column type: values that do not fit fail or are cut') : out(false, true);
    case 'RENAME':
      return out(false, true, 'RENAME breaks every app and query that uses the old name');
    case 'CREATE':
      return out(false, true);
    case 'GRANT':
    case 'REVOKE':
      return out(false, true, `${verb} changes who can do what on the server`);
    case 'FLUSH':
    case 'RESET':
    case 'PURGE':
    case 'KILL':
    case 'SHUTDOWN':
      return out(false, false, `${verb} affects the whole server`);
    default:
      return out(false);
  }
}

const REDIS_READ = new Set(
  'GET MGET STRLEN GETRANGE EXISTS TYPE TTL PTTL EXPIRETIME KEYS SCAN SSCAN HSCAN ZSCAN DBSIZE INFO PING ECHO TIME LRANGE LLEN LINDEX LPOS SMEMBERS SISMEMBER SMISMEMBER SCARD SRANDMEMBER SINTER SUNION SDIFF HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN HRANDFIELD ZRANGE ZRANGEBYSCORE ZRANGEBYLEX ZREVRANGE ZREVRANGEBYSCORE ZCARD ZSCORE ZMSCORE ZRANK ZREVRANK ZCOUNT ZLEXCOUNT XRANGE XREVRANGE XLEN XINFO XREAD OBJECT MEMORY DUMP RANDOMKEY SELECT CLIENT COMMAND LASTSAVE ROLE SLOWLOG JSON.GET JSON.TYPE JSON.MGET JSON.OBJKEYS JSON.OBJLEN JSON.ARRLEN JSON.STRLEN PFCOUNT GETBIT BITCOUNT BITPOS GEOPOS GEODIST GEOHASH GEOSEARCH SORT_RO EVAL_RO FT.SEARCH FT.INFO FT._LIST'.split(' '),
);
function redisKind(line: string): StatementKind {
  const cmd = (line.trim().split(/\s+/)[0] ?? '').toUpperCase();
  const read = REDIS_READ.has(cmd) && !(cmd === 'CLIENT' && /\bKILL\b/i.test(line)) && !(cmd === 'MEMORY' && /\bPURGE\b/i.test(line));
  const reason = cmd === 'FLUSHALL' ? 'FLUSHALL deletes every key in every database' : cmd === 'FLUSHDB' ? 'FLUSHDB deletes every key in this database' : cmd === 'DEL' || cmd === 'UNLINK' ? null : /^(CONFIG|SHUTDOWN|DEBUG|MIGRATE|REPLICAOF|SLAVEOF|SWAPDB|MOVE|RESTORE|SCRIPT|FUNCTION|ACL)$/.test(cmd) ? `${cmd} changes the server` : null;
  return { read, ddl: false, destructive: !!reason, reason };
}

const MONGO_READ = new Set(['find', 'findOne', 'countDocuments', 'count', 'estimatedDocumentCount', 'distinct', 'getIndexes', 'indexes']);
function mongoKind(text: string): StatementKind {
  const t = text.trim();
  if (t.startsWith('{')) {
    const cmd = /^\{\s*["']?(\w+)/.exec(t)?.[1] ?? '';
    const read = /^(ping|buildInfo|buildinfo|serverStatus|listCollections|listDatabases|listIndexes|dbStats|collStats|count|distinct|find|aggregate|explain|hello|isMaster|hostInfo|connectionStatus)$/.test(cmd) && !/\$out|\$merge/.test(t);
    return { read, ddl: false, destructive: /^(drop|dropDatabase|dropIndexes)$/.test(cmd), reason: /^(drop|dropDatabase|dropIndexes)$/.test(cmd) ? `${cmd} removes data for good` : null };
  }
  const method = /^db(?:\.getCollection\([^)]*\)|\.[\w.-]+)\.(\w+)\s*\(/.exec(t)?.[1] ?? '';
  if (method === 'aggregate') return { read: !/\$out|\$merge/.test(t), ddl: false, destructive: false, reason: null };
  const wipe = (method === 'deleteMany' || method === 'updateMany') && /\(\s*\{\s*\}\s*[,)]/.test(t);
  const reason = method === 'drop' ? 'drop() removes the collection and its documents' : wipe ? `${method}({}) touches every document` : null;
  return { read: MONGO_READ.has(method), ddl: /^(drop|createIndex|dropIndex|renameCollection)$/.test(method), destructive: !!reason, reason };
}

function esKind(text: string): StatementKind {
  const m = /^\s*(GET|POST|PUT|DELETE|HEAD)\s+(\S+)/i.exec(text);
  const method = m?.[1].toUpperCase() ?? '';
  const path = m?.[2] ?? '';
  const read = method === 'GET' || method === 'HEAD' || (method === 'POST' && /\/_(search|count|msearch|mget|validate|explain|field_caps|sql)\b/.test(path));
  const reason = method === 'DELETE' ? 'DELETE removes an index or documents' : /_delete_by_query/.test(path) ? '_delete_by_query removes documents' : null;
  return { read, ddl: method === 'PUT' && !/_doc/.test(path), destructive: !!reason, reason };
}

export function statementKind(engine: DbEngine, text: string): StatementKind {
  if (engine === 'redis' || engine === 'valkey') return redisKind(text);
  if (engine === 'mongodb') return mongoKind(text);
  if (engine === 'elasticsearch') return esKind(text);
  return sqlKind(text);
}
