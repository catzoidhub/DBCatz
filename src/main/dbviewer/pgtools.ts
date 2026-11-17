import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { DvPgRestoreOptions } from '@shared/types';
import { appDataDir, isLinux, isMac, isWin } from '../platform';
import type { PgEndpoint } from './connector';
import type { Driver } from './driver';

/**
 * PostgreSQL dumps that are not plain SQL (DBCatz TODO §20): what a file holds is read from its first bytes — never
 * from its extension, since a `pg_dump -Fc` gzipped as `.sql.gz` is common — and archives go through pg_restore, a
 * plain pg_dump with `COPY … FROM stdin` through psql. The tools are the ones on this computer (DevCatz's bundle,
 * Homebrew, Postgres.app, the PostgreSQL installer, the distribution's packages, PATH), the version picked to read the
 * dump and match the server; they reach the server the way the connection does (its SSH tunnel, socket, SSL).
 */

export type Progress = (detail: string, done?: number, total?: number) => void;

/** What a file is, from its content (after gunzip). */
export type Sniff =
  | { kind: 'pg-custom' | 'pg-tar'; gz: boolean; dump: PgDumpHeader }
  | { kind: 'pg-dir'; dir: string; dump: PgDumpHeader }
  | { kind: 'tar'; gz: boolean } // a DBCatz / DevCatz backup
  | { kind: 'binary'; gz: boolean }
  | { kind: 'text'; gz: boolean };

export interface PgDumpHeader {
  /** pg_dump's version, e.g. "18.6" (archives from before PostgreSQL 9.0 do not say). */
  dumpVersion: string | null;
  /** The server it was dumped from. */
  serverVersion: string | null;
  database: string | null;
}

const HEAD = 16 * 1024;

/** The first bytes of a file, gunzipped when it is gzip (whatever its name). */
async function head(path: string): Promise<{ buf: Buffer; gz: boolean }> {
  const raw = await firstBytes(createReadStream(path, { start: 0, end: HEAD - 1 }));
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) return { buf: raw, gz: false };
  const gunzip = createGunzip();
  createReadStream(path).on('error', () => undefined).pipe(gunzip);
  return { buf: await firstBytes(gunzip), gz: true };
}

async function firstBytes(stream: NodeJS.ReadableStream & { destroy(): void }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const c of stream) {
      chunks.push(c as Buffer);
      n += (c as Buffer).length;
      if (n >= HEAD) break;
    }
  } catch {
    // a truncated gzip still shows its first bytes
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, HEAD);
}

/** pg_backup_archiver.c ReadHead: magic, version, int / offset sizes, format, compression, date, names. */
export function readDumpHeader(b: Buffer): PgDumpHeader {
  const none: PgDumpHeader = { dumpVersion: null, serverVersion: null, database: null };
  if (b.subarray(0, 5).toString('latin1') !== 'PGDMP' || b.length < 12) return none;
  const v = (b[5] << 16) | (b[6] << 8) | b[7];
  const intSize = b[8];
  let pos = 11; // after magic, 3 version bytes, intSize, offSize, format
  const readInt = () => {
    const neg = b[pos++];
    let val = 0;
    for (let i = 0; i < intSize; i++) val += b[pos + i] * 2 ** (8 * i);
    pos += intSize;
    return neg ? -val : val;
  };
  const readStr = () => {
    const l = readInt();
    if (l < 0 || pos + l > b.length) return null;
    const s = b.subarray(pos, pos + l).toString('utf8');
    pos += l;
    return s;
  };
  const vers = (maj: number, min: number) => (maj << 16) | (min << 8);
  try {
    if (v >= vers(1, 15)) pos++; // compression algorithm, one byte
    else if (v >= vers(1, 2)) readInt(); // compression level
    if (v < vers(1, 4)) return none;
    for (let i = 0; i < 7; i++) readInt(); // creation date
    const database = readStr();
    if (v < vers(1, 10)) return { ...none, database };
    const serverVersion = readStr();
    const dumpVersion = readStr();
    return { dumpVersion, serverVersion, database };
  } catch {
    return none;
  }
}

export async function sniff(path: string): Promise<Sniff> {
  const st = statSync(path);
  // Directory format: the folder, or its toc.dat picked in the file dialog.
  const dir = st.isDirectory() ? path : basename(path) === 'toc.dat' ? dirname(path) : null;
  if (dir && existsSync(join(dir, 'toc.dat'))) {
    const { buf } = await head(join(dir, 'toc.dat'));
    return { kind: 'pg-dir', dir, dump: readDumpHeader(buf) };
  }
  const { buf, gz } = await head(path);
  if (buf.subarray(0, 5).toString('latin1') === 'PGDMP') return { kind: 'pg-custom', gz, dump: readDumpHeader(buf) };
  if (buf.length >= 512 && buf.subarray(257, 262).toString('latin1') === 'ustar') {
    const first = buf.subarray(0, 100).toString('latin1').replace(/\0.*$/s, '');
    // pg_dump -Ft: toc.dat first, holding the same header as a custom archive.
    if (first === 'toc.dat') return { kind: 'pg-tar', gz, dump: readDumpHeader(buf.subarray(512)) };
    return { kind: 'tar', gz };
  }
  if (buf.includes(0)) return { kind: 'binary', gz };
  return { kind: 'text', gz };
}

/** "This file is a pg_dump custom-format archive (pg_dump 18.6)". */
export function describe(s: Sniff): string {
  const fmt = s.kind === 'pg-custom' ? 'custom-format' : s.kind === 'pg-tar' ? 'tar-format' : s.kind === 'pg-dir' ? 'directory-format' : '';
  const v = 'dump' in s && s.dump.dumpVersion ? ` (pg_dump ${s.dump.dumpVersion})` : '';
  return `a pg_dump ${fmt} archive${v}`;
}

// ------------------------------------------------------------------ Tools

export interface PgTool {
  path: string;
  version: string;
  major: number;
}

const exe = (name: string) => (isWin ? `${name}.exe` : name);
const subdirs = (dir: string) => {
  try {
    return readdirSync(dir).map((d) => join(dir, d));
  } catch {
    return [];
  }
};

/** Every folder that may hold PostgreSQL's client tools, most specific first. */
function binDirs(): string[] {
  const dirs: string[] = [];
  for (const app of ['DevCatz', 'DoCatz']) dirs.push(...subdirs(join(appDataDir(app), 'db-services', 'bin', 'postgresql')).map((d) => join(d, 'bin')));
  if (isMac) {
    for (const brew of ['/opt/homebrew/opt', '/usr/local/opt']) dirs.push(...subdirs(brew).filter((d) => /^(libpq|postgresql)(@\d+)?$/.test(basename(d))).map((d) => join(d, 'bin')));
    dirs.push(...subdirs('/Applications/Postgres.app/Contents/Versions').map((d) => join(d, 'bin')));
  }
  if (isWin) for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (pf) dirs.push(...subdirs(join(pf, 'PostgreSQL')).map((d) => join(d, 'bin')));
  if (isLinux) dirs.push(...subdirs('/usr/lib/postgresql').map((d) => join(d, 'bin')), ...subdirs('/usr').filter((d) => /^pgsql-\d+$/.test(basename(d))).map((d) => join(d, 'bin')));
  dirs.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean));
  if (!isWin) dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return [...new Set(dirs)];
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const cache = new Map<string, { at: number; tools: PgTool[] }>();

/** pg_restore / psql on this computer, one per major version, newest first. */
export async function findTools(name: 'pg_restore' | 'psql'): Promise<PgTool[]> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.tools;
  const byMajor = new Map<number, PgTool>();
  for (const dir of binDirs()) {
    const path = join(dir, exe(name));
    if (!existsSync(path)) continue;
    const { code, out } = await run(path, ['--version']);
    const m = code === 0 ? /(\d+)(?:\.(\d+))?/.exec(out) : null;
    if (!m) continue;
    const major = Number(m[1]);
    if (!byMajor.has(major)) byMajor.set(major, { path, version: m[2] ? `${m[1]}.${m[2]}` : m[1], major });
  }
  const tools = [...byMajor.values()].sort((a, b) => b.major - a.major);
  cache.set(name, { at: Date.now(), tools });
  return tools;
}

const majorOf = (v: string | null | undefined) => {
  const m = /(\d+)(?:\.(\d+))?/.exec(v ?? '');
  if (!m) return 0;
  // Before PostgreSQL 10 the major version was two numbers (9.6).
  return Number(m[1]) < 10 && m[2] ? Number(m[1]) + Number(m[2]) / 10 : Number(m[1]);
};

/** Where to get the tools, in this system's words. */
function installHint(major: number): string {
  const v = major ? ` ${Math.floor(major)}` : '';
  if (isMac) return `Install PostgreSQL${v} in DevCatz, or run: brew install libpq`;
  if (isWin) return `Install PostgreSQL${v} in DevCatz, or PostgreSQL from postgresql.org`;
  return `Install PostgreSQL${v} in DevCatz, or your distribution's postgresql-client package`;
}

/**
 * The tool for this dump and server: one at least as new as the pg_dump that wrote the dump (an older one cannot read
 * it), the server's own major version when there is one, else the newest.
 */
export async function pickTool(name: 'pg_restore' | 'psql', dumpVersion: string | null, serverVersion: string): Promise<PgTool> {
  const tools = await findTools(name);
  const need = majorOf(dumpVersion);
  const server = majorOf(serverVersion);
  const fit = tools.filter((t) => t.major >= need);
  if (!fit.length) {
    if (tools.length) throw new Error(`This dump was made by pg_dump ${dumpVersion}; the newest ${name} here is ${tools[0].version}, which cannot read it. ${installHint(need)}.`);
    throw new Error(`${name} was not found on this computer. ${installHint(Math.max(need, server))}.`);
  }
  return fit.find((t) => t.major === Math.floor(server)) ?? fit[0];
}

function pgEnv(e: PgEndpoint, tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: e.password, PGSSLMODE: e.sslmode, PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'DBCatz' };
  delete env.PGSERVICE;
  if (e.ca) {
    const file = join(tmp, 'ca.pem');
    writeFileSync(file, e.ca);
    env.PGSSLROOTCERT = file;
  }
  return env;
}

const target = (e: PgEndpoint, db: string) => ['-h', e.host, '-p', String(e.port), '-U', e.user, '-d', db, '--no-password'];

/** A gzipped archive or script, unpacked next to the temp files (pg_restore -j needs a file it can seek in). */
async function gunzipTo(path: string, tmp: string, name: string): Promise<string> {
  const out = join(tmp, name);
  await pipeline(createReadStream(path), createGunzip(), createWriteStream(out));
  return out;
}

/**
 * Runs a tool as a job: progress from its output, Cancel (the progress callback throws) stops it. Resolves with
 * stderr, rejects when it was cancelled or could not start.
 */
function runJob(cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void, tick: () => void): Promise<{ code: number; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, windowsHide: true });
    let err = '';
    let rest = '';
    let stopped: Error | null = null;
    const stop = (e: unknown) => {
      if (stopped) return;
      stopped = e instanceof Error ? e : new Error(String(e));
      p.kill();
    };
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        stop(e);
      }
    };
    p.stderr.on('data', (d: Buffer) => {
      const s = rest + d.toString('utf8');
      const lines = s.split(/\r?\n/);
      rest = lines.pop() ?? '';
      if (err.length < 200_000) err += d.toString('utf8');
      for (const l of lines) guard(() => onLine(l));
    });
    p.stdout.on('data', () => undefined);
    const timer = setInterval(() => guard(tick), 500);
    p.on('error', (e) => {
      clearInterval(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearInterval(timer);
      if (stopped) reject(stopped);
      else resolve({ code: code ?? -1, err });
    });
  });
}

/** The first errors, without the tool's prefix or the temp file's path ("line 37: ERROR: …"). */
const firstErrors = (err: string, tool: string) =>
  err
    .split(/\r?\n/)
    .filter((l) => /\berror:|ERROR:|FATAL:/.test(l))
    .map((l) =>
      l
        .replace(/^psql:.*?:(\d+):\s*/, 'line $1: ')
        .replace(new RegExp(`^${tool}:\\s*(error:\\s*)?(could not execute query:\\s*)?`), '')
        .trim(),
    )
    .slice(0, 2)
    .join(' · ');

/** What to do about the commonest restore errors. */
function hint(err: string): string {
  const role = /role "([^"]+)" does not exist/.exec(err);
  if (role) return ` The role ${role[1]} is not on this server: create it first, or restore a custom-format dump with owners and privileges skipped.`;
  if (/already exists/.test(err)) return ' The database already has these objects: tick "Replace existing objects", or import into an empty database.';
  return '';
}

/** The roles a dump's objects belong to (pg_restore -l: the owner ends each entry line). */
function ownersOf(list: string): string[] {
  const owners = new Set<string>();
  for (const l of list.split('\n')) {
    if (!l.trim() || l.startsWith(';')) continue;
    const owner = l.trim().split(/\s+/).pop();
    if (owner && owner !== '-') owners.add(owner);
  }
  return [...owners];
}

export interface PgCtx {
  endpoint: PgEndpoint;
  serverVersion: string;
}

/** pg_restore of a custom / tar / directory archive into `db`. */
export async function restoreArchive(d: Driver, ctx: PgCtx, path: string, s: Extract<Sniff, { dump: PgDumpHeader }>, db: string, o: DvPgRestoreOptions, progress: Progress): Promise<string> {
  const tool = await pickTool('pg_restore', s.dump.dumpVersion, ctx.serverVersion);
  const tmp = mkdtempSync(join(tmpdir(), 'dbcatz-restore-'));
  try {
    let file = s.kind === 'pg-dir' ? s.dir : path;
    if (s.kind !== 'pg-dir' && s.gz) {
      progress('Unpacking the gzip');
      file = await gunzipTo(path, tmp, s.kind === 'pg-tar' ? 'dump.tar' : 'dump.backup');
    }
    // The table of contents: how many steps, and whose objects.
    const list = await run(tool.path, ['-l', file]);
    if (list.code !== 0) throw new Error(`pg_restore ${tool.version} could not read ${describe(s)}: ${firstErrors(list.err, 'pg_restore') || list.err.trim().slice(0, 300)}`);
    const total = list.out.split('\n').filter((l) => l.trim() && !l.startsWith(';')).length;
    let skipOwners = o.owners === 'skip';
    let missing: string[] = [];
    if (o.owners === 'auto') {
      const roles = new Set((await d.query(db, 'SELECT rolname FROM pg_roles')).rows.map((r) => String(r[0])));
      missing = ownersOf(list.out).filter((r) => !roles.has(r));
      skipOwners = missing.length > 0;
    }
    const jobs = s.kind === 'pg-tar' ? 1 : Math.max(1, Math.min(16, Math.floor(o.jobs || 1)));
    const args = [
      ...target(ctx.endpoint, db),
      ...(o.clean ? ['--clean', '--if-exists'] : []),
      ...(skipOwners ? ['--no-owner', '--no-privileges'] : []),
      ...(jobs > 1 ? ['-j', String(jobs)] : []),
      '--verbose',
      file,
    ];
    const label = `pg_restore ${tool.version}${jobs > 1 ? `, ${jobs} jobs` : ''}`;
    let done = 0;
    let current = '';
    progress(`${label}: starting`, 0, total);
    const r = await runJob(
      tool.path,
      args,
      pgEnv(ctx.endpoint, tmp),
      (line) => {
        const m = /^pg_restore: (?:creating|processing data for table|processing item|executing|dropping|restoring large object)\s*(.*)$/.exec(line);
        if (m) {
          done = Math.min(total, done + 1);
          current = m[1].replace(/^"|"$/g, '');
        }
      },
      () => progress(`${label}: ${current || 'starting'}`, done, total),
    );
    const ignored = Number(/errors ignored on restore: (\d+)/.exec(r.err)?.[1] ?? 0);
    const owners = skipOwners ? (missing.length ? `; owners and privileges skipped (no role ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''} here)` : '; owners and privileges skipped') : '';
    if (r.code !== 0) {
      const first = firstErrors(r.err, 'pg_restore');
      if (ignored) throw new Error(`pg_restore finished with ${ignored} error${ignored === 1 ? '' : 's'}; the rest was restored. First: ${first || 'see the server log'}.${hint(r.err)}`);
      throw new Error(`${label}: ${first || r.err.trim().split('\n').pop() || `exit code ${r.code}`}.${hint(r.err)}`);
    }
    progress(`${label}: done`, total, total);
    return `Restored ${describe(s)} into ${db} with ${label}${owners}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A plain pg_dump (COPY … FROM stdin) through psql: statements one by one cannot carry the COPY data. */
export async function runPsql(ctx: PgCtx, path: string, gz: boolean, db: string, dumpVersion: string | null, progress: Progress): Promise<string> {
  const tool = await pickTool('psql', dumpVersion, ctx.serverVersion).catch((e: Error) => {
    throw new Error(`This SQL file loads data with COPY … FROM stdin (a plain pg_dump), which needs psql. ${e.message}`);
  });
  const tmp = mkdtempSync(join(tmpdir(), 'dbcatz-psql-'));
  try {
    const file = gz ? (progress('Unpacking the gzip'), await gunzipTo(path, tmp, 'dump.sql')) : path;
    const size = statSync(file).size;
    let n = 0;
    progress(`psql ${tool.version}: running`, 0, size);
    // ON_ERROR_STOP: the first error stops it, as DBCatz's own import does; -X: no ~/.psqlrc.
    const r = await runJob(
      tool.path,
      [...target(ctx.endpoint, db), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file],
      pgEnv(ctx.endpoint, tmp),
      () => n++,
      () => progress(`psql ${tool.version}: running${n ? ` (${n} notices)` : ''}`),
    );
    if (r.code !== 0) throw new Error(`psql ${tool.version} stopped at the first error, ${firstErrors(r.err, 'psql') || r.err.trim().split('\n').pop() || `exit code ${r.code}`}.${hint(r.err)}`);
    progress('Done', size, size);
    return `Ran ${basename(path)} in ${db} with psql ${tool.version}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
