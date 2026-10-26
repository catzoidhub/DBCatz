import type { DbEngine, DvConnectionInput, DvOptions } from './types';
import { DV_DEFAULT_OPTIONS } from './types';

/**
 * Connection URLs → DBCatz connection fields: mysql://, mariadb://,
 * postgres(ql)://, redis(s)://, valkey(s)://, mongodb(+srv)://, http(s)://
 * (Elasticsearch), sqlite:// / file:, jdbc: prefixes, ?ssl / sslmode / tls,
 * ?socket / ?host=/path for local sockets. Throws with a readable message.
 */

const DEFAULT_PORT: Record<DbEngine, number> = { mysql: 3306, mariadb: 3306, postgresql: 5432, redis: 6379, valkey: 6379, mongodb: 27017, elasticsearch: 9200, sqlite: 0 };

const SCHEMES: Record<string, { engine: DbEngine; tls?: boolean; srv?: boolean }> = {
  mysql: { engine: 'mysql' },
  'mysql+ssl': { engine: 'mysql', tls: true },
  mysqlx: { engine: 'mysql' },
  mariadb: { engine: 'mariadb' },
  postgres: { engine: 'postgresql' },
  postgresql: { engine: 'postgresql' },
  pgsql: { engine: 'postgresql' },
  redis: { engine: 'redis' },
  rediss: { engine: 'redis', tls: true },
  valkey: { engine: 'valkey' },
  valkeys: { engine: 'valkey', tls: true },
  mongodb: { engine: 'mongodb' },
  'mongodb+srv': { engine: 'mongodb', srv: true, tls: true },
  http: { engine: 'elasticsearch' },
  https: { engine: 'elasticsearch', tls: true },
  elasticsearch: { engine: 'elasticsearch' },
  sqlite: { engine: 'sqlite' },
  sqlite3: { engine: 'sqlite' },
  file: { engine: 'sqlite' },
};

export type ParsedUrl = Omit<DvConnectionInput, 'name' | 'color'> & { name: string; options: DvOptions };

const truthy = (v: string | null) => v !== null && /^(1|true|yes|on|require|required|verify-ca|verify-full|verify_identity|verify_ca|preferred)$/i.test(v);

export function parseDbUrl(raw: string): ParsedUrl {
  let text = raw.trim().replace(/^jdbc:/i, '');
  if (!text) throw new Error('Paste a connection URL first');
  // DATABASE_URL="…" lines copied from a .env.
  text = text.replace(/^[A-Z0-9_]+\s*=\s*/, '').replace(/^["']|["']$/g, '');
  const m = /^([a-z0-9+.-]+):/i.exec(text);
  if (!m) throw new Error('A URL starts with a scheme such as mysql://, postgres://, redis:// or mongodb://');
  const scheme = SCHEMES[m[1].toLowerCase()];
  if (!scheme) throw new Error(`${m[1]}:// is not a database URL DBCatz knows`);
  const options: DvOptions = { ...DV_DEFAULT_OPTIONS, requireSsl: !!scheme.tls, srv: !!scheme.srv };
  const base = { engine: scheme.engine, host: '', port: DEFAULT_PORT[scheme.engine], user: '', password: '' as string | null, database: '', file: '', method: 'tcp' as const, socket: '', ssh: null, aws: null, vault: null, options };

  if (scheme.engine === 'sqlite') {
    const path = decodeURIComponent(text.replace(/^[a-z0-9]+:(\/\/)?/i, '').replace(/^localhost(?=\/)/, ''));
    if (!path) throw new Error('The URL names no SQLite file');
    return { ...base, file: path.startsWith('/') || path.startsWith('~') ? path : `/${path}`, name: path.split('/').pop() || 'SQLite', password: '' };
  }

  // No host (postgresql://u@/db?host=/socket): a placeholder so URL() can read it.
  text = text.replace(/^([a-z0-9+.-]+:\/\/(?:[^@/?#]*@)?)(?=[/?])/i, '$1localhost');
  // Several Mongo hosts (replica sets): the first one is used.
  const hostList = /^[^:]+:\/\/(?:[^@/]*@)?([^/?#]*)/.exec(text)?.[1] ?? '';
  let url: URL;
  try {
    url = new URL(hostList.includes(',') ? text.replace(hostList, hostList.split(',')[0]) : text);
  } catch {
    throw new Error('That URL cannot be read (check special characters in the password: they must be %-encoded)');
  }
  const q = url.searchParams;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const host = decodeURIComponent(url.hostname).replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : DEFAULT_PORT[scheme.engine];
  let database = decodeURIComponent(url.pathname.replace(/^\//, ''));

  // SSL / TLS from the query (several spellings).
  const ssl = q.get('ssl') ?? q.get('sslmode') ?? q.get('ssl-mode') ?? q.get('tls') ?? q.get('useSSL') ?? q.get('ssl_mode');
  if (ssl !== null) options.requireSsl = truthy(ssl) || (ssl === '' && q.has('ssl'));
  if (/^(disable|disabled|false|0|no)$/i.test(ssl ?? '')) options.requireSsl = false;
  if (/^(no-verify|require|preferred)$/i.test(ssl ?? '') || truthy(q.get('tlsAllowInvalidCertificates')) || q.get('rejectUnauthorized') === 'false' || q.get('sslaccept') === 'accept_invalid_certs') options.verifyCert = false;
  if (truthy(q.get('allowLocalInfile') ?? q.get('local_infile'))) options.localInfile = true;
  if (truthy(q.get('allowPublicKeyRetrieval'))) options.getPublicKey = true;
  const timeout = Number(q.get('connect_timeout') ?? q.get('connectTimeout') ?? q.get('connectTimeoutMS') ?? '');
  if (timeout > 0) options.connectTimeout = timeout > 1000 ? Math.round(timeout / 1000) : timeout;

  // Local sockets: ?socket=/tmp/mysql.sock, ?host=/var/run/postgresql, unix:/path, or a %2F-encoded host.
  const socket = q.get('socket') ?? q.get('socketPath') ?? (q.get('host')?.startsWith('/') ? q.get('host') : null) ?? (host.startsWith('/') ? host : null);
  if (socket) return { ...base, method: 'socket', socket, host: 'localhost', port, user, password, database: database.split('/')[0], name: `${user || scheme.engine}@socket` };

  if (scheme.engine === 'redis' || scheme.engine === 'valkey') {
    // redis://:pass@host:6379/4 → db4
    const idx = database && /^\d+$/.test(database) ? `db${database}` : (q.get('db') ? `db${q.get('db')}` : '');
    return { ...base, host, port, user: user === 'default' ? '' : user, password, database: idx, name: `${host}${idx ? ` ${idx}` : ''}` };
  }
  if (scheme.engine === 'elasticsearch') database = '';
  if (scheme.engine === 'mongodb' && q.get('authSource') && !database) database = '';
  return { ...base, host, port, user, password, database, name: `${user ? `${user}@` : ''}${host}${database ? `/${database}` : ''}` };
}
