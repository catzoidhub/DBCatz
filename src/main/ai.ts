import Anthropic from '@anthropic-ai/sdk';
import { aiProvider, DV_ASK_ARGS, DV_ASK_KINDS, DV_ASK_WRITES, DV_DOCUMENT, DV_KEYVALUE, DV_SQL, type DvAskAction, type DvAskAnswer, type DvAskRequest, type DvEngine, type DvLogAnswer, type DvLogRequest, type DvAiAnswer, type DvAiProgress, type DvAiPreview, type DvAiProvider, type DvAiRequest, type DvAiTurn, type DvStructure, type DvTable } from '@shared/types';
import type { DbViewerManager } from './dbviewer/manager';
import { rows as readRows } from './dbviewer/ops';
import { aiKey, needFeature, settings } from './settings';

/**
 * Ask AI: writes a query from plain words for one database. Only the
 * structure goes out (table and column names, types, keys, foreign keys,
 * indexes, estimated row counts), never rows, connection settings or
 * passwords. Big schemas go in two steps: the table list first (the model
 * picks the tables that matter), then those tables' structure. The answer is
 * a query for the editor; DBCatz never runs it on its own.
 */

const DIALECT: Record<string, string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgresql: 'PostgreSQL', sqlite: 'SQLite', redis: 'Redis', valkey: 'Valkey', mongodb: 'MongoDB', elasticsearch: 'Elasticsearch' };
/** What Ask AI writes for an engine. */
type Family = 'sql' | 'mongo' | 'es' | 'kv';
const familyOf = (engine: string): Family => (DV_KEYVALUE.includes(engine as DvEngine) ? 'kv' : engine === 'mongodb' ? 'mongo' : engine === 'elasticsearch' ? 'es' : 'sql');
/** Sample rows (when the connection allows them): rows per table, characters per value. */
const SAMPLE_ROWS = 3;
const SAMPLE_CHARS = 60;
const clip = (v: unknown, n = SAMPLE_CHARS) => {
  const t = v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
/** Redis / Valkey: key names read (SCAN) to see the key space; values are never read. */
const KEY_SAMPLE = 1000;
const PATTERN_LIMIT = 150;
/** Above this many tables the structure of every table is too much to send at once. */
const FULL_LIMIT = 60;
const PICK_LIMIT = 15;
const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 120_000;

interface Schema {
  at: number;
  version: string;
  tables: DvTable[];
  structures: Map<string, DvStructure>;
  /** Sample rows per table, as text lines (only when the connection allows samples). */
  samples: Map<string, string[]>;
}

/** Key names grouped into patterns (ids → *), with their type and how many were seen. */
interface Keyspace {
  at: number;
  version: string;
  scanned: number;
  total: number;
  patterns: { pattern: string; type: string; count: number; ttl: boolean; example: string }[];
  /** pattern → a sample value of its example key (only when the connection allows samples). */
  samples: Map<string, string>;
}

/** user:1042:cart → user:*:cart; long ids, uuids, hex and e-mails become * too. */
function patternOf(key: string): string {
  return key
    .split(/([:./|])/)
    .map((seg) => (/^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{32,36}$|@|^(?=.*\d)[\w-]{20,}$/i.test(seg) ? '*' : seg))
    .join('');
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The query, ready for the editor; empty when unanswerable' },
    explanation: { type: 'string', description: 'One to three short sentences: which tables and columns, why that join or filter' },
    tables: { type: 'array', items: { type: 'string' }, description: 'Tables the query uses' },
    unanswerable: { type: 'boolean', description: 'True when the schema has nothing that fits the request' },
  },
  required: ['query', 'explanation', 'tables', 'unanswerable'],
  additionalProperties: false,
};
const OK_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
/** Model ids that are not chat models (OpenAI, Gemini, Mistral, Groq … list them all together). */
const NOT_CHAT = /embed|whisper|tts|transcribe|dall-e|image|imagen|moderation|audio|realtime|rerank|ocr|speech|veo|aqa|guard/i;
const PICK_SCHEMA = {
  type: 'object',
  properties: { tables: { type: 'array', items: { type: 'string' } } },
  required: ['tables'],
  additionalProperties: false,
};

// ---- Ask DBCatz (the ✦ button): DBCatz actions from a fixed list
const ASK_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: DV_ASK_KINDS },
    label: { type: 'string', description: 'Button text, imperative, short' },
    connection: { type: 'string', description: 'Connection id from the list; empty for the open one' },
    // Every argument any kind takes ('' when unused): structured output needs a closed object.
    args: { type: 'object', properties: Object.fromEntries(DV_ASK_ARGS.map((k) => [k, { type: 'string' }])), required: [...DV_ASK_ARGS], additionalProperties: false },
  },
  required: ['kind', 'label', 'connection', 'args'],
  additionalProperties: false,
};
const ASK_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' }, actions: { type: 'array', items: ASK_ACTION_SCHEMA } },
  required: ['explanation', 'actions'],
  additionalProperties: false,
};
const ASK_HELP = [
  'Actions DBCatz can run (only these kinds; args are strings, "" when unused; a missing database means the open one):',
  'Moving around:',
  '- open-connection: {database?} — opens the connection\'s tab (connecting). open-database: {database}.',
  '- open-table: {database?, table, view: "data" | "structure"}.',
  '- filter-rows: {database?, table, where} — the Data grid filtered: SQL: the WHERE condition without the word WHERE; MongoDB: a JSON filter; Elasticsearch: a query_string. Not for Redis / Valkey.',
  '- open-keys: {database?, pattern} — Redis / Valkey: the keys matching a glob (user:*).',
  '- open-logs: {} — the server log and DBCatz activity. refresh: {} — reload databases and tables.',
  'Queries:',
  '- write-query: {database?, query} — a new Query editor with the query, not run (SQL, mongosh calls, Kibana-console requests or redis-cli lines, as the connection needs).',
  '- run-query: {database?, query} — the same, then Run. Reads run at once; anything that changes data is reviewed first and Production asks again; Read-only refuses changes.',
  'Files and jobs:',
  '- export: {database?, tables: "a,b" (empty = all), format: "sql" | "csv" | "json" | "xml" | "dot" | "redis"}; backup: {databases: "a,b"}; import: {database?, format: "sql" | "csv" | "json" | "redis"} — their dialogs, filled in. open-jobs: {}.',
  'Structure:',
  '- create-database: {name}; create-table: {database?, name}; rename-table: {database?, table, name} — their dialogs, filled in.',
  '- truncate-table / drop-table: {database?, table}; drop-database: {database}; flush-keys: {database} (Redis / Valkey) — DESTRUCTIVE: DBCatz explains what is lost, then its own dialog asks the user to type the name; DBCatz refuses a drop / truncate that foreign keys forbid.',
  'Connections and the app:',
  '- new-connection: {} — the new connection form. edit-connection: {} — the connection\'s form (not for DevCatz services). disconnect: {}.',
  '- open-devcatz: {} — opens the DevCatz app at this connection\'s service (its Database page, where it is started, stopped and configured). Only for connections marked as DevCatz services; propose it when such a service is stopped or the user asks to start, stop or change it. Never tell the user DBCatz cannot open DevCatz.',
  '- set-theme: {theme: "system" | "light" | "dark"} (shared with all Catzoid apps). open-settings: {tab: "appearance" | "ai" | "updates" | "about"} (appearance = General: theme, crash reports; About: version, links to catzoid.com, Report a bug, Uninstall).',
  'Safety:',
  '- READ-ONLY connections: only steps that read (open-*, filter-rows, write-query / run-query with reads, export, backup). Say that a change is not possible there.',
  '- PRODUCTION connections: prefer reading; propose a change only when the user clearly asks, and say in explanation that it is production.',
  '- Destructive steps (drop, truncate, flush; DELETE / UPDATE without WHERE) only when the user clearly asks for that very thing, never as a side step; name exactly what is lost in explanation. For deleting some rows, a run-query with a precise WHERE.',
];

// ---- Ask AI in Logs
const LOG_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What happened, one or two sentences' },
    cause: { type: 'string', description: 'Why, in plain words' },
    steps: { type: 'array', items: { type: 'string' }, description: 'What to do, step by step' },
    query: { type: 'string', description: 'The fixed or faster statement, ready for the Query tab; empty when there is none' },
  },
  required: ['summary', 'cause', 'steps', 'query'],
  additionalProperties: false,
};
/** Obvious secrets in logged statements: passwords and tokens in quotes, IDENTIFIED BY, AUTH, URLs with a password. */
export function maskSecrets(text: string): string {
  return text
    // IDENTIFIED BY 'x', PASSWORD 'x', AUTH x (Redis): the value right after the word.
    .replace(/\b(IDENTIFIED\s+(?:WITH\s+\S+\s+)?BY|PASSWORD|AUTH)(\s+)('[^']*'|"[^"]*"|(?![=:])\S+)/gi, '$1$2•••')
    .replace(/\b(\w*(?:pass(?:word)?|secret|token|api_?key)\w*)(["']?\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,)]+)/gi, '$1$2•••')
    .replace(/(\w+:\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1•••@')
    .replace(/\b(sk|pk|rk|ghp|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{10,}/g, '•••');
}

/** Which model a request goes to (default: the one chosen in Settings), and a way to stop it. */
interface Use {
  provider?: DvAiProvider;
  model?: string;
  signal?: AbortSignal;
  /** Stream the answer: called with the text so far as it arrives. */
  onText?: (soFar: string) => void;
}

/** The value of a JSON string field in a possibly unfinished JSON text ('' when it has not started). */
function partialField(json: string, field: string): string {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(json);
  if (!m) return '';
  let out = '';
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i];
    if (c === '"') break;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = json[++i];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = json.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : n;
  }
  return out;
}

export class AskAi {
  private cache = new Map<string, Schema>();
  private keyspaces = new Map<string, Keyspace>();
  /** Running Ask AI requests, by token (Stop aborts them). */
  private running = new Map<string, AbortController>();
  /** Steps of a running request, for the window. */
  onProgress: (p: DvAiProgress) => void = () => undefined;

  constructor(private viewer: DbViewerManager) {}

  forget(connId: string, db: string): void {
    this.cache.delete(`${connId}\n${db}`);
    this.keyspaces.delete(`${connId}\n${db}`);
  }

  private isKv(connId: string): boolean {
    const conn = this.viewer.connections().find((c) => c.id === connId);
    if (!conn) throw new Error('This connection is gone');
    return DV_KEYVALUE.includes(conn.engine);
  }

  async preview(connId: string, db: string, req: DvAiRequest): Promise<DvAiPreview> {
    const { provider, model } = this.choice();
    if (this.isKv(connId)) {
      const ks = await this.keyspace(connId, db);
      await this.loadKvSamples(connId, db, ks);
      return { provider: aiProvider(provider).name, model, system: this.kvSystem(connId, db, ks), staged: false, messages: this.messages(req) };
    }
    const schema = await this.schema(connId, db);
    const staged = schema.tables.length > FULL_LIMIT;
    if (!staged) {
      await this.load(connId, db, schema, schema.tables.map((t) => t.name));
      await this.loadSamples(connId, db, schema, schema.tables.map((t) => t.name));
    }
    const system = staged ? this.pickSystem(connId, db, schema) + `\n\n(Step 2 then sends the structure of the up to ${PICK_LIMIT} tables picked, and the tables their foreign keys point to, with the instructions below.)\n\n${this.answerSystem(connId, db, schema, [])}` : this.answerSystem(connId, db, schema, schema.tables.map((t) => t.name));
    return { provider: aiProvider(provider).name, model, system, staged, messages: this.messages(req) };
  }

  cancel(token: string): void {
    this.running.get(token)?.abort();
  }

  // ---------------------------------------------------------------- Ask DBCatz

  async askDbcatz(req: DvAskRequest, token = ''): Promise<DvAskAnswer> {
    needFeature('ask');
    if (!req.prompt.trim()) throw new Error('Say what DBCatz should do');
    const ctl = new AbortController();
    if (token) this.running.set(token, ctl);
    try {
      const { system, turns } = await this.askDbcatzParts(req);
      if (ctl.signal.aborted) throw new Error('Stopped');
      const a = await this.complete<DvAskAnswer>(system, turns, ASK_SCHEMA, { signal: ctl.signal });
      return { explanation: String(a.explanation ?? '').trim(), actions: this.cleanAskActions(a.actions, req.where.connId) };
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('Stopped');
      throw e;
    } finally {
      this.running.delete(token);
    }
  }

  async previewAskDbcatz(req: DvAskRequest): Promise<DvAiPreview> {
    const { provider, model } = this.choice();
    const { system, turns } = await this.askDbcatzParts(req);
    return { provider: aiProvider(provider).name, model, system, staged: false, messages: turns };
  }

  /**
   * What Ask DBCatz sends: the connections (name, engine, mode; no hosts, users
   * or passwords), where the user is, and for the open connection its
   * databases and the open database's tables (columns when there are few) or
   * key patterns. Nothing connects for this: only an open connection is read.
   */
  private async askDbcatzParts(req: DvAskRequest): Promise<{ system: string; turns: DvAiTurn[] }> {
    const conns = this.viewer.connections();
    const MODE = { normal: 'normal', production: 'PRODUCTION (writes ask first)', readonly: 'READ-ONLY' } as const;
    const lines = conns.map((c) => `${c.id}: "${c.name}" ${DIALECT[c.engine] ?? c.engine}, ${MODE[this.viewer.mode(c.id)]}${c.connected ? ', connected' : ''}${c.serviceId ? `, a DevCatz service (${c.running ? 'running' : 'STOPPED: start it in DevCatz with open-devcatz'})` : ''}`);
    const w = req.where;
    const cur = conns.find((c) => c.id === w.connId);
    const here: string[] = [];
    if (!cur) here.push('The user is on the Connections tab (no connection open in front).');
    else {
      here.push(`The user is on ${cur.id} ("${cur.name}")${w.db ? `, database ${w.db}` : ''}${w.table ? `, ${w.table}` : ''}${w.view ? ` (${w.view} view)` : ''}.`);
      if (cur.connected) {
        const d = await this.viewer.driver(cur.id).catch(() => null);
        const dbs = d ? await d.databases().catch(() => [] as string[]) : [];
        if (dbs.length) here.push(`Databases of ${cur.name}: ${dbs.slice(0, 200).join(', ')}${dbs.length > 200 ? ` … (${dbs.length})` : ''}`);
        if (w.db && familyOf(cur.engine) === 'kv') {
          const ks = await this.keyspace(cur.id, w.db).catch(() => null);
          if (ks) here.push(`Key patterns of ${w.db}: ${ks.patterns.slice(0, 40).map((p) => `${p.pattern} (${p.type}, ${p.count})`).join(', ') || '(none)'}`);
        } else if (w.db) {
          const s = await this.schema(cur.id, w.db).catch(() => null);
          if (s) {
            // Few tables: their columns too (so "which table has an email column" can be answered).
            if (s.tables.length <= 40) await this.load(cur.id, w.db, s, s.tables.map((t) => t.name)).catch(() => undefined);
            const tableLine = (t: DvTable) => {
              const st = s.structures.get(t.name);
              const cols = st ? `: ${st.columns.map((c) => `${c.name}${st.foreignKeys.find((f) => f.columns.includes(c.name)) ? ` → ${st.foreignKeys.find((f) => f.columns.includes(c.name))!.refTable}` : ''}`).join(', ')}` : '';
              return `${t.name}${t.rows !== null ? ` (~${t.rows})` : ''}${cols}`;
            };
            here.push(`Tables of ${w.db}${s.tables.length > 300 ? ` (first 300 of ${s.tables.length})` : ''}:`, ...s.tables.slice(0, 300).map(tableLine));
          }
        }
      }
    }
    const system = [
      'You are the command line of DBCatz, a database viewer for macOS (MySQL, MariaDB, PostgreSQL, SQLite, Redis, Valkey, MongoDB, Elasticsearch). The user says in plain words what they want; you answer with DBCatz actions that do it (the user clicks each), or just answer when it is a question.',
      'DBCatz screens: Connections (the list, a form for a new one), a tab per connection with a database picker, the tables in a sidebar and Data / Structure / Query / Logs views (Keys / Command for Redis), Export / Import / Backup dialogs, Jobs, Settings (Appearance, AI).',
      '- Use the connection ids and the database / table names below; never invent them. When the request names something not listed, say so. Set "connection" on every action that needs one.',
      '- When the answer is in the context (which table has a column, how many tables), say it in explanation and add the action that shows it (open-table). Questions about the data itself ("how many orders today") get a write-query action.',
      '- Order actions as they should run (open the connection before what needs it). One to four actions; none when nothing fits.',
      '- explanation: one or two sentences, in the language the user wrote in.',
      ...ASK_HELP,
      '',
      `Connections:\n${lines.join('\n') || '(none)'}`,
      ...here,
      `DBCatz: theme ${settings().theme === 'system' ? 'Auto' : settings().theme}; ${this.viewer.jobList().filter((j) => !j.finished).map((j) => `running job: ${j.title}`).join('; ') || 'no job running'}.`,
    ].join('\n');
    return { system, turns: [...(req.history ?? []).slice(-8), { role: 'user', text: req.prompt.trim() }] };
  }

  private cleanAskActions(list: unknown, current: string | undefined): DvAskAction[] {
    if (!Array.isArray(list)) return [];
    const ids = new Set(this.viewer.connections().map((c) => c.id));
    return list
      .filter((a): a is DvAskAction => !!a && typeof a === 'object' && DV_ASK_KINDS.includes((a as DvAskAction).kind))
      .map((a) => ({
        kind: a.kind,
        label: String(a.label || a.kind).slice(0, 120),
        connection: a.connection && ids.has(a.connection) ? a.connection : current,
        args: Object.fromEntries(Object.entries(a.args ?? {}).filter(([k, v]) => (DV_ASK_ARGS as readonly string[]).includes(k) && v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, String(v).slice(0, 20_000)])),
      }))
      // A change on a Read-only connection never reaches the window (the window refuses it too).
      .filter((a) => !(DV_ASK_WRITES.includes(a.kind) && a.connection && this.viewer.mode(a.connection) === 'readonly'))
      .slice(0, 6);
  }

  // ---------------------------------------------------------------- Ask AI in Logs

  async explainLog(connId: string, req: DvLogRequest, token = ''): Promise<DvLogAnswer> {
    needFeature('logs');
    if (!req.entries.length) throw new Error('Pick a log line to ask about');
    const ctl = new AbortController();
    if (token) this.running.set(token, ctl);
    try {
      const { system, turns } = await this.logParts(connId, req);
      if (ctl.signal.aborted) throw new Error('Stopped');
      const a = await this.complete<DvLogAnswer>(system, turns, LOG_SCHEMA, { signal: ctl.signal });
      const query = String(a.query ?? '').trim();
      return { summary: String(a.summary ?? '').trim(), cause: String(a.cause ?? '').trim(), steps: Array.isArray(a.steps) ? a.steps.map(String).slice(0, 8) : [], query };
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('Stopped');
      throw e;
    } finally {
      this.running.delete(token);
    }
  }

  async previewLog(connId: string, req: DvLogRequest): Promise<DvAiPreview> {
    const { provider, model } = this.choice();
    const { system, turns } = await this.logParts(connId, req);
    return { provider: aiProvider(provider).name, model, system, staged: false, messages: turns };
  }

  /**
   * What Ask AI in Logs sends: the engine and version, the connection's mode,
   * the log lines asked about (obvious secrets masked) and the structure of
   * the tables those lines use (when the connection is open).
   */
  private async logParts(connId: string, req: DvLogRequest): Promise<{ system: string; turns: DvAiTurn[] }> {
    const conn = this.viewer.connections().find((c) => c.id === connId);
    if (!conn) throw new Error('This connection is gone');
    const fam = familyOf(conn.engine);
    const dialect = DIALECT[conn.engine] ?? conn.engine;
    const entries = req.entries.slice(0, 30).map((e, i) => `${i + 1}. ${maskSecrets(e.text).slice(0, 4000)}${e.error ? `\n   ERROR: ${maskSecrets(e.error).slice(0, 1000)}` : ''}${e.ms !== null ? `\n   took ${e.ms} ms` : ''}${e.affected !== null ? `, ${e.affected} rows` : ''}`);
    let version = '';
    const described: string[] = [];
    if (conn.connected && req.db && fam !== 'kv') {
      const s = await this.schema(connId, req.db).catch(() => null);
      if (s) {
        version = s.version;
        const text = req.entries.map((e) => e.text).join('\n');
        const used = s.tables.filter((t) => new RegExp(`\\b${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)).map((t) => t.name).slice(0, 12);
        await this.load(connId, req.db, s, used).catch(() => undefined);
        described.push(...used.map((n) => this.describe(s, n, fam)).filter(Boolean));
      }
    }
    const mode = this.viewer.mode(connId);
    const system = [
      `You explain entries of DBCatz's activity log for a ${dialect}${version ? ` ${version}` : ''} connection ("${conn.name}", database ${req.db || '?'}${mode === 'production' ? ', PRODUCTION' : mode === 'readonly' ? ', READ-ONLY' : ''}). Each entry is a statement DBCatz ran, with its error or how long it took.`,
      '- summary: what happened, one or two sentences. cause: why, in plain words (the exact column / table / syntax / constraint / lock).',
      '- steps: what to do, short and concrete (DBCatz has Data, Structure, Query views and an Ask DBCatz button).',
      `- query: the fixed statement (or a faster one, e.g. with the right WHERE or an index to add as a separate CREATE INDEX line), in ${dialect} syntax, ready to run in the Query tab; empty when nothing should be run. Never a DROP / TRUNCATE / DELETE without WHERE unless that was the user's statement and its error is unrelated.`,
      mode === 'readonly' ? '- The connection is read-only: the query must only read.' : '',
      '- Use only the tables and columns described below or in the statements.',
      '- Answer in the language the user wrote their question in; English when there is no question.',
      '',
      'Log entries:',
      ...entries,
      ...(described.length ? ['', 'Structure of the tables they use:', ...described] : []),
    ].filter((l) => l !== '').join('\n');
    return { system, turns: [{ role: 'user', text: req.prompt.trim() || 'Explain what went wrong and how to fix it.' }] };
  }

  async ask(connId: string, db: string, req: DvAiRequest, token = ''): Promise<DvAiAnswer> {
    needFeature('query');
    if (!req.prompt.trim() && !req.failed) throw new Error('Say what the query should find');
    const ctl = new AbortController();
    if (token) this.running.set(token, ctl);
    try {
      return await this.askSteps(connId, db, req, token, ctl.signal);
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('Stopped');
      throw e;
    } finally {
      this.running.delete(token);
    }
  }

  private async askSteps(connId: string, db: string, req: DvAiRequest, token: string, signal: AbortSignal): Promise<DvAiAnswer> {
    const { provider, model } = this.choice();
    const who = `${aiProvider(provider).name} · ${model}`;
    const say = (step: number, steps: number, text: string) => token && this.onProgress({ token, step, steps, text });
    if (this.isKv(connId)) {
      say(1, 2, `Reading the key names of ${db}`);
      const ks = await this.keyspace(connId, db);
      await this.loadKvSamples(connId, db, ks);
      if (signal.aborted) throw new Error('Stopped');
      say(2, 2, `Writing the commands with ${who}`);
      return this.answer(await this.complete<DvAiAnswer>(this.kvSystem(connId, db, ks), this.messages(req), ANSWER_SCHEMA, { signal, onText: this.drafts(token, 2, `Writing the commands with ${who}`) }));
    }
    say(1, 0, `Reading the tables of ${db}`); // how many steps follow depends on the table count
    const schema = await this.schema(connId, db);
    const stop = () => {
      if (signal.aborted) throw new Error('Stopped');
    };
    stop();
    let names = schema.tables.map((t) => t.name);
    const staged = schema.tables.length > FULL_LIMIT;
    if (staged) {
      say(2, 4, `${schema.tables.length} tables: asking ${who} which ones the request needs`);
      const picked = await this.complete<{ tables: string[] }>(this.pickSystem(connId, db, schema), this.messages(req), PICK_SCHEMA, { signal });
      const known = new Map(schema.tables.map((t) => [t.name.toLowerCase(), t.name]));
      names = [...new Set((picked.tables ?? []).map((t) => known.get(String(t).toLowerCase())).filter((t): t is string => !!t))].slice(0, PICK_LIMIT);
      // Tables mentioned in the thread so far stay in, so follow-ups keep their context.
      for (const turn of req.history) for (const t of schema.tables) if (new RegExp(`\\b${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(turn.text) && !names.includes(t.name)) names.push(t.name);
      stop();
      say(3, 4, `Reading the structure of the ${names.length} tables picked`);
      await this.load(connId, db, schema, names);
      // One hop along foreign keys: the tables a join would need.
      const refs = names.flatMap((n) => schema.structures.get(n)?.foreignKeys.map((f) => f.refTable) ?? []);
      for (const r of refs) if (!names.includes(r) && known.has(r.toLowerCase())) names.push(known.get(r.toLowerCase())!);
    }
    const missing = names.filter((n) => !schema.structures.has(n)).length;
    if (missing) say(staged ? 3 : 1, staged ? 4 : 2, `Reading the structure of ${missing} table${missing === 1 ? '' : 's'}`);
    await this.load(connId, db, schema, names);
    await this.loadSamples(connId, db, schema, names);
    stop();
    const writing = `Writing the query with ${who}`;
    say(staged ? 4 : 2, staged ? 4 : 2, writing);
    return this.answer(await this.complete<DvAiAnswer>(this.answerSystem(connId, db, schema, names), this.messages(req), ANSWER_SCHEMA, { signal, onText: this.drafts(token, staged ? 4 : 2, writing) }));
  }

  /** The query and explanation as they are written, at most ten times a second. */
  private drafts(token: string, step: number, text: string): ((soFar: string) => void) | undefined {
    if (!token) return undefined;
    let last = 0;
    return (soFar) => {
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      this.onProgress({ token, step, steps: step, text, draft: { query: partialField(soFar, 'query'), explanation: partialField(soFar, 'explanation') } });
    };
  }

  private answer(a: DvAiAnswer): DvAiAnswer {
    return { query: String(a.query ?? '').trim(), explanation: String(a.explanation ?? '').trim(), tables: Array.isArray(a.tables) ? a.tables.map(String) : [], unanswerable: a.unanswerable === true };
  }

  /** A tiny request to see that the key and model work. */
  async test(): Promise<string> {
    const { provider, model } = this.choice();
    const r = await this.complete<{ ok: boolean }>('Answer with the JSON object {"ok": true}.', [{ role: 'user', text: 'Are you there?' }], OK_SCHEMA);
    if (r.ok !== true) throw new Error('The model answered, but not in the expected form');
    return `${aiProvider(provider).name} · ${model}`;
  }

  /** Models the provider lists for this key, without the ones that cannot chat (embeddings, speech, images …). */
  async models(provider: DvAiProvider): Promise<string[]> {
    return (await this.listModels(provider)).filter((m) => !NOT_CHAT.test(m));
  }

  /**
   * Which of these models answer with this key: one tiny request each (four
   * at a time). null = works, else the provider's reason.
   */
  async probe(provider: DvAiProvider, models: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const list = [...new Set(models)].slice(0, 24);
    for (let i = 0; i < list.length; i += 4)
      await Promise.all(
        list.slice(i, i + 4).map(async (model) => {
          try {
            await this.complete<{ ok: boolean }>('Answer with the JSON object {"ok": true}.', [{ role: 'user', text: 'ok?' }], OK_SCHEMA, { provider, model });
            out[model] = null;
          } catch (e) {
            out[model] = (e as Error).message;
          }
        }),
      );
    return out;
  }

  private async listModels(provider: DvAiProvider): Promise<string[]> {
    const base = this.baseUrl(provider);
    const key = await aiKey(provider);
    if (provider === 'anthropic') {
      const ids: string[] = [];
      for await (const m of this.anthropic(key).models.list()) ids.push(m.id);
      return ids;
    }
    if (provider === 'ollama') {
      const r = (await this.http(`${base}/api/tags`, { method: 'GET' })) as { models?: { name: string }[] };
      return (r.models ?? []).map((m) => m.name);
    }
    if (provider === 'gemini') {
      const r = (await this.http(`${base}/models?pageSize=200`, { method: 'GET', headers: { 'x-goog-api-key': this.need(provider, key) } })) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (r.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
    }
    const r = (await this.http(`${base}/models`, { method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {} })) as { data?: { id: string }[] };
    return (r.data ?? []).map((m) => m.id).sort();
  }

  // ---------------------------------------------------------------- Redis / Valkey key space

  private async keyspace(connId: string, db: string): Promise<Keyspace> {
    const key = `${connId}\n${db}`;
    const hit = this.keyspaces.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const d = await this.viewer.driver(connId);
    const [version, r] = await Promise.all([d.version().catch(() => ''), d.keys!(db, '*', KEY_SAMPLE)]);
    const groups = new Map<string, Keyspace['patterns'][number]>();
    for (const k of r.keys) {
      const pattern = patternOf(k.key);
      const g = groups.get(`${pattern}\n${k.type}`) ?? { pattern, type: k.type, count: 0, ttl: false, example: k.key };
      g.count++;
      if (k.ttl >= 0) g.ttl = true;
      groups.set(`${pattern}\n${k.type}`, g);
    }
    const ks: Keyspace = { at: Date.now(), version, scanned: r.keys.length, total: r.total, samples: new Map(), patterns: [...groups.values()].sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern)).slice(0, PATTERN_LIMIT) };
    this.keyspaces.set(key, ks);
    return ks;
  }

  private kvSystem(connId: string, db: string, ks: Keyspace): string {
    const conn = this.viewer.connections().find((c) => c.id === connId)!;
    const name = DIALECT[conn.engine] ?? conn.engine;
    const mode = this.viewer.mode(connId);
    return [
      `You write ${name} commands for DBCatz, a database viewer, as redis-cli lines. The user describes in plain words (any language) what they want from logical database ${db}${ks.version ? ` (server ${ks.version})` : ''}.`,
      mode === 'readonly'
        ? 'This connection is READ-ONLY: write only commands that read (GET, MGET, HGETALL, HGET, LRANGE, SMEMBERS, ZRANGE, SCAN, TYPE, TTL, EXISTS …). If the user asks to change data, set unanswerable and say the connection is read-only.'
        : mode === 'production'
          ? 'This is a PRODUCTION server: prefer reads; write SET / DEL / EXPIRE … only when the user clearly asks for a change, and never FLUSHDB / FLUSHALL unless asked for in so many words.'
          : 'Write SET / DEL / EXPIRE … only when the user clearly asks for a change; never FLUSHDB / FLUSHALL unless asked for in so many words.',
      'Rules:',
      '- One command per line, redis-cli syntax; quote arguments with spaces in double quotes. DBCatz runs each line as one command: no shell, pipes or variables.',
      '- To find keys use SCAN 0 MATCH <pattern> COUNT 100, never KEYS. Use the command that fits the key type (HGETALL for a hash, LRANGE key 0 -1 for a list, SMEMBERS, ZRANGE key 0 -1 WITHSCORES, GET for a string, JSON.GET for json).',
      '- A command cannot take the result of another: when the user asks for "the values of all keys matching X", write the SCAN line and, if the pattern shows a typical key, an example read command for one key of it.',
      '- Use only the key patterns below (or ones the user names). If nothing fits, set unanswerable and say what is missing.',
      '- explanation: one to three short sentences in the language the user wrote in. tables: the key patterns used.',
      '- When the user reports an error, fix the commands and say what was wrong.',
      'Answer with JSON: {"query", "explanation", "tables", "unanswerable"}; query holds the command lines.',
      '',
      `Key names of database ${db} (${ks.scanned} of ${ks.total} keys scanned; ids shown as *; pattern  type  count):`,
      ...(ks.patterns.length ? ks.patterns.map((p) => `${p.pattern}  ${p.type}  ${p.count}${p.ttl ? '  (with TTL)' : ''}${ks.samples.get(p.pattern) ? `\n  sample: ${ks.samples.get(p.pattern)}` : ''}`) : ['(no keys)']),
    ].join('\n');
  }

  // ---------------------------------------------------------------- schema

  private async schema(connId: string, db: string): Promise<Schema> {
    const conn = this.viewer.connections().find((c) => c.id === connId);
    if (!conn) throw new Error('This connection is gone');
    if (!DV_SQL.includes(conn.engine) && !DV_DOCUMENT.includes(conn.engine)) throw new Error(`Ask AI does not know ${conn.engine} yet`);
    const key = `${connId}\n${db}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const d = await this.viewer.driver(connId);
    const [version, tables] = await Promise.all([d.version().catch(() => ''), d.tables(db)]);
    const s: Schema = { at: Date.now(), version, tables, structures: new Map(), samples: new Map() };
    this.cache.set(key, s);
    return s;
  }

  /** Reads the structure of tables not cached yet, eight at a time. */
  private async load(connId: string, db: string, s: Schema, names: string[]): Promise<void> {
    const todo = names.filter((n) => !s.structures.has(n));
    if (!todo.length) return;
    const d = await this.viewer.driver(connId);
    for (let i = 0; i < todo.length; i += 8)
      await Promise.all(
        todo.slice(i, i + 8).map(async (n) => {
          const st = await d.structure(db, n).catch(() => null);
          if (st) s.structures.set(n, st);
        }),
      );
  }

  /** The connection lets Ask AI send sample values (Ask AI panel switch, off by default). */
  private samplesOn(connId: string): boolean {
    return settings().ai.samples.includes(connId);
  }

  /** A few rows of each table, values clipped (sample switch on). */
  private async loadSamples(connId: string, db: string, s: Schema, names: string[]): Promise<void> {
    if (!this.samplesOn(connId)) return;
    const d = await this.viewer.driver(connId);
    for (const n of names.filter((x) => !s.samples.has(x))) {
      const r = await readRows(d, db, n, { offset: 0, limit: SAMPLE_ROWS, orderBy: null, desc: false, where: '' }).catch(() => null);
      s.samples.set(n, r ? r.rows.map((row) => `{${r.columns.map((c, i) => `${c}: ${clip(row[i])}`).join(', ')}}`) : []);
    }
  }

  /** One value of each key pattern's example key, clipped (sample switch on). */
  private async loadKvSamples(connId: string, db: string, ks: Keyspace): Promise<void> {
    if (!this.samplesOn(connId)) return;
    const d = await this.viewer.driver(connId);
    for (const p of ks.patterns.slice(0, 20).filter((x) => !ks.samples.has(x.pattern))) {
      const v = await d.key!(db, p.example).catch(() => null);
      ks.samples.set(p.pattern, v ? `${p.example} = ${clip(v.value, 160)}` : '');
    }
  }

  private header(connId: string, db: string, s: Schema): { dialect: string; lines: string[] } {
    const conn = this.viewer.connections().find((c) => c.id === connId)!;
    const dialect = DIALECT[conn.engine] ?? conn.engine;
    const ro = this.viewer.mode(connId) === 'readonly';
    const prod = this.viewer.mode(connId) === 'production';
    const fam = familyOf(conn.engine);
    const what = fam === 'mongo' ? 'mongosh-style calls' : fam === 'es' ? 'Kibana-console requests' : 'queries';
    const reads = fam === 'mongo' ? 'find / findOne / aggregate (no $out / $merge) / countDocuments / distinct' : fam === 'es' ? 'GET requests (_search, _count, _mapping, _cat …)' : 'SELECT (or WITH … SELECT) statements';
    const writes = fam === 'mongo' ? 'insertOne / updateMany / deleteMany …' : fam === 'es' ? 'PUT / POST _doc / _update / DELETE …' : 'INSERT / UPDATE / DELETE / DDL';
    const where = fam === 'mongo' ? 'a precise filter' : fam === 'es' ? 'a precise query' : 'a precise WHERE';
    return {
      dialect,
      lines: [
        `You write ${dialect} ${what} for DBCatz, a database viewer. The user describes in plain words (any language) what they want from the database "${db}"${s.version ? ` (server ${s.version})` : ''}.`,
        ro ? `This connection is READ-ONLY: write only ${reads}. If the user asks to change data or structure, set unanswerable and say the connection is read-only.` : prod ? `This is a PRODUCTION database: prefer reads; write ${writes} only when the user clearly asks for a change, and then always with ${where}.` : `Write ${writes} only when the user clearly asks for a change, always with ${where} for updates and deletes.`,
      ],
    };
  }

  private pickSystem(connId: string, db: string, s: Schema): string {
    const h = this.header(connId, db, s);
    return [
      ...h.lines,
      `The database has ${s.tables.length} tables, too many to describe at once. From the names below, pick the tables (at most ${PICK_LIMIT}) a query for the user's request would need, including tables to join through. Answer with JSON {"tables": [...]}, names exactly as listed.`,
      '',
      'Tables (estimated rows):',
      ...s.tables.map((t) => `${t.name}${t.type === 'view' ? ' (view)' : ''}${t.rows !== null ? ` ~${t.rows}` : ''}`),
    ].join('\n');
  }

  private answerSystem(connId: string, db: string, s: Schema, names: string[]): string {
    const h = this.header(connId, db, s);
    const fam = familyOf(this.viewer.connections().find((c) => c.id === connId)!.engine);
    const described = names.map((n) => this.describe(s, n, fam)).filter(Boolean);
    const rules =
      fam === 'mongo'
        ? [
            '- One call per line, each starting with db.<collection>. DBCatz runs: find(filter, projection) with .sort() .skip() .limit(), findOne, aggregate([…]), countDocuments, distinct, insertOne / insertMany, updateOne / updateMany, deleteOne / deleteMany, createIndex. Arguments are relaxed JSON (keys may be unquoted); ObjectId("…") and ISODate("…") work. No variables, no JavaScript beyond that.',
            '- Use only the collections and fields described below (fields were seen in sampled documents; others may exist).',
            '- For lists, add .sort() that matches the request ("newest" → a date field or _id, descending) and .limit(100) unless the user wants everything or a count.',
            '- Join collections with aggregate and $lookup only when a field clearly holds the other collection\'s _id.',
          ]
        : fam === 'es'
          ? [
              '- Kibana console format: a request line (GET /<index>/_search) and its JSON body on the following lines; several requests are separated by a new request line.',
              '- Use only the indices and fields described below (from their mappings): term / terms on keyword fields, match on text fields, range on dates and numbers.',
              '- For lists, set "size": 100 unless the user wants a count (use _count) and add "sort" that matches the request ("newest" → a date field, descending).',
            ]
          : [
              `- Use only the tables and columns described below; quote identifiers the way ${h.dialect} needs when they are reserved words or mixed case.`,
              '- One statement unless the user asks for more. End statements with ;.',
              '- For lists, add ORDER BY that matches the request ("newest" → the creation date or the auto-increment key, descending) and LIMIT 100 unless the user wants everything or a count / total.',
              '- Prefer joins along the foreign keys shown. When a column name is ambiguous, qualify it with the table.',
            ];
    const noun = fam === 'mongo' ? 'collections' : fam === 'es' ? 'indices' : 'tables';
    return [
      ...h.lines,
      'Rules:',
      ...rules,
      '- If nothing in the schema fits, set unanswerable to true, leave query empty and say what is missing.',
      '- explanation: one to three short sentences in the language the user wrote in.',
      '- When the user reports an error, fix the query and say what was wrong.',
      'Answer with JSON: {"query", "explanation", "tables", "unanswerable"}.',
      '',
      ...(s.samples.size ? ['Sample rows (values clipped) are shown under each table: use them to match how values are written (case, codes, date format); they are examples, not all the data.'] : []),
      '',
      `Schema of ${db}${names.length < s.tables.length ? ` (the ${names.length} relevant ${noun} of ${s.tables.length})` : ''}:`,
      ...described,
    ].join('\n');
  }

  /** One table in a compact form: name, columns with type and keys, foreign keys, indexes. */
  private describe(s: Schema, name: string, fam: Family = 'sql'): string {
    const t = s.tables.find((x) => x.name === name);
    const st = s.structures.get(name);
    if (!t) return '';
    const kind = fam === 'mongo' ? 'COLLECTION' : fam === 'es' ? 'INDEX' : t.type === 'view' ? 'VIEW' : 'TABLE';
    const head = `${kind} ${name}${t.rows !== null ? ` (~${t.rows} ${fam === 'sql' ? 'rows' : 'documents'})` : ''}`;
    const samples = (s.samples.get(name) ?? []).map((x) => `  sample: ${x}`);
    if (!st) return head;
    const fk = new Map<string, string>();
    for (const f of st.foreignKeys) f.columns.forEach((c, i) => fk.set(c, `${f.refTable}.${f.refColumns[i] ?? f.refColumns[0]}`));
    const cols = st.columns.map((c) => {
      const bits = [c.type];
      if (st.primaryKey.includes(c.name)) bits.push('PK');
      if (c.autoIncrement) bits.push('auto');
      if (!c.nullable) bits.push('not null');
      if (fk.has(c.name)) bits.push(`→ ${fk.get(c.name)}`);
      if (c.options?.length) bits.push(`one of ${c.options.slice(0, 12).join('|')}`);
      if (c.comment) bits.push(`-- ${c.comment.slice(0, 80)}`);
      return `  ${c.name} ${bits.join(' ')}`;
    });
    const idx = st.indexes.filter((i) => !i.primary).map((i) => `${i.unique ? 'unique ' : ''}(${i.columns.join(', ')})`);
    return [head, ...cols, ...(idx.length ? [`  indexes: ${idx.join(', ')}`] : []), ...samples].join('\n');
  }

  private messages(req: DvAiRequest): DvAiTurn[] {
    const last = req.failed ? `${req.prompt.trim() ? `${req.prompt.trim()}\n\n` : ''}This query failed:\n${req.failed.statement}\n\nThe server said: ${req.failed.error}\n\nFix it.` : req.prompt.trim();
    return [...req.history.slice(-12), { role: 'user', text: last }];
  }

  // ---------------------------------------------------------------- providers

  private choice(): { provider: DvAiProvider; model: string } {
    const ai = settings().ai;
    if (!ai.enabled) throw new Error('Ask AI is off: turn it on in Settings → AI');
    const info = aiProvider(ai.provider);
    const model = ai.models[ai.provider] || info.models[0] || '';
    if (!model) throw new Error(`Choose a model for ${info.name} in Settings → AI`);
    return { provider: ai.provider, model };
  }

  private baseUrl(provider: DvAiProvider): string {
    return (settings().ai.baseUrls[provider] || aiProvider(provider).baseUrl).replace(/\/+$/, '');
  }

  private need(provider: DvAiProvider, key: string): string {
    if (!key) throw new Error(`Add your ${aiProvider(provider).name} API key in Settings → AI`);
    return key;
  }

  private anthropic(key: string): Anthropic {
    return new Anthropic({ apiKey: this.need('anthropic', key), timeout: TIMEOUT_MS, maxRetries: 1 });
  }

  /** One request with a JSON answer of `schema`'s shape. */
  private async complete<T>(system: string, turns: DvAiTurn[], schema: Record<string, unknown>, use: Use = {}): Promise<T> {
    const chosen = use.provider && use.model ? null : this.choice();
    const provider = use.provider ?? chosen!.provider;
    const model = use.model ?? chosen!.model;
    const signal = use.signal;
    const key = await aiKey(provider);
    const base = this.baseUrl(provider);
    if (use.onText) {
      try {
        return parseJson<T>(await this.streamed(provider, key, base, model, system, turns, schema, signal, use.onText));
      } catch (e) {
        // Some servers do not stream (or not with a JSON answer): ask once more without streaming.
        if (signal?.aborted || /Stopped|API key|declined|cut off/.test((e as Error).message)) throw e;
        console.warn(`Ask AI: streaming failed, asking without it: ${(e as Error).message}`);
      }
    }
    let text: string;
    if (provider === 'anthropic') text = await this.viaAnthropic(key, model, system, turns, schema, signal);
    else if (provider === 'gemini') {
      const r = (await this.http(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.need(provider, key) },
        signal,
        body: { systemInstruction: { parts: [{ text: system }] }, contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })), generationConfig: { responseMimeType: 'application/json' } },
      })) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
      text = r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error(`Gemini gave no answer${r.candidates?.[0]?.finishReason ? ` (${r.candidates[0].finishReason})` : ''}`);
    } else if (provider === 'ollama') {
      const r = (await this.http(`${base}/api/chat`, { method: 'POST', signal, body: { model, stream: false, format: schema, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] } })) as { message?: { content?: string } };
      text = r.message?.content ?? '';
    } else {
      // OpenAI and the servers that speak its chat completions API.
      if (provider !== 'openai-compatible') this.need(provider, key);
      const r = (await this.http(`${base}/chat/completions`, {
        method: 'POST',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal,
        body: { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] },
      })) as { choices?: { message?: { content?: string; refusal?: string } }[] };
      const m = r.choices?.[0]?.message;
      if (m?.refusal) throw new Error(`The model declined: ${m.refusal}`);
      text = m?.content ?? '';
    }
    return parseJson<T>(text);
  }

  /** One answer, streamed: the text so far goes to `onText` as it arrives; resolves with all of it. */
  private async streamed(provider: DvAiProvider, key: string, base: string, model: string, system: string, turns: DvAiTurn[], schema: Record<string, unknown>, signal: AbortSignal | undefined, onText: (soFar: string) => void): Promise<string> {
    if (provider === 'anthropic') return this.viaAnthropic(key, model, system, turns, schema, signal, onText);
    let text = '';
    const add = (t: string | undefined) => {
      if (!t) return;
      text += t;
      onText(text);
    };
    if (provider === 'gemini') {
      await this.httpStream(`${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { headers: { 'x-goog-api-key': this.need(provider, key) }, signal, body: { systemInstruction: { parts: [{ text: system }] }, contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })), generationConfig: { responseMimeType: 'application/json' } } }, (data) => {
        const r = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        add(r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join(''));
      });
    } else if (provider === 'ollama') {
      await this.httpStream(`${base}/api/chat`, { signal, body: { model, stream: true, format: schema, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] } }, (line) => add((JSON.parse(line) as { message?: { content?: string } }).message?.content), 'ndjson');
    } else {
      if (provider !== 'openai-compatible') this.need(provider, key);
      await this.httpStream(`${base}/chat/completions`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal, body: { model, stream: true, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))] } }, (data) => {
        if (data === '[DONE]') return;
        const r = JSON.parse(data) as { choices?: { delta?: { content?: string; refusal?: string } }[] };
        if (r.choices?.[0]?.delta?.refusal) throw new Error(`The model declined: ${r.choices[0].delta.refusal}`);
        add(r.choices?.[0]?.delta?.content);
      });
    }
    if (!text.trim()) throw new Error('The stream ended without an answer');
    return text;
  }

  /** POSTs and reads the answer as it comes: server-sent events (`data:` lines) or newline-separated JSON. */
  private async httpStream(url: string, o: { headers?: Record<string, string>; body: unknown; signal?: AbortSignal }, onData: (data: string) => void, kind: 'sse' | 'ndjson' = 'sse'): Promise<void> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, body: JSON.stringify(o.body), signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Stopped');
      throw new Error(`Could not reach ${new URL(url).host}: ${(e as Error).message}`);
    }
    if (!r.ok || !r.body) throw httpError(url, r.status, await r.text());
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (kind === 'ndjson') {
            if (line) onData(line);
          } else if (line.startsWith('data:')) onData(line.slice(5).trim());
        }
      }
      if (buf.trim()) kind === 'ndjson' ? onData(buf.trim()) : buf.trim().startsWith('data:') && onData(buf.trim().slice(5).trim());
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Stopped');
      throw e;
    }
  }

  private async viaAnthropic(key: string, model: string, system: string, turns: DvAiTurn[], schema: Record<string, unknown>, signal?: AbortSignal, onText?: (soFar: string) => void): Promise<string> {
    try {
      const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // The schema is the long, stable part: cached across the follow-ups of a thread.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: turns.map((t) => ({ role: t.role, content: t.text })),
        output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      };
      let r;
      if (onText) {
        const stream = this.anthropic(key).beta.messages.stream(params, { signal });
        stream.on('text', (_delta, soFar) => onText(soFar));
        r = await stream.finalMessage();
      } else r = await this.anthropic(key).beta.messages.create(params, { signal });
      if (r.stop_reason === 'refusal') throw new Error(`Claude declined this request${r.stop_details?.explanation ? `: ${r.stop_details.explanation}` : ''}`);
      if (r.stop_reason === 'max_tokens') throw new Error('The answer was cut off; ask for something smaller');
      return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    } catch (e) {
      if (signal?.aborted) throw new Error('Stopped');
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept the API key (Settings → AI)');
      if (e instanceof Anthropic.NotFoundError) throw new Error(`Anthropic does not know the model ${model}`);
      if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached; try again in a moment');
      if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach api.anthropic.com');
      if (e instanceof Anthropic.APIError) throw new Error(`Anthropic: ${e.message}`);
      throw e;
    }
  }

  private async http(url: string, o: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
    let r: Response;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      r = await fetch(url, { method: o.method, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Stopped');
      if (timeout.aborted) throw new Error(`${new URL(url).host} did not answer within ${TIMEOUT_MS / 1000} s`);
      throw new Error(`Could not reach ${new URL(url).host}: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (!r.ok) throw httpError(url, r.status, text);
    return JSON.parse(text);
  }
}

/** A provider's error answer in plain words. */
function httpError(url: string, status: number, text: string): Error {
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? msg;
  } catch {
    /* not JSON */
  }
  return new Error(`${new URL(url).host} answered ${status}${status === 401 || status === 403 ? ' (check the API key in Settings → AI)' : ''}: ${msg}`);
}

/** The JSON object in a model's answer (some wrap it in ``` fences or add a word before it). */
function parseJson<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error('The model did not answer with a query; try again or pick another model');
  }
}
