import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { safeStorage } from 'electron';
import type { DbEngine, DvAlterOp, DvAws, DvConnection, DvLayout, DvConnectionInput, DvConnectProgress, DvExportOptions, DvImportOptions, DvJob, DvMethod, DvGridPrefs, DvOptions, DvSavedFilter, DvSavedQuery, DvDbPrefs, DvSsh, DvVault, DbCatzApi as HerdApi } from '@shared/types';
import { DV_DEFAULT_OPTIONS, DV_KEYVALUE } from '@shared/types';
import type { DevCatzServices } from '../devcatz';
import { parseDbUrl } from '@shared/dburl';
import { store } from '../store';
import { TYPES, type Driver } from './driver';
import { establish, stepsOf, type Opened, type Plan, type Report } from './connector';
import { awsProfiles, sshKeys } from './remote';
import { analyzeAlter, analyzeTableRemoval } from './safety';
import { statementKind } from '@shared/dbsafety';
import { splitStatements } from './driver';
import * as ops from './ops';
import { dropTables, truncateTables } from './bulk';
import { backupTo, exportTo, importFrom, type Progress } from './transfer';

/**
 * DBCatz, the database viewer: connections (every DevCatz database service,
 * plus ones the user saves, their passwords safeStorage-encrypted), one open
 * driver per connection, and the export / import / backup jobs.
 */

interface Saved {
  id: string;
  name: string;
  engine: DbEngine;
  host: string;
  port: number;
  user: string;
  /** safeStorage-encrypted, base64; '' = none (same for the other secrets). */
  password: string;
  database: string;
  file: string;
  color: string | null;
  method?: DvMethod;
  socket?: string;
  ssh?: DvSsh | null;
  aws?: DvAws | null;
  vault?: DvVault | null;
  options?: Partial<DvOptions>;
  sshSecret?: string;
  awsSecret?: string;
  vaultToken?: string;
}

const KEY = 'dvConnections';
const QUERIES = 'dvQueries';
const LAYOUT = 'dvLayout';
const GRIDS = 'dvGrids';
const DB_PREFS = 'dvDbPrefs';
const DEFAULT_PORT: Record<DbEngine, number> = { mysql: 3306, mariadb: 3306, postgresql: 5432, redis: 6379, valkey: 6379, mongodb: 27017, elasticsearch: 9200, sqlite: 0 };

interface Open extends Opened {
  key: string;
}

export class DbViewerManager {
  private drivers = new Map<string, Open>();
  /** Connections opened from a URL for this session (not saved). */
  private temporary = new Map<string, Saved>();
  /** Running connection attempts, by token (Cancel aborts them). */
  private attempts = new Map<string, AbortController>();
  /** Opening in progress per connection (several calls wait for one attempt). */
  private opening = new Map<string, Promise<Open>>();
  private jobs: DvJob[] = [];
  onJobs: (jobs: DvJob[]) => void = () => undefined;
  onProgress: (p: DvConnectProgress) => void = () => undefined;
  /** Connections opened / closed (the window refreshes its list). */
  onChange: () => void = () => undefined;

  constructor(private dbs: DevCatzServices) {}

  private saved(): Saved[] {
    return store.extra<Saved[]>(KEY) ?? [];
  }
  private find(id: string): Saved | undefined {
    return this.temporary.get(id) ?? this.saved().find((x) => x.id === id);
  }

  private enc(v: string): string {
    if (!v) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS Keychain encryption is not available');
    return safeStorage.encryptString(v).toString('base64');
  }
  private dec(v: string | undefined): string {
    return v ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
  }

  private view(s: Saved, temporary: boolean): DvConnection {
    return {
      id: s.id,
      name: s.name,
      engine: s.engine,
      host: s.host,
      port: s.port,
      user: s.user,
      hasPassword: !!s.password,
      database: s.database,
      file: s.file,
      serviceId: null,
      running: true,
      color: s.color,
      method: s.method ?? 'tcp',
      socket: s.socket ?? '',
      ssh: s.ssh ?? null,
      aws: s.aws ?? null,
      vault: s.vault ?? null,
      options: { ...DV_DEFAULT_OPTIONS, ...(s.options ?? {}) },
      hasSshSecret: !!s.sshSecret,
      hasAwsSecret: !!s.awsSecret,
      hasVaultToken: !!s.vaultToken,
      temporary,
      connected: this.drivers.has(s.id),
    };
  }

  /** Service connections first (live port / user / running), then the saved ones, then this session's. */
  connections(): DvConnection[] {
    const services: DvConnection[] = this.dbs.list().map((c) => ({
      id: `svc:${c.id}`,
      name: c.name,
      engine: c.engine,
      host: c.host || '127.0.0.1',
      port: c.port,
      user: c.user,
      hasPassword: !!c.password,
      database: c.engine === 'postgresql' ? 'postgres' : '',
      file: c.engine === 'sqlite' ? c.dataDir : '',
      serviceId: c.id,
      running: c.engine === 'sqlite' ? true : c.running,
      color: null,
      method: 'tcp',
      socket: '',
      ssh: null,
      aws: null,
      vault: null,
      options: { ...DV_DEFAULT_OPTIONS },
      hasSshSecret: false,
      hasAwsSecret: false,
      hasVaultToken: false,
      temporary: false,
      connected: this.drivers.has(`svc:${c.id}`),
    }));
    return [...services, ...this.saved().map((s) => this.view(s, false)), ...[...this.temporary.values()].map((s) => this.view(s, true))];
  }

  /** What establish() needs for a connection id (secrets decrypted). */
  private planOf(id: string): Plan {
    if (id.startsWith('svc:')) {
      const c = this.dbs.list().find((x) => x.id === id.slice(4));
      if (!c) throw new Error('This DevCatz service no longer exists (DevCatz removed it, or is not installed)');
      if (c.engine !== 'sqlite' && !c.running) throw new Error(`${c.name} is not running; start it in DevCatz`);
      return {
        engine: c.engine,
        host: c.host || '127.0.0.1',
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.engine === 'postgresql' ? 'postgres' : '',
        file: c.engine === 'sqlite' ? c.dataDir : '',
        method: 'tcp',
        socket: '',
        ssh: null,
        aws: null,
        vault: null,
        options: { ...DV_DEFAULT_OPTIONS },
        sshSecret: '',
        awsSecret: '',
        vaultToken: '',
      };
    }
    const s = this.find(id);
    if (!s) throw new Error('No such connection');
    return this.planFromSaved(s);
  }

  private planFromSaved(s: Saved): Plan {
    return {
      engine: s.engine,
      host: s.host,
      port: s.port || DEFAULT_PORT[s.engine],
      user: s.user,
      password: this.dec(s.password),
      database: s.database,
      file: s.file,
      method: s.method ?? 'tcp',
      socket: s.socket ?? '',
      ssh: s.ssh ?? null,
      aws: s.aws ?? null,
      vault: s.vault ?? null,
      options: { ...DV_DEFAULT_OPTIONS, ...(s.options ?? {}) },
      sshSecret: this.dec(s.sshSecret),
      awsSecret: this.dec(s.awsSecret),
      vaultToken: this.dec(s.vaultToken),
    };
  }

  private keyOf = (p: Plan) => JSON.stringify(p);

  /** Runs an attempt under a token: progress to the window, Cancel through dvCancelConnect. */
  private async attempt<T>(token: string | undefined, plan: Plan, fn: (report: Report, signal: AbortSignal) => Promise<T>): Promise<T> {
    const t = token || `conn-${randomBytes(4).toString('hex')}`;
    const ctrl = new AbortController();
    this.attempts.set(t, ctrl);
    let steps = stepsOf(plan);
    let step = 0;
    const send = (done: boolean, error: string | null, detail = '') => this.onProgress({ token: t, steps, step, detail, done, error });
    send(false, null);
    try {
      const out = await fn((s, i, detail) => {
        steps = s;
        step = i;
        send(false, null, detail);
      }, ctrl.signal);
      step = steps.length;
      send(true, null);
      return out;
    } catch (e) {
      send(true, (e as Error).message);
      throw e;
    } finally {
      this.attempts.delete(t);
    }
  }

  cancel(token: string): void {
    this.attempts.get(token)?.abort();
  }

  /**
   * The plan of a connection; when it cannot even be made (a DevCatz service
   * that is stopped or gone) the attempt still reports — as a failed first
   * step — so the window shows the reason instead of a spinner with nothing
   * behind it to cancel.
   */
  private plan(id: string, token?: string): Plan {
    try {
      return this.planOf(id);
    } catch (e) {
      if (token) this.onProgress({ token, steps: [id.startsWith('svc:') ? 'Find the DevCatz service' : 'Read the connection settings'], step: 0, detail: '', done: true, error: (e as Error).message });
      throw e;
    }
  }

  /**
   * DevCatz's services changed: connections to a service that stopped or was
   * removed are closed, so their tabs show Reconnect instead of failing later.
   */
  servicesChanged(): void {
    const live = new Set(this.dbs.list().filter((s) => s.running || s.engine === 'sqlite').map((s) => `svc:${s.id}`));
    for (const id of [...this.drivers.keys()]) if (id.startsWith('svc:') && !live.has(id)) this.release(id);
    this.onChange();
  }

  /** Opens (or reuses) a connection; reopened when its settings changed or its IAM token is due. */
  private open(id: string, token?: string): Promise<Open> {
    const plan = this.plan(id, token);
    const key = this.keyOf(plan);
    const cur = this.drivers.get(id);
    if (cur && cur.key === key && (!cur.renewAt || cur.renewAt > Date.now())) return Promise.resolve(cur);
    const pending = this.opening.get(id);
    if (pending && !token) return pending;
    if (cur) this.closeOpen(cur);
    this.drivers.delete(id);
    const p = this.attempt(token, plan, (report, signal) => establish(plan, report, signal))
      .then((o) => {
        const open: Open = { ...o, key };
        this.drivers.set(id, open);
        this.onChange();
        return open;
      })
      .finally(() => this.opening.delete(id));
    this.opening.set(id, p);
    return p;
  }

  private closeOpen(o: Opened): void {
    void o.driver.close().catch(() => undefined);
    o.tunnel?.close();
  }

  /** The open driver of a connection. */
  async driver(id: string): Promise<Driver> {
    return (await this.open(id)).driver;
  }

  /** Drops the open driver (a closed tab, a connection that failed, or Disconnect). */
  release(id: string): void {
    const open = this.drivers.get(id);
    if (open) this.closeOpen(open);
    if (this.drivers.delete(id)) this.onChange();
  }

  // ---------------------------------------------------------------- list layout

  layout(): DvLayout {
    const l = store.extra<DvLayout>(LAYOUT);
    return { order: l?.order ?? [], favorites: l?.favorites ?? [], groups: l?.groups ?? [] };
  }

  setLayout(l: DvLayout): DvLayout {
    const ids = (a: unknown) => (Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === 'string' && x.length < 200))] : []);
    const names = new Set<string>();
    const groups = (Array.isArray(l.groups) ? l.groups : [])
      .map((g) => ({ name: String(g?.name ?? '').trim().slice(0, 60), members: ids(g?.members), collapsed: !!g?.collapsed }))
      .filter((g) => g.name && !names.has(g.name) && names.add(g.name));
    // A connection belongs to one group at most (the first that lists it).
    const seen = new Set<string>();
    for (const g of groups) g.members = g.members.filter((m) => !seen.has(m) && seen.add(m));
    const out: DvLayout = { order: ids(l.order), favorites: ids(l.favorites), groups };
    store.setExtra(LAYOUT, out);
    return out;
  }

  private validate(input: DvConnectionInput): DvConnectionInput {
    const name = input.name.trim();
    if (!name) throw new Error('A connection needs a name');
    const method = input.method ?? 'tcp';
    if (input.engine === 'sqlite') {
      if (!input.file.trim()) throw new Error('Choose the SQLite file or folder');
      if (!existsSync(input.file)) throw new Error(`${input.file} does not exist`);
    } else if (method === 'socket') {
      if (!input.socket?.trim()) throw new Error('Enter the socket path');
    } else {
      if (!input.host.trim() && !(method === 'ssh')) throw new Error('A host is needed');
      if (!(input.port > 0 && input.port < 65536)) throw new Error('The port must be 1 – 65535');
      if (method === 'ssh' && (!input.ssh?.host.trim() || !input.ssh.user.trim())) throw new Error('SSH host and user are needed');
      if (method === 'vault' && (!input.vault?.addr.trim() || !input.vault.path.trim())) throw new Error('Vault address and secret path are needed');
    }
    const tz = input.options?.timeZone?.trim() ?? '';
    if (tz && !/^([+-](0\d|1[0-4]):[0-5]\d|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*|UTC|SYSTEM)$/.test(tz)) throw new Error(`Time zone ${tz}: use +07:00 or a name like Asia/Jakarta`);
    return { ...input, name, method, host: input.host.trim() || (method === 'ssh' ? '127.0.0.1' : ''), file: input.file.trim(), database: input.database.trim(), user: input.user.trim(), socket: input.socket?.trim() ?? '' };
  }

  /** Input → stored form (secrets encrypted; null keeps the old one). */
  private toSaved(input: DvConnectionInput, old: Saved | undefined, id: string): Saved {
    const keep = (v: string | null | undefined, prev: string | undefined) => (v === null || v === undefined ? (prev ?? '') : this.enc(v));
    return {
      id,
      name: input.name,
      engine: input.engine,
      host: input.host,
      port: input.port,
      user: input.user,
      password: keep(input.password, old?.password),
      database: input.database,
      file: input.file,
      color: input.color,
      method: input.method ?? 'tcp',
      socket: input.socket ?? '',
      ssh: input.method === 'ssh' ? (input.ssh ?? null) : null,
      aws: input.method === 'aws-iam' ? (input.aws ?? null) : null,
      vault: input.method === 'vault' ? (input.vault ?? null) : null,
      options: { ...DV_DEFAULT_OPTIONS, ...(input.options ?? {}) },
      sshSecret: input.method === 'ssh' ? keep(input.sshSecret, old?.sshSecret) : '',
      awsSecret: input.method === 'aws-iam' ? keep(input.awsSecret, old?.awsSecret) : '',
      vaultToken: input.method === 'vault' ? keep(input.vaultToken, old?.vaultToken) : '',
    };
  }

  save(raw: DvConnectionInput): DvConnection {
    const input = this.validate(raw);
    if (input.temporary && !input.id) {
      const s = this.toSaved(input, undefined, `tmp-${randomBytes(4).toString('hex')}`);
      this.temporary.set(s.id, s);
      return this.view(s, true);
    }
    // A temporary connection being saved for good keeps its secrets.
    const tmp = input.id ? this.temporary.get(input.id) : undefined;
    const list = this.saved();
    const old = tmp ?? (input.id ? list.find((s) => s.id === input.id) : undefined);
    if (input.id && !old) throw new Error('No such connection');
    const s = this.toSaved(input, old, tmp || !old ? `conn-${randomBytes(4).toString('hex')}` : old.id);
    if (tmp) {
      this.temporary.delete(tmp.id);
      this.release(tmp.id);
    }
    store.setExtra(KEY, old && !tmp ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]);
    this.release(s.id);
    return this.view(s, false);
  }

  /** A connection URL → a session connection (dbcatz://url?u=…). */
  openUrl(url: string): DvConnection {
    const p = parseDbUrl(url);
    return this.save({ ...p, color: null, temporary: true });
  }

  delete(id: string): void {
    if (this.temporary.delete(id)) return this.release(id);
    if (!this.saved().some((s) => s.id === id)) throw new Error('Only saved connections can be deleted here; services are removed on the Database page');
    this.release(id);
    store.setExtra(
      KEY,
      this.saved().filter((s) => s.id !== id),
    );
    const l = this.layout();
    this.setLayout({ order: l.order.filter((x) => x !== id), favorites: l.favorites.filter((x) => x !== id), groups: l.groups.map((g) => ({ ...g, members: g.members.filter((x) => x !== id) })) });
  }

  async test(raw: DvConnectionInput, token?: string): Promise<string> {
    // A test needs no name.
    const input = this.validate({ ...raw, name: raw.name.trim() || 'test' });
    const old = input.id ? this.find(input.id) : undefined;
    const plan = this.planFromSaved(this.toSaved(input, old, 'test'));
    const o = await this.attempt(token, plan, (report, signal) => establish(plan, report, signal));
    this.closeOpen(o);
    return o.version;
  }

  async serverInfo(id: string, token?: string): Promise<{ version: string; user: string }> {
    try {
      const o = await this.open(id, token);
      return { version: o.version, user: o.user };
    } catch (e) {
      this.release(id);
      throw e;
    }
  }

  // ---------------------------------------------------------------- grid prefs (per table)

  private gridKey = (connId: string, db: string, table: string) => `${connId}\n${db}\n${table}`;

  gridPrefs(connId: string, db: string, table: string): DvGridPrefs {
    const p = (store.extra<Record<string, DvGridPrefs>>(GRIDS) ?? {})[this.gridKey(connId, db, table)];
    return { widths: p?.widths ?? {}, order: p?.order ?? [], filters: p?.filters ?? [] };
  }

  setGridPrefs(connId: string, db: string, table: string, raw: DvGridPrefs): DvGridPrefs {
    const widths: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.widths ?? {})) if (typeof v === 'number' && v >= 40 && v <= 2000) widths[String(k)] = Math.round(v);
    const order = Array.isArray(raw.order) ? [...new Set(raw.order.map(String))].slice(0, 2000) : [];
    const filters: DvSavedFilter[] = (Array.isArray(raw.filters) ? raw.filters : [])
      .filter((f) => f && String(f.name ?? '').trim() && String(f.where ?? '').trim())
      .slice(0, 200)
      .map((f) => ({ id: /^f-[0-9a-f]{8}$/.test(String(f.id)) ? String(f.id) : `f-${randomBytes(4).toString('hex')}`, name: String(f.name).trim().slice(0, 120), where: String(f.where).trim() }));
    const prefs: DvGridPrefs = { widths, order, filters };
    const all = { ...(store.extra<Record<string, DvGridPrefs>>(GRIDS) ?? {}) };
    const key = this.gridKey(connId, db, table);
    if (!Object.keys(widths).length && !order.length && !filters.length) delete all[key];
    else all[key] = prefs;
    store.setExtra(GRIDS, all);
    return prefs;
  }

  // ---------------------------------------------------------------- database picker (recent, starred; per connection)

  dbPrefs(connId: string): DvDbPrefs {
    const p = (store.extra<Record<string, DvDbPrefs>>(DB_PREFS) ?? {})[connId];
    return { recent: p?.recent ?? [], favorites: p?.favorites ?? [] };
  }

  setDbPrefs(connId: string, raw: DvDbPrefs): DvDbPrefs {
    const clean = (l: unknown, max: number) => (Array.isArray(l) ? [...new Set(l.map(String).filter(Boolean))].slice(0, max) : []);
    const prefs: DvDbPrefs = { recent: clean(raw.recent, 8), favorites: clean(raw.favorites, 200) };
    const all = { ...(store.extra<Record<string, DvDbPrefs>>(DB_PREFS) ?? {}) };
    if (!prefs.recent.length && !prefs.favorites.length) delete all[connId];
    else all[connId] = prefs;
    store.setExtra(DB_PREFS, all);
    return prefs;
  }

  // ---------------------------------------------------------------- saved queries

  private queries(): Record<string, DvSavedQuery[]> {
    return store.extra<Record<string, DvSavedQuery[]>>(QUERIES) ?? {};
  }

  /** Saved queries are kept per database: `<connection id>\n<database>`. A key of just the connection id holds older ones. */
  private queryKey = (connId: string, db: string) => `${connId}\n${db}`;

  savedQueries(connId: string, db: string): DvSavedQuery[] {
    const all = this.queries();
    const own = all[this.queryKey(connId, db)] ?? [];
    const older = (all[connId] ?? []).map((q) => ({ ...q, anyDb: true }));
    return [...own, ...older].sort((a, b) => a.name.localeCompare(b.name));
  }

  saveQuery(connId: string, db: string, q: { id?: string; name: string; text: string }): DvSavedQuery {
    const name = q.name.trim();
    if (!name) throw new Error('A saved query needs a name');
    const all = this.queries();
    const key = this.queryKey(connId, db);
    const list = all[key] ?? [];
    // An older connection-wide query saved again moves into this database.
    const older = q.id ? (all[connId] ?? []).find((x) => x.id === q.id) : undefined;
    if (older) all[connId] = (all[connId] ?? []).filter((x) => x.id !== q.id);
    const old = q.id ? list.find((x) => x.id === q.id) : list.find((x) => x.name === name);
    const saved: DvSavedQuery = { id: old?.id ?? older?.id ?? `q-${randomBytes(4).toString('hex')}`, name, text: q.text, updated: Date.now() };
    all[key] = old ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved];
    if (all[connId] && !all[connId].length) delete all[connId];
    store.setExtra(QUERIES, all);
    return saved;
  }

  deleteQuery(connId: string, db: string, id: string): void {
    const all = this.queries();
    const key = this.queryKey(connId, db);
    all[key] = (all[key] ?? []).filter((x) => x.id !== id);
    if (!all[key].length) delete all[key];
    if (all[connId]) {
      all[connId] = all[connId].filter((x) => x.id !== id);
      if (!all[connId].length) delete all[connId];
    }
    store.setExtra(QUERIES, all);
  }

  // ---------------------------------------------------------------- jobs

  private pushJob(title: string, connId: string, kind: DvJob['kind']): DvJob {
    const job: DvJob = { id: `job-${randomBytes(3).toString('hex')}`, title, detail: 'Starting…', done: 0, total: 0, finished: false, error: null, path: null, connId, kind };
    this.jobs = [job, ...this.jobs].slice(0, 20);
    this.onJobs(this.jobs);
    return job;
  }

  /** Jobs asked to stop: the next progress report ends them (a job reports every few hundred rows / keys). */
  private stopping = new Set<string>();

  cancelJob(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.finished) return;
    this.stopping.add(id);
    job.detail = 'Stopping…';
    this.onJobs(this.jobs);
  }

  private progressOf(job: DvJob): Progress {
    let last = 0;
    return (detail, done, total) => {
      if (this.stopping.has(job.id)) throw new Error('Cancelled');
      job.detail = detail;
      if (done !== undefined) job.done = done;
      if (total !== undefined) job.total = total;
      const now = Date.now();
      if (now - last > 150) {
        last = now;
        this.onJobs(this.jobs);
      }
    };
  }

  private async runJob(title: string, path: string, connId: string, kind: DvJob['kind'], fn: (p: Progress) => Promise<string | void>): Promise<string> {
    const job = this.pushJob(title, connId, kind);
    try {
      const detail = await fn(this.progressOf(job));
      job.detail = typeof detail === 'string' ? detail : 'Done';
      job.path = path;
      job.done = job.total || 1;
      job.total = job.total || 1;
    } catch (e) {
      if (this.stopping.has(job.id)) {
        job.cancelled = true;
        // A half-written export / backup is not kept; an import cannot take back what it already wrote.
        if (kind === 'import') job.error = 'Cancelled: what was imported before stays';
        else {
          job.error = 'Cancelled';
          await rm(path, { force: true }).catch(() => undefined);
        }
      } else job.error = (e as Error).message;
      throw e;
    } finally {
      this.stopping.delete(job.id);
      job.finished = true;
      this.onJobs(this.jobs);
    }
    return path;
  }

  export(id: string, path: string, o: DvExportOptions): Promise<string> {
    return this.runJob(`Export ${o.database}${o.tables.length === 1 ? `.${o.tables[0]}` : ''} as ${o.format.toUpperCase()}`, path, id, 'export', async (p) => exportTo(await this.driver(id), path, o, p));
  }

  import(id: string, path: string, o: DvImportOptions): Promise<string> {
    this.writable(id, 'Imports');
    return this.runJob(`Import into ${o.table ? `${o.database}.${o.table}` : o.database}`, path, id, 'import', async (p) => importFrom(await this.driver(id), path, o, p));
  }

  backup(id: string, path: string, databases: string[]): Promise<string> {
    return this.runJob(`Backup ${databases.length} database${databases.length === 1 ? '' : 's'}`, path, id, 'backup', async (p) => backupTo(await this.driver(id), path, databases, p));
  }

  jobList(): DvJob[] {
    return this.jobs;
  }

  /** Removes finished jobs from the list (these ids, or all finished ones); running jobs stay. */
  clearJobs(ids?: string[]): DvJob[] {
    this.jobs = this.jobs.filter((j) => !j.finished || (ids && !ids.includes(j.id)));
    this.onJobs(this.jobs);
    return this.jobs;
  }

  /** The IPC routes that need no window (dialogs are wired in index.ts). */
  routes(): Pick<HerdApi, 'dvConnections' | 'dvSaveConnection' | 'dvDeleteConnection' | 'dvTestConnection' | 'dvServerInfo' | 'dvCancelConnect' | 'dvDisconnect' | 'dvLayout' | 'dvSetLayout' | 'dvAwsProfiles' | 'dvSshKeys' | 'dvDatabases' | 'dvTables' | 'dvStructure' | 'dvRows' | 'dvUpdateRow' | 'dvInsertRow' | 'dvDeleteRows' | 'dvQuery' | 'dvCreateDatabase' | 'dvDropDatabase' | 'dvCreateTable' | 'dvAlterTable' | 'dvDropTable' | 'dvTruncateTable' | 'dvDropTables' | 'dvTruncateTables' | 'dvTypes' | 'dvJobs' | 'dvClearJobs' | 'dvCancelJob' | 'dvKeys' | 'dvKey' | 'dvKeySet' | 'dvKeyDelete' | 'dvKeyRename' | 'dvFlush' | 'dvSavedQueries' | 'dvSaveQuery' | 'dvDeleteQuery' | 'dvGridPrefs' | 'dvSetGridPrefs' | 'dvDbPrefs' | 'dvSetDbPrefs' | 'dvCharsets' | 'dvAlterCheck'> {
    const confirmed = (name: string, confirm: string) => {
      if (confirm.trim() !== name) throw new Error(`Type ${name} to confirm`);
    };
    const D = (id: string) => this.driver(id);
    return {
      dvConnections: async () => this.connections(),
      dvSaveConnection: async (input) => this.save(input),
      dvDeleteConnection: async (id) => this.delete(id),
      dvTestConnection: (input, token) => this.test(input, token),
      dvServerInfo: (id, token) => this.serverInfo(id, token),
      dvCancelConnect: async (token) => this.cancel(token),
      dvDisconnect: async (id) => this.release(id),
      dvLayout: async () => this.layout(),
      dvSetLayout: async (l) => this.setLayout(l),
      dvAwsProfiles: async () => awsProfiles(),
      dvSshKeys: async () => sshKeys(),
      dvDatabases: async (id) => (await D(id)).databases(),
      dvTables: async (id, db) => (await D(id)).tables(db, true),
      dvStructure: async (id, db, t) => (await D(id)).structure(db, t),
      dvRows: async (id, db, t, q) => ops.rows(await D(id), db, t, q),
      dvUpdateRow: async (id, db, t, key, changes) => (this.writable(id, 'Edits'), ops.updateRow(await D(id), db, t, key, changes)),
      dvInsertRow: async (id, db, t, values) => (this.writable(id, 'Inserts'), ops.insertRow(await D(id), db, t, values)),
      dvDeleteRows: async (id, db, t, keys) => (this.writable(id, 'Deletes'), ops.deleteRows(await D(id), db, t, keys)),
      dvQuery: async (id, db, sql) => {
        const d = await D(id);
        this.readOnlyQuery(id, d.engine, sql);
        return ops.runQuery(d, db, sql);
      },
      dvCreateDatabase: async (id, name, options) => (this.writable(id, 'New databases'), ops.createDatabase(await D(id), name, options)),
      dvCharsets: async (id) => {
        const d = await D(id);
        return d.charsets ? d.charsets() : { charsets: [], collations: [] };
      },
      dvDropDatabase: async (id, name, confirm) => {
        this.writable(id, 'Drops');
        confirmed(name, confirm);
        await ops.dropDatabase(await D(id), name);
      },
      dvCreateTable: async (id, db, t, cols) => (this.writable(id, 'New tables'), ops.createTable(await D(id), db, t, cols)),
      dvAlterCheck: async (id, db, t, o) => analyzeAlter(await D(id), db, t, o),
      dvAlterTable: (id, db, t, o, confirm) => this.alterGuarded(id, db, t, o, confirm),
      dvDropTable: async (id, db, t, confirm) => {
        this.writable(id, 'Drops');
        confirmed(t, confirm);
        const d = await D(id);
        const block = (await analyzeTableRemoval(d, db, t))[0];
        if (block) throw new Error(`${block.title}: ${block.detail}`);
        await ops.dropTable(d, db, t);
      },
      dvTruncateTable: async (id, db, t, confirm) => {
        this.writable(id, 'Emptying a table');
        confirmed(t, confirm);
        const d = await D(id);
        if (d.engine !== 'sqlite') {
          const block = (await analyzeTableRemoval(d, db, t))[0];
          if (block) throw new Error(`${block.title}: ${block.detail} (TRUNCATE is refused while foreign keys point at a table)`);
        }
        await ops.truncateTable(d, db, t);
      },
      dvDropTables: async (id, db, tables, confirm, force) => {
        this.writable(id, 'Drops');
        this.bulkConfirmed(id, db, confirm);
        return dropTables(await D(id), db, tables, force === true);
      },
      dvTruncateTables: async (id, db, tables, confirm, force) => {
        this.writable(id, 'Emptying tables');
        this.bulkConfirmed(id, db, confirm);
        return truncateTables(await D(id), db, tables, force === true);
      },
      dvTypes: async (id) => TYPES[(await D(id)).engine],
      dvJobs: async () => this.jobs,
      dvClearJobs: async (ids) => this.clearJobs(ids),
      dvCancelJob: async (id) => this.cancelJob(id),
      dvKeys: async (id, db, pattern, limit) => (await this.kv(id)).keys!(db, pattern, limit),
      dvKey: async (id, db, key) => (await this.kv(id)).key!(db, key),
      dvKeySet: async (id, db, input) => (this.writable(id, 'Key changes'), (await this.kv(id)).keySet!(db, input)),
      dvKeyDelete: async (id, db, keys) => (this.writable(id, 'Key deletes'), (await this.kv(id)).keyDelete!(db, keys)),
      dvKeyRename: async (id, db, from, to) => (this.writable(id, 'Key renames'), (await this.kv(id)).keyRename!(db, from, to)),
      dvFlush: async (id, db, confirm) => {
        this.writable(id, 'Flushes');
        confirmed(db, confirm);
        await (await this.kv(id)).flush!(db);
      },
      dvSavedQueries: async (id, db) => this.savedQueries(id, db),
      dvSaveQuery: async (id, db, q) => this.saveQuery(id, db, q),
      dvDeleteQuery: async (id, db, qid) => this.deleteQuery(id, db, qid),
      dvGridPrefs: async (id, db, table) => this.gridPrefs(id, db, table),
      dvSetGridPrefs: async (id, db, table, prefs) => this.setGridPrefs(id, db, table, prefs),
      dvDbPrefs: async (id) => this.dbPrefs(id),
      dvSetDbPrefs: async (id, prefs) => this.setDbPrefs(id, prefs),
    };
  }

  /** Normal / Production / Read-only of a connection (DevCatz services are normal). */
  mode(id: string): DvOptions['mode'] {
    return this.modeOf(id);
  }
  private modeOf(id: string): DvOptions['mode'] {
    if (id.startsWith('svc:')) return 'normal';
    return this.find(id)?.options?.mode ?? 'normal';
  }

  /** Read-only connections refuse every change (the server session is read-only too). */
  private writable(id: string, what = 'Changes'): void {
    if (this.modeOf(id) === 'readonly') throw new Error(`${what} are not allowed: this connection is read-only (Edit the connection to change its mode)`);
  }

  /** A bulk drop / truncate repeats the database name, or on Production the connection's name. */
  private bulkConfirmed(id: string, db: string, confirm: string): void {
    const word = this.modeOf(id) === 'production' ? (this.connections().find((c) => c.id === id)?.name ?? db) : db;
    if ((confirm ?? '').trim() !== word) throw new Error(`Type ${word} to confirm`);
  }

  /** Read-only: only statements that read. */
  private readOnlyQuery(id: string, engine: DbEngine, text: string): void {
    if (this.modeOf(id) !== 'readonly') return;
    const parts = engine === 'mysql' || engine === 'mariadb' || engine === 'postgresql' || engine === 'sqlite' ? splitStatements(text) : engine === 'mongodb' ? text.split(/\n(?=db\.|\{)/) : engine === 'elasticsearch' ? text.split(/\n(?=(?:GET|POST|PUT|DELETE|HEAD)\s)/i) : text.split('\n');
    for (const p of parts.map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))) {
      if (!statementKind(engine, p).read) throw new Error(`Read-only connection: "${p.replace(/\s+/g, ' ').slice(0, 80)}" would change data or structure`);
    }
  }

  private async alterGuarded(id: string, db: string, table: string, o: DvAlterOp[], confirm?: string): Promise<void> {
    this.writable(id, 'Structure changes');
    const d = await this.driver(id);
    const risk = await analyzeAlter(d, db, table, o);
    const block = risk.items.find((i) => i.level === 'block');
    if (block) throw new Error(`${block.title}: ${block.detail}`);
    if (risk.level === 'danger' && (confirm ?? '').trim() !== risk.confirmWord) throw new Error(`This change needs confirming: type ${risk.confirmWord}`);
    await ops.alterTable(d, db, table, o);
  }

  private async kv(id: string): Promise<Driver> {
    const d = await this.driver(id);
    if (!DV_KEYVALUE.includes(d.engine)) throw new Error('Keys are for Redis / Valkey');
    return d;
  }

  async closeAll(): Promise<void> {
    for (const c of this.attempts.values()) c.abort();
    await Promise.all([...this.drivers.values()].map(async (d) => {
      await d.driver.close().catch(() => undefined);
      d.tunnel?.close();
    }));
    this.drivers.clear();
  }
}
