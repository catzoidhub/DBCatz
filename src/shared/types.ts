/**
 * DBCatz — shared types between the main process, the preload bridge and the
 * window. The viewer types came from DevCatz's database viewer and are kept
 * in step with it by hand.
 */

import { keyLabel } from './platform';

export type DbEngine = 'mysql' | 'mariadb' | 'postgresql' | 'redis' | 'valkey' | 'mongodb' | 'elasticsearch' | 'sqlite';

/** A database service DevCatz runs, as it writes them for DBCatz (services.json). */
export interface DevCatzService {
  id: string;
  name: string;
  engine: DbEngine;
  version: string;
  host: string;
  port: number;
  user: string;
  password: string;
  /** SQLite: the folder of database files. */
  dataDir: string;
  socket: string;
  running: boolean;
}
export interface DevCatzServicesFile {
  version: 1;
  app: 'DevCatz';
  /** When DevCatz last wrote it (ms). */
  written: number;
  services: DevCatzService[];
}

export type Theme = 'system' | 'light' | 'dark';

/** DBCatz's settings (Settings page); kept in config.json, checked in the main process. */
export interface DbCatzSettings {
  theme: Theme;
  ai: DvAiSettings;
}

/** Who writes queries for Ask AI. `openai-compatible` is any server speaking OpenAI's /chat/completions (LM Studio, vLLM, a company gateway). */
export type DvAiProvider = 'anthropic' | 'openai' | 'gemini' | 'zai' | 'deepseek' | 'mistral' | 'xai' | 'groq' | 'openrouter' | 'ollama' | 'openai-compatible';
export interface DvAiProviderInfo {
  id: DvAiProvider;
  name: string;
  /** Where its API key is made (empty: no key needed). */
  keyUrl: string;
  /** API base URL; editable for Z.ai (China: open.bigmodel.cn), Ollama and OpenAI-compatible. */
  baseUrl: string;
  /** Models offered before the list is loaded from the provider; the first is the default. */
  models: string[];
}
export const DV_AI_PROVIDERS: DvAiProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { id: 'openai', name: 'OpenAI (GPT)', keyUrl: 'https://platform.openai.com/api-keys', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'] },
  { id: 'gemini', name: 'Google (Gemini)', keyUrl: 'https://aistudio.google.com/apikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'zai', name: 'Z.ai (GLM)', keyUrl: 'https://z.ai/manage-apikey/apikey-list', baseUrl: 'https://api.z.ai/api/paas/v4', models: ['glm-5.3', 'glm-5.2'] },
  { id: 'deepseek', name: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'mistral', name: 'Mistral', keyUrl: 'https://console.mistral.ai/api-keys', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'codestral-latest'] },
  { id: 'xai', name: 'xAI (Grok)', keyUrl: 'https://console.x.ai', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-3-mini'] },
  { id: 'groq', name: 'Groq', keyUrl: 'https://console.groq.com/keys', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
  { id: 'openrouter', name: 'OpenRouter (many models)', keyUrl: 'https://openrouter.ai/keys', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro'] },
  { id: 'ollama', name: 'Ollama (local, offline)', keyUrl: '', baseUrl: 'http://localhost:11434', models: ['qwen2.5-coder', 'llama3.1'] },
  { id: 'openai-compatible', name: 'OpenAI-compatible server', keyUrl: '', baseUrl: 'http://localhost:1234/v1', models: [] },
];
export const aiProvider = (id: DvAiProvider) => DV_AI_PROVIDERS.find((p) => p.id === id) ?? DV_AI_PROVIDERS[0];
export interface DvAiSettings {
  enabled: boolean;
  provider: DvAiProvider;
  /** The chosen model per provider (a listed one or any id the provider knows). */
  models: Partial<Record<DvAiProvider, string>>;
  /** Base URL overrides (Ollama, OpenAI-compatible). */
  baseUrls: Partial<Record<DvAiProvider, string>>;
  /** Providers with an API key stored (encrypted); keys never reach the window. */
  keys: DvAiProvider[];
  /** Connections whose sample rows / values may go with the structure (off by default; DBCatz's own, not shared). */
  samples: string[];
  /** AI features switched off (each is on while AI is on; DBCatz's own, not shared). */
  off: DvAiFeature[];
}
export const DV_AI_DEFAULTS: DvAiSettings = { enabled: false, provider: 'anthropic', models: {}, baseUrls: {}, keys: [], samples: [], off: [] };
/** DBCatz's AI features, each with its own switch in Settings → AI (like DevCatz's). */
export type DvAiFeature = 'query' | 'logs' | 'ask';
export const DV_AI_FEATURES: { id: DvAiFeature; label: string; hint: string; sends: string }[] = [
  { id: 'query', label: `Ask AI in the Query tab (${keyLabel('mod+shift+K')})`, hint: 'Plain words become a query, follow-ups, Fix with AI on a failed statement.', sends: 'the structure of the open database (tables, columns, keys, indexes; Redis key patterns), sample values only with Send samples on' },
  { id: 'logs', label: 'Ask AI in Logs', hint: 'Explains an error or a slow statement in the connection’s log and writes the fixed query.', sends: 'the log lines you ask about (statements, errors, timing; obvious secrets masked) and the structure of the tables they use' },
  { id: 'ask', label: `Ask DBCatz (${keyLabel('mod+K')})`, hint: 'The ✦ button: plain-word commands turned into DBCatz steps you run one by one.', sends: 'connection names, engines and modes, where you are, the open database’s tables — no hosts, users, passwords or rows' },
];

/** Ask AI in Logs: some log lines and, optionally, a question about them. */
export interface DvLogEntry {
  text: string;
  error: string | null;
  ms: number | null;
  affected: number | null;
}
export interface DvLogRequest {
  db: string;
  entries: DvLogEntry[];
  /** e.g. "why is this slow?" (empty: explain the errors). */
  prompt: string;
}
export interface DvLogAnswer {
  /** What happened, one or two sentences. */
  summary: string;
  /** Why, in plain words. */
  cause: string;
  /** What to do, step by step. */
  steps: string[];
  /** The fixed (or faster) statement, '' when there is none; opened in the Query tab, never run. */
  query: string;
}
export type DbCatzSettingsPatch = { theme?: Theme; ai?: Partial<Omit<DvAiSettings, 'keys'>> };

/** Progress of a long task shown in the window (a shape DevCatz uses too). */
export interface TaskProgress {
  kind: string;
  title: string;
  steps: string[];
  step: number;
  detail?: string;
  done?: boolean;
  error?: string;
  cancelled?: boolean;
}

// ------------------------------------------------------------ Database viewer

/** Every DevCatz database engine; SQL ones get the grid, Redis / Valkey a key browser, MongoDB / Elasticsearch a document grid. */
export type DvEngine = DbEngine;
export const DV_SQL: DvEngine[] = ['mysql', 'mariadb', 'postgresql', 'sqlite'];
export const DV_DOCUMENT: DvEngine[] = ['mongodb', 'elasticsearch'];
export const DV_KEYVALUE: DvEngine[] = ['redis', 'valkey'];

/** How DBCatz reaches a server. */
export type DvMethod = 'tcp' | 'socket' | 'ssh' | 'aws-iam' | 'vault';
export const DV_METHOD_NAME: Record<DvMethod, string> = { tcp: 'TCP/IP', socket: 'Socket', ssh: 'SSH', 'aws-iam': 'AWS IAM', vault: 'Vault' };

/** Connection options (the MySQL-specific ones are ignored by other engines). */
export interface DvOptions {
  /** MySQL / MariaDB: LOAD DATA LOCAL INFILE (lets the server read client files: insecure). */
  localInfile: boolean;
  /** MySQL / MariaDB: mysql_clear_password (sends the password as is: insecure without SSL). */
  cleartext: boolean;
  /** TLS to the server (MySQL ssl, PostgreSQL sslmode=require, rediss, Mongo tls, https). */
  requireSsl: boolean;
  /** With SSL: check the server certificate (off for self-signed). */
  verifyCert: boolean;
  /** MySQL 8 caching_sha2_password without SSL: ask the server for its RSA public key. */
  getPublicKey: boolean;
  /** MongoDB: mongodb+srv:// (host is the SRV name). */
  srv: boolean;
  /** Seconds before a connection attempt gives up. */
  connectTimeout: number;
  /** Normal, Production (asks before writes) or Read-only (refuses writes). */
  mode: DvMode;
  /** Session time zone: '' = the server's; '+07:00' or a name like Asia/Jakarta (MySQL needs its time zone tables for names). */
  timeZone: string;
}
export const DV_DEFAULT_OPTIONS: DvOptions = { localInfile: false, cleartext: false, requireSsl: false, verifyCert: true, getPublicKey: true, srv: false, connectTimeout: 15, timeZone: '', mode: 'normal' };

export interface DvSsh {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key' | 'agent';
  /** Private key file (auth = key). */
  keyPath: string;
}
export interface DvAws {
  region: string;
  /** A profile in ~/.aws (empty: the access key below, or the environment). */
  profile: string;
  accessKeyId: string;
}
export interface DvVault {
  /** https://vault.example.com:8200 */
  addr: string;
  /** e.g. database/creds/readonly (dynamic) or secret/data/app/db (KV v2). */
  path: string;
  namespace: string;
}

export type DvOptionKey = 'localInfile' | 'cleartext' | 'requireSsl' | 'getPublicKey';
/** Which options an engine + method takes: true, or why not (shown on the disabled toggle). */
export function dvOptionSupport(engine: DbEngine, method: DvMethod): Record<DvOptionKey, true | string> {
  const mysql = engine === 'mysql' || engine === 'mariadb';
  const only = (why: string) => why;
  const notMysql = only('MySQL / MariaDB only');
  if (method === 'aws-iam') {
    const forced = only('AWS IAM always uses SSL and the cleartext plugin');
    return { localInfile: mysql ? true : notMysql, cleartext: forced, requireSsl: forced, getPublicKey: only('Not used with AWS IAM') };
  }
  if (method === 'socket') {
    const local = only('Not used over a local socket');
    return { localInfile: mysql ? true : notMysql, cleartext: mysql ? true : notMysql, requireSsl: local, getPublicKey: mysql ? local : notMysql };
  }
  return { localInfile: mysql ? true : notMysql, cleartext: mysql ? true : notMysql, requireSsl: engine === 'sqlite' ? only('SQLite is a file') : true, getPublicKey: mysql ? true : notMysql };
}
/** Methods an engine can use. */
export function dvMethods(engine: DbEngine): DvMethod[] {
  if (engine === 'sqlite') return [];
  if (engine === 'mysql' || engine === 'mariadb' || engine === 'postgresql') return ['tcp', 'socket', 'ssh', 'aws-iam', 'vault'];
  if (engine === 'elasticsearch') return ['tcp', 'ssh', 'vault'];
  return ['tcp', 'socket', 'ssh', 'vault'];
}

/** Progress of a connection attempt (test or connect), for the window. */
export interface DvConnectProgress {
  token: string;
  steps: string[];
  step: number;
  detail: string;
  /** The attempt ended: ok, or the error. */
  done: boolean;
  error: string | null;
}

/** A connection of the database viewer: a DevCatz database service (live settings) or one saved by the user. */
export interface DvConnection {
  id: string;
  name: string;
  engine: DvEngine;
  host: string;
  port: number;
  user: string;
  /** A password is stored (encrypted); never sent to the window. */
  hasPassword: boolean;
  /** Database to open first (PostgreSQL connects to one database at a time). */
  database: string;
  /** SQLite: the folder of .sqlite files (DevCatz service) or one file (saved connection). */
  file: string;
  /** The DevCatz service this connection belongs to (null = saved by the user). */
  serviceId: string | null;
  /** Running (services) / reachable is checked on connect. */
  running: boolean;
  /** Accent colour of the tab (saved connections). */
  color: string | null;
  method: DvMethod;
  /** Socket path (method socket; PostgreSQL: the socket folder or file). */
  socket: string;
  ssh: DvSsh | null;
  aws: DvAws | null;
  vault: DvVault | null;
  options: DvOptions;
  /** Stored secrets (encrypted, never sent to the window). */
  hasSshSecret: boolean;
  hasAwsSecret: boolean;
  hasVaultToken: boolean;
  /** Made from a URL for this session only (not saved). */
  temporary: boolean;
  /** DBCatz holds an open connection (driver / tunnel) to it. */
  connected: boolean;
}

/** How the DBCatz connection list is arranged: drag-and-drop order, favorites, the user's groups. */
export interface DvLayout {
  order: string[];
  favorites: string[];
  groups: { name: string; members: string[]; collapsed: boolean }[];
}

export interface DvConnectionInput {
  id?: string;
  name: string;
  engine: DvEngine;
  host: string;
  port: number;
  user: string;
  /** null keeps the stored one (edit); '' = no password. */
  password: string | null;
  database: string;
  file: string;
  color: string | null;
  method?: DvMethod;
  socket?: string;
  ssh?: DvSsh | null;
  aws?: DvAws | null;
  vault?: DvVault | null;
  options?: DvOptions;
  /** SSH password or key passphrase; null keeps the stored one. */
  sshSecret?: string | null;
  /** AWS secret access key; null keeps the stored one. */
  awsSecret?: string | null;
  vaultToken?: string | null;
  /** Keep only for this session (a connection opened from a URL). */
  temporary?: boolean;
}

export interface DvTable {
  name: string;
  type: 'table' | 'view';
  /** Estimated rows and size when the engine reports them. */
  rows: number | null;
  size: number | null;
}

export interface DvColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  key: boolean;
  autoIncrement: boolean;
  comment: string | null;
  extra: string | null;
  /** Text columns: character set (MySQL) and collation (MySQL, PostgreSQL, SQLite) when known. */
  charset?: string | null;
  collation?: string | null;
  /** Allowed values when the type is an enum the type name does not spell out (PostgreSQL enum types). */
  options?: string[];
}

export interface DvIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface DvForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface DvStructure {
  columns: DvColumn[];
  indexes: DvIndex[];
  foreignKeys: DvForeignKey[];
  primaryKey: string[];
  /** CREATE statement of the table / view. */
  ddl: string;
}

/** A WHERE clause (or document filter) kept under a name for one table. */
export interface DvSavedFilter {
  id: string;
  name: string;
  where: string;
}

/** How one table's grid is shown: column widths (px) and order, and its saved filters. */
export interface DvGridPrefs {
  widths: Record<string, number>;
  /** Column names in display order; columns not listed follow in their own order. */
  order: string[];
  filters: DvSavedFilter[];
}

export interface DvRowsQuery {
  offset: number;
  limit: number;
  orderBy: string | null;
  desc: boolean;
  /** A WHERE clause written by the user (without WHERE). */
  where: string;
}

export interface DvRows {
  columns: string[];
  rows: unknown[][];
  total: number;
  primaryKey: string[];
  ms: number;
}

export interface DvResult {
  statement: string;
  columns: string[];
  rows: unknown[][];
  /** Rows changed by a write. */
  affected: number | null;
  ms: number;
  error: string | null;
}

export interface DvColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  primary: boolean;
  autoIncrement: boolean;
  /** A single-column UNIQUE index (create table / add column). */
  unique?: boolean;
  /** Text columns: '' = the table's default. MySQL: both; PostgreSQL / SQLite: collation only. */
  charset?: string;
  collation?: string;
  /** Column comment ('' = none; SQLite has none). */
  comment?: string;
}

/** One finding of DBCatz's check before a structure change. */
export interface DvRiskItem {
  /** warn: shown; danger: needs the name typed; block: not allowed from here. */
  level: 'warn' | 'danger' | 'block';
  title: string;
  detail: string;
}
export interface DvRisk {
  level: 'none' | 'warn' | 'danger' | 'block';
  items: DvRiskItem[];
  /** What to type to go ahead with a danger (the column / index / table name). */
  confirmWord: string;
}

/** Connection safety: Production asks before every write; Read-only refuses them (also at the server session). */
export type DvMode = 'normal' | 'production' | 'readonly';

export type DvAlterOp =
  | { op: 'addColumn'; column: DvColumnDef; after?: string | null }
  | { op: 'dropColumn'; name: string }
  | { op: 'renameColumn'; from: string; to: string }
  | { op: 'modifyColumn'; column: DvColumnDef }
  | { op: 'addIndex'; name: string; columns: string[]; unique: boolean }
  | { op: 'dropIndex'; name: string }
  | { op: 'renameTable'; to: string };

/** sql / dot are for SQL engines; json is NDJSON for documents and keys; redis is a redis-cli script (SET / RPUSH …). */
export type DvExportFormat = 'sql' | 'csv' | 'json' | 'xml' | 'dot' | 'redis';

export interface DvExportOptions {
  database: string;
  tables: string[];
  format: DvExportFormat;
  /** SQL: CREATE statements / INSERT rows / DROP IF EXISTS first. */
  structure: boolean;
  data: boolean;
  dropFirst: boolean;
}

export interface DvImportOptions {
  database: string;
  /** sql (also .sql.gz and DevCatz .tar.gz backups), csv into `table`, json (NDJSON) into a collection / index, redis (a redis-cli script). */
  format: 'sql' | 'csv' | 'json' | 'redis';
  table: string;
  /** CSV: the first row names the columns. */
  header: boolean;
}

/** A long viewer job (export, import, backup) with progress for the window. */
export interface DvJob {
  id: string;
  title: string;
  detail: string;
  done: number;
  total: number;
  finished: boolean;
  error: string | null;
  /** Where the result was written. */
  path: string | null;
  /** The connection it works on (an import refreshes its tables when done). */
  connId: string;
  kind: 'export' | 'import' | 'backup';
  /** Stopped with Cancel (error says what is left). */
  cancelled?: boolean;
}

/** One Redis / Valkey key as listed. */
export interface DvKey {
  key: string;
  type: string;
  /** Seconds, -1 = no expiry. */
  ttl: number;
  /** Elements (list / hash / set / zset), bytes (string). */
  size: number;
}

/** A Redis / Valkey key with its value: string, list (string[]), hash / zset ([field, value][]), set (string[]), stream / json (JSON text). */
export interface DvKeyValue extends DvKey {
  value: string | string[] | [string, string][];
  /** Elements shown out of `size` (large values are cut). */
  shown: number;
}

export interface DvKeyInput {
  key: string;
  type: 'string' | 'list' | 'set' | 'hash' | 'zset';
  value: string | string[] | [string, string][];
  /** Seconds; null / -1 keeps the key forever. */
  ttl: number | null;
}

/** What a bulk drop / truncate did: the tables done, and the ones that failed (or were skipped) and why. */
export interface DvBulkResult {
  done: string[];
  failed: { table: string; error: string }[];
}

/** Character sets / encodings and collations a server offers for a new database. */
export interface DvCharsets {
  charsets: { name: string; collation: string; description: string }[];
  collations: { name: string; charset: string }[];
}

/** A query the user keeps for a connection. */
export interface DvSavedQuery {
  id: string;
  name: string;
  text: string;
  /** Last change, ms. */
  updated: number;
  /** Saved before queries were kept per database: listed in every database of the connection until saved again. */
  anyDb?: boolean;
}

/** Databases picked lately and the ones starred, per connection (the database picker). */
export interface DvDbPrefs {
  recent: string[];
  favorites: string[];
}

/** One turn of an Ask AI thread (the user's words, or the query the model wrote). */
export interface DvAiTurn {
  role: 'user' | 'assistant';
  text: string;
}
export interface DvAiRequest {
  prompt: string;
  /** Earlier turns of the same thread, oldest first. */
  history: DvAiTurn[];
  /** Fix with AI: the statement that failed and the server's error. */
  failed?: { statement: string; error: string };
}
export interface DvAiAnswer {
  /** The query, for the editor (never run by DBCatz on its own). */
  query: string;
  /** Which tables / columns, why that join. */
  explanation: string;
  tables: string[];
  /** The model could not answer from this schema; `explanation` says why. */
  unanswerable: boolean;
}
/** What Ask DBCatz can do (the ✦ button): only these, each checked before it runs and run only on a click. */
export type DvAskKind =
  | 'open-connection' | 'open-database' | 'open-table' | 'filter-rows' | 'open-keys' | 'open-logs' | 'refresh'
  | 'write-query' | 'run-query'
  | 'export' | 'backup' | 'import' | 'open-jobs'
  | 'create-database' | 'create-table' | 'rename-table'
  | 'truncate-table' | 'drop-table' | 'drop-database' | 'flush-keys'
  | 'new-connection' | 'edit-connection' | 'disconnect' | 'open-devcatz'
  | 'set-theme' | 'open-settings';
export const DV_ASK_KINDS: DvAskKind[] = ['open-connection', 'open-database', 'open-table', 'filter-rows', 'open-keys', 'open-logs', 'refresh', 'write-query', 'run-query', 'export', 'backup', 'import', 'open-jobs', 'create-database', 'create-table', 'rename-table', 'truncate-table', 'drop-table', 'drop-database', 'flush-keys', 'new-connection', 'edit-connection', 'disconnect', 'open-devcatz', 'set-theme', 'open-settings'];
/** Steps that remove data or structure: shown red, explained first, then DBCatz's typed confirmation. */
export const DV_ASK_DESTRUCTIVE: DvAskKind[] = ['truncate-table', 'drop-table', 'drop-database', 'flush-keys'];
/** Steps that change a database (refused on Read-only connections before anything opens). */
export const DV_ASK_WRITES: DvAskKind[] = ['import', 'create-database', 'create-table', 'rename-table', ...DV_ASK_DESTRUCTIVE];
/** Every argument an action kind may take (all strings; lists comma-separated). */
export const DV_ASK_ARGS = ['database', 'table', 'view', 'where', 'query', 'format', 'tables', 'databases', 'name', 'tab', 'pattern', 'theme'] as const;
export interface DvAskAction {
  kind: DvAskKind;
  /** Button text, e.g. "Open orders on Shop (production)". */
  label: string;
  /** The connection id it applies to (the open one when empty). */
  connection?: string;
  args: Partial<Record<(typeof DV_ASK_ARGS)[number], string>>;
}
export interface DvAskRequest {
  prompt: string;
  history: DvAiTurn[];
  /** Where the user is: the open tab's connection, database, table and view (empty on the Connections tab). */
  where: { connId?: string; db?: string; table?: string; view?: string };
}
export interface DvAskAnswer {
  /** What will happen, or the answer when nothing needs doing. */
  explanation: string;
  actions: DvAskAction[];
}

/** A step of a running Ask AI request (viewer:aiProgress). */
export interface DvAiProgress {
  token: string;
  step: number;
  steps: number;
  text: string;
  /** While the answer streams in: the query and explanation so far. */
  draft?: { query: string; explanation: string };
}
/** Exactly what Ask AI sends for a request (Preview what is sent). */
export interface DvAiPreview {
  provider: string;
  model: string;
  /** Instructions and the schema of the database, as sent. */
  system: string;
  /** Big schemas: the table list goes first, the chosen tables' structure in a second request. */
  staged: boolean;
  messages: DvAiTurn[];
}

/** Settings → About (Catzoid family #62): the build, and the shared site address the links are built from. */
export interface AboutInfo {
  version: string;
  arch: string;
  macos: string;
  electron: string;
  chrome: string;
  node: string;
  /** The shared Catzoid site address (Catzoid/shared.json `site`), e.g. https://catzoid.com — no trailing slash. */
  site: string;
  dataDir: string;
}

// ------------------------------------------------------------ updates and uninstall (Catzoid family #54 / #55)

export type DvUpdateChannel = 'stable' | 'beta';
export interface DvUpdateSettings {
  /** Check 30 s after launch and every 6 h. */
  auto: boolean;
  /** A notification when the automatic check finds a version (once per version). */
  notify: boolean;
  channel: DvUpdateChannel;
  /** "Skip this version": the automatic check stays quiet about it. */
  skipped: string;
}
export interface DvUpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'error';
  /** The installed version. */
  current: string;
  /** The version found. */
  version?: string;
  /** Release notes of every version in between (Markdown or HTML from the feed, newest first). */
  notes?: string;
  /** Download size in bytes. */
  size?: number;
  releaseDate?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  error?: string;
  /** When the last check ended (ms). */
  lastChecked?: number;
  /** Where the answer came from: the Catzoid site's feed or the GitHub release (fallback). */
  source?: 'site' | 'github';
  /** The check was asked for (menu / Check now), so "up to date" and errors are shown. */
  manual?: boolean;
  settings: DvUpdateSettings;
  /** Where "Download from the site" goes: <site>/download/dbcatz/<platform>. */
  downloadUrl: string;
}
export interface DvUninstallPlan {
  /** What goes, in plain words, with its path (or Keychain item). */
  items: { label: string; path: string }[];
  /** The settings shared with the other Catzoid apps (shared.json + the "Catzoid AI" Keychain items). */
  shared: { label: string; path: string }[];
  /** Other Catzoid apps still on this Mac: the shared settings stay unless the user ticks them. */
  otherApps: string[];
  /** Installed through Homebrew: `brew uninstall --cask dbcatz` runs too. */
  homebrew: boolean;
  /** Tests (DBCATZ_UNINSTALL_DRY) and unpackaged builds: nothing is removed. */
  dryRun: boolean;
}

/** Report a Bug / Send Feedback (Catzoid #65): what the user means. */
export type DvReportKind = 'bug' | 'idea' | 'question';
/** The body of `POST <site>/api/reports` (the Catzoid API's ReportInput). */
export interface DvReport {
  type: 'crash' | 'error' | 'feedback';
  app: 'dbcatz';
  version: string;
  channel?: string;
  os: string;
  osVersion?: string;
  arch?: string;
  platform?: string;
  message: string;
  stack?: string;
  installId?: string;
  email?: string;
  process?: string;
  extra?: Record<string, unknown>;
  /** Screenshots on a bug report (Catzoid #67): sent as multipart `image` parts, never in the JSON. */
  shots?: ReportShot[];
  /** Preview only: how many screenshots would go with it. */
  screenshots?: string;
}
/** A screenshot attached to a bug report (Catzoid #67): PNG or JPEG, base64, already re-encoded in the window. */
export interface ReportShot {
  type: 'image/png' | 'image/jpeg';
  data: string;
}
export interface DvReportSettings {
  /** Send crash reports: null until asked (after the first error). */
  crash: boolean | null;
  /** Reports waiting for the network. */
  queued: number;
}

// ------------------------------------------------------------ API (preload bridge)

export interface DbCatzApi {
  /**
   * App version; whether DevCatz has been on this Mac (its app or its services file), its app's path (null when the
   * app is gone, even if its services file is left behind), the shared Catzoid site address and this computer's
   * platform as the site's download links name it (mac-arm64, mac-x64, win-x64; '' when there is no build for it).
   */
  appInfo(): Promise<{ version: string; devcatz: boolean; devcatzPath: string | null; site: string; platform: string }>;
  /** Version, platform and the shared site address, for Settings → About. */
  aboutInfo(): Promise<AboutInfo>;
  /** In-app updates (Catzoid #54): the current state; changes arrive through onUpdate. */
  updateState(): Promise<DvUpdateState>;
  /** Check now (manual: "up to date" and errors are shown). */
  updateCheck(): Promise<DvUpdateState>;
  updateDownload(): Promise<void>;
  updateCancel(): Promise<void>;
  /** Skip this version: the automatic check stays quiet about it. */
  updateSkip(version: string): Promise<DvUpdateState>;
  /** Restart now, or install when DBCatz quits. */
  updateInstall(now: boolean): Promise<void>;
  updateConfigure(patch: Partial<DvUpdateSettings>): Promise<DvUpdateState>;
  /** What Report a Bug / Send Feedback would send (Preview what is sent). */
  reportPreview(kind: DvReportKind, message: string, email: string, shots?: number): Promise<DvReport>;
  /** Sends it now, or keeps it for later when the site cannot be reached. */
  reportSend(kind: DvReportKind, message: string, email: string, shots?: ReportShot[]): Promise<'sent' | 'queued'>;
  /** The window as a PNG (base64), for "Capture this window" in Report a Bug (the dialog hides itself first). */
  captureWindow(): Promise<string>;
  /** An uncaught error in the window (sent only with Send crash reports on). */
  reportError(message: string, stack: string): Promise<void>;
  reportSettings(): Promise<DvReportSettings>;
  reportConfigure(crash: boolean): Promise<DvReportSettings>;
  /** Uninstall DBCatz (Catzoid #55): what would go. */
  uninstallPlan(): Promise<DvUninstallPlan>;
  /** Removes DBCatz (confirm = "DBCatz"); with `shared`, the settings shared with the Catzoid apps too. Quits. */
  uninstallRun(confirm: string, shared: boolean): Promise<DvUninstallPlan>;
  settings(): Promise<DbCatzSettings>;
  /** Changes some settings (checked and applied at once); returns them all. */
  setSettings(patch: DbCatzSettingsPatch): Promise<DbCatzSettings>;
  /** Stores a provider's API key encrypted; '' removes it. */
  setAiKey(provider: DvAiProvider, key: string): Promise<DbCatzSettings>;
  /** Models the provider offers (asked from its API with the stored key). */
  aiModels(provider: DvAiProvider): Promise<string[]>;
  /** Which of these models answer with the provider's stored key (null = works, else why not); one tiny request each. */
  aiProbe(provider: DvAiProvider, models: string[]): Promise<Record<string, string | null>>;
  /** A tiny request to the chosen provider / model: resolves with what answered. */
  aiTest(): Promise<string>;
  /** Writes a query for the request from the database's structure (no rows are sent). */
  aiAsk(connId: string, database: string, request: DvAiRequest, token?: string): Promise<DvAiAnswer>;
  /** Ask DBCatz (✦): plain words → DBCatz actions, none run here. */
  aiAskDbcatz(request: DvAskRequest, token?: string): Promise<DvAskAnswer>;
  aiPreviewAskDbcatz(request: DvAskRequest): Promise<DvAiPreview>;
  /** Ask AI in Logs: explains log lines (errors, slow statements) and writes the fixed query. */
  aiExplainLog(connId: string, request: DvLogRequest, token?: string): Promise<DvLogAnswer>;
  aiPreviewLog(connId: string, request: DvLogRequest): Promise<DvAiPreview>;
  /** Stops the Ask AI request started with `token`. */
  aiCancel(token: string): Promise<void>;
  aiPreview(connId: string, database: string, request: DvAiRequest): Promise<DvAiPreview>;
  /** Drops the cached schema (after ↻ or a structure change). */
  aiForget(connId: string, database: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  pickFile(title: string): Promise<string | null>;
  /** Opens DevCatz at a database service (devcatz://db/<id>) when it is installed. */
  openInDevCatz(serviceId: string): Promise<boolean>;
  // Database viewer
  dvConnections(): Promise<DvConnection[]>;
  dvSaveConnection(input: DvConnectionInput): Promise<DvConnection>;
  dvDeleteConnection(id: string): Promise<void>;
  /** Connects with these settings and returns the server version; progress as viewer:progress events for `token`. */
  dvTestConnection(input: DvConnectionInput, token?: string): Promise<string>;
  dvServerInfo(connId: string, token?: string): Promise<{ version: string; user: string }>;
  /** Stops a connection attempt (test or connect) started with `token`. */
  dvCancelConnect(token: string): Promise<void>;
  /** Closes the open connection (driver, SSH tunnel); tabs show Reconnect. */
  dvDisconnect(connId: string): Promise<void>;
  dvLayout(): Promise<DvLayout>;
  dvSetLayout(layout: DvLayout): Promise<DvLayout>;
  /** Profiles in ~/.aws/credentials and ~/.aws/config. */
  dvAwsProfiles(): Promise<string[]>;
  /** Private keys in ~/.ssh. */
  dvSshKeys(): Promise<string[]>;
  dvDatabases(connId: string): Promise<string[]>;
  dvTables(connId: string, database: string): Promise<DvTable[]>;
  dvStructure(connId: string, database: string, table: string): Promise<DvStructure>;
  dvRows(connId: string, database: string, table: string, query: DvRowsQuery): Promise<DvRows>;
  /** Changes one row, found by its primary key. */
  dvUpdateRow(connId: string, database: string, table: string, key: Record<string, unknown>, changes: Record<string, unknown>): Promise<void>;
  dvInsertRow(connId: string, database: string, table: string, values: Record<string, unknown>): Promise<void>;
  dvDeleteRows(connId: string, database: string, table: string, keys: Record<string, unknown>[]): Promise<number>;
  /** Runs one or more statements; each gets its own result. */
  dvQuery(connId: string, database: string, sql: string): Promise<DvResult[]>;
  /** MySQL / MariaDB: character set + collation; PostgreSQL: encoding + LC_COLLATE (from template0). */
  dvCreateDatabase(connId: string, name: string, options?: { charset: string; collation: string }): Promise<void>;
  dvCharsets(connId: string): Promise<DvCharsets>;
  /** `confirm` must repeat the database name. */
  dvDropDatabase(connId: string, name: string, confirm: string): Promise<void>;
  dvCreateTable(connId: string, database: string, table: string, columns: DvColumnDef[]): Promise<void>;
  /** What could go wrong with these changes (primary key, foreign keys, values that would not fit …). */
  dvAlterCheck(connId: string, database: string, table: string, ops: DvAlterOp[]): Promise<DvRisk>;
  /** `confirm` repeats the check's confirmWord when it found a danger; blocked changes are refused. */
  dvAlterTable(connId: string, database: string, table: string, ops: DvAlterOp[], confirm?: string): Promise<void>;
  /** `confirm` must repeat the table name. */
  dvDropTable(connId: string, database: string, table: string, confirm: string): Promise<void>;
  dvTruncateTable(connId: string, database: string, table: string, confirm: string): Promise<void>;
  /**
   * Several tables at once (the sidebar's selection). `confirm` repeats the database name (Production: the
   * connection name); `force` turns the integrity checks off (FOREIGN_KEY_CHECKS / CASCADE / foreign_keys).
   */
  dvDropTables(connId: string, database: string, tables: string[], confirm: string, force: boolean): Promise<DvBulkResult>;
  dvTruncateTables(connId: string, database: string, tables: string[], confirm: string, force: boolean): Promise<DvBulkResult>;
  /** Column types offered by the table editor for the engine. */
  dvTypes(connId: string): Promise<string[]>;
  /** Asks where to save, then starts the job and resolves with the path at once (null = cancelled); it runs on in the background, progress in dvJobs. */
  dvExport(connId: string, options: DvExportOptions): Promise<string | null>;
  /** Asks for the file, then starts importing into the database / table in the background (resolves with the file). */
  dvImport(connId: string, options: DvImportOptions): Promise<string | null>;
  /** SQL dumps of the databases in one .tar.gz (asks where to save; runs in the background). */
  dvBackup(connId: string, databases: string[]): Promise<string | null>;
  dvJobs(): Promise<DvJob[]>;
  /** Removes finished jobs from the list (these ids, or every finished one); running jobs stay. */
  dvClearJobs(ids?: string[]): Promise<DvJob[]>;
  /** Stops a running job at its next progress step (a partial export / backup file is removed). */
  dvCancelJob(id: string): Promise<void>;
  dvReveal(path: string): Promise<void>;
  /** Native context menu of a table; the choice comes back as a viewer command. */
  dvTableMenu(table: string, kind: 'table' | 'view' | 'collection' | 'index', selection?: { tables: string[]; readOnly: boolean; sql: boolean }): Promise<void>;
  /** Asks for a SQLite file or folder for a new connection. */
  dvPickSqlite(): Promise<string | null>;
  /** Opens DBCatz at a connection (`svc:<service id>` / saved id); null = the New connection screen. */
  dvOpen(connId: string | null, database?: string): Promise<void>;
  /** Redis / Valkey: keys matching a glob (SCAN), at most `limit`, with the count found. */
  dvKeys(connId: string, database: string, pattern: string, limit: number): Promise<{ keys: DvKey[]; total: number }>;
  dvKey(connId: string, database: string, key: string): Promise<DvKeyValue>;
  /** Creates or replaces a key (the whole value) and sets its TTL. */
  dvKeySet(connId: string, database: string, input: DvKeyInput): Promise<void>;
  dvKeyDelete(connId: string, database: string, keys: string[]): Promise<number>;
  dvKeyRename(connId: string, database: string, from: string, to: string): Promise<void>;
  /** Flushes one logical database; `confirm` must repeat its name. */
  dvFlush(connId: string, database: string, confirm: string): Promise<void>;
  /** Saved queries of one database of a connection. */
  dvSavedQueries(connId: string, database: string): Promise<DvSavedQuery[]>;
  /** Adds (no id) or renames / rewrites a saved query of that database. */
  dvSaveQuery(connId: string, database: string, query: { id?: string; name: string; text: string }): Promise<DvSavedQuery>;
  dvDeleteQuery(connId: string, database: string, id: string): Promise<void>;
  /** Column widths / order and saved filters of a table's grid. */
  dvGridPrefs(connId: string, database: string, table: string): Promise<DvGridPrefs>;
  dvSetGridPrefs(connId: string, database: string, table: string, prefs: DvGridPrefs): Promise<DvGridPrefs>;
  dvDbPrefs(connId: string): Promise<DvDbPrefs>;
  /** Records a database as just picked (recent) and / or stars it. */
  dvSetDbPrefs(connId: string, prefs: DvDbPrefs): Promise<DvDbPrefs>;
}

/** Every method of the bridge, registered as `dbcatz:<name>` IPC handlers. */
export const API_METHODS: (keyof DbCatzApi)[] = [
  'appInfo', 'aboutInfo', 'updateState', 'updateCheck', 'updateDownload', 'updateCancel', 'updateSkip', 'updateInstall', 'updateConfigure', 'reportPreview', 'reportSend', 'captureWindow', 'reportError', 'reportSettings', 'reportConfigure', 'uninstallPlan', 'uninstallRun', 'settings', 'setSettings', 'setAiKey', 'aiModels', 'aiProbe', 'aiTest', 'aiAsk', 'aiAskDbcatz', 'aiPreviewAskDbcatz', 'aiExplainLog', 'aiPreviewLog', 'aiCancel', 'aiPreview', 'aiForget', 'openUrl', 'pickFile', 'openInDevCatz',
  'dvConnections', 'dvSaveConnection', 'dvDeleteConnection', 'dvTestConnection', 'dvServerInfo', 'dvCancelConnect', 'dvDisconnect', 'dvLayout', 'dvSetLayout', 'dvAwsProfiles', 'dvSshKeys', 'dvDatabases', 'dvTables', 'dvStructure', 'dvRows', 'dvUpdateRow', 'dvInsertRow', 'dvDeleteRows', 'dvQuery', 'dvCreateDatabase', 'dvCharsets', 'dvDropDatabase', 'dvCreateTable', 'dvAlterCheck', 'dvAlterTable', 'dvDropTable', 'dvTruncateTable', 'dvDropTables', 'dvTruncateTables', 'dvTypes', 'dvExport', 'dvImport', 'dvBackup', 'dvJobs', 'dvClearJobs', 'dvCancelJob', 'dvReveal', 'dvTableMenu', 'dvPickSqlite', 'dvOpen', 'dvKeys', 'dvKey', 'dvKeySet', 'dvKeyDelete', 'dvKeyRename', 'dvFlush', 'dvSavedQueries', 'dvSaveQuery', 'dvDeleteQuery', 'dvGridPrefs', 'dvSetGridPrefs', 'dvDbPrefs', 'dvSetDbPrefs',
];
