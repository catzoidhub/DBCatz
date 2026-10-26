import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DvAiProvider, Theme } from '@shared/types';

/**
 * Settings shared by the Catzoid apps (DevCatz, DBCatz, later DialCatz): the theme and the AI connection
 * (provider, models, addresses). One owner-only JSON file every app reads, writes and watches, so a change in
 * one app shows up in the others; API keys sit in one Keychain item ("Catzoid AI", an account per provider)
 * read through macOS's `security` tool — the way git's and gh's credential helpers keep tokens.
 * Kept in step with DevCatz's src/main/shared.ts by hand.
 *
 * Contract (keep it the same in every app):
 *   ~/Library/Application Support/Catzoid/shared.json  (folder 0700, file 0600)
 *   { "version": 1, "theme": "system" | "light" | "dark",
 *     "ai": { "provider": "anthropic", "models": { "<provider>": "<model>" }, "baseUrls": { … }, "keys": ["<provider>", …] },
 *     "updatedBy": "devcatz" | "dbcatz", "updatedAt": "<ISO time>" }
 *   Keychain: generic password, service "Catzoid AI", account = provider id, password = the API key.
 *   On / off switches (AI enabled, features) stay in each app.
 *
 * CATZOID_SHARED_DIR and CATZOID_KEYCHAIN (a keychain file) point both elsewhere, for tests.
 */

export const SHARED_DIR = process.env.CATZOID_SHARED_DIR || join(homedir(), 'Library', 'Application Support', 'Catzoid');
const FILE = join(SHARED_DIR, 'shared.json');
const SERVICE = 'Catzoid AI';
const ME = 'dbcatz';
/** A keychain file instead of the login keychain (tests only). */
const KEYCHAIN = process.env.CATZOID_KEYCHAIN ? [process.env.CATZOID_KEYCHAIN] : [];

export interface SharedAi {
  provider?: DvAiProvider;
  models?: Partial<Record<DvAiProvider, string>>;
  baseUrls?: Partial<Record<DvAiProvider, string>>;
  /** Providers with a key in the Keychain (names only). */
  keys?: DvAiProvider[];
}
export interface Shared {
  version: 1;
  theme?: Theme;
  ai?: SharedAi;
  /** The Catzoid site address the apps build their links from (Catzoid TODO #50); catzoid.com when unset. */
  site?: string;
  updatedBy?: string;
  updatedAt?: string;
}

let cache: Shared | null = null;

export function readShared(): Shared {
  if (cache) return cache;
  try {
    const v = JSON.parse(readFileSync(FILE, 'utf8')) as Shared;
    cache = v && typeof v === 'object' ? { ...v, version: 1 } : { version: 1 };
  } catch {
    cache = { version: 1 };
  }
  return cache;
}

/** For testing, shared.json's `site` points at https://dev.catzoid.tech (Catzoid TODO #64); unset means production. */
export const DEFAULT_SITE = 'https://catzoid.com';

/** The shared site address: https on catzoid.com or *.catzoid.tech only (anything else falls back to the default). */
export function siteBase(): string {
  // a development build may point at a local Catzoid site (CATZOID_SITE=http://127.0.0.1:8099), as DevCatz does
  const dev = !app.isPackaged && process.env.CATZOID_SITE;
  try {
    const u = new URL(dev || readShared().site || DEFAULT_SITE);
    if (dev && /^https?:$/.test(u.protocol)) return u.origin;
    if (u.protocol === 'https:' && /^(catzoid\.com|([\w-]+\.)*catzoid\.tech)$/.test(u.hostname)) return u.origin;
  } catch {
    /* not a URL */
  }
  return DEFAULT_SITE;
}

/** Merges `patch` (ai merged one level deep) and writes the file atomically. */
export function writeShared(patch: Partial<Omit<Shared, 'version' | 'ai'>> & { ai?: SharedAi }): Shared {
  const cur = readShared();
  const next: Shared = { ...cur, ...patch, ai: patch.ai ? { ...(cur.ai ?? {}), ...patch.ai } : cur.ai, version: 1, updatedBy: ME, updatedAt: new Date().toISOString() };
  mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SHARED_DIR, 0o700);
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, FILE);
  cache = next;
  lastOwnWrite = next.updatedAt!;
  return next;
}

let lastOwnWrite = '';
let watcher: FSWatcher | null = null;

/** Calls `onChange` when another app changed the file (own writes are ignored). */
export function watchShared(onChange: (s: Shared) => void): void {
  watcher?.close();
  mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | null = null;
  try {
    watcher = watch(SHARED_DIR, (_e, name) => {
      if (name && name !== 'shared.json') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cache = null;
        keyCache.clear();
        const s = readShared();
        if (s.updatedAt && s.updatedAt === lastOwnWrite) return;
        onChange(s);
      }, 250);
    });
  } catch {
    /* folder vanished: no live updates, the next read still sees changes */
  }
}

export const sharedExists = () => existsSync(FILE);

// ---------------------------------------------------------------- Keychain

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) =>
    execFile('/usr/bin/security', args, { timeout: 15_000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') })),
  );
}

const keyCache = new Map<DvAiProvider, { at: number; key: string }>();

/** The provider's API key from the shared Keychain item ('' when there is none). Cached for a minute. */
export async function sharedKey(provider: DvAiProvider): Promise<string> {
  const hit = keyCache.get(provider);
  if (hit && Date.now() - hit.at < 60_000) return hit.key;
  const r = await security(['find-generic-password', '-s', SERVICE, '-a', provider, '-w', ...KEYCHAIN]);
  const key = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  keyCache.set(provider, { at: Date.now(), key });
  return key;
}

/** Saves (or with '' removes) a provider's key in the shared Keychain item and lists it in shared.json. */
export async function setSharedKey(provider: DvAiProvider, key: string): Promise<void> {
  const k = key.trim();
  if (!k) {
    await security(['delete-generic-password', '-s', SERVICE, '-a', provider, ...KEYCHAIN]);
  } else {
    if (/["\\\n\r]/.test(k)) throw new Error('That key has characters an API key does not have');
    // Through `security -i` (commands on stdin), so the key never appears in a process list.
    await new Promise<void>((resolve, reject) => {
      const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (c) => (c === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain: ${err.trim() || `exit ${c}`}`))));
      p.stdin.end(`add-generic-password -U -s "${SERVICE}" -a "${provider}" -l "${SERVICE} (${provider})" -w "${k}"${KEYCHAIN.length ? ` "${KEYCHAIN[0]}"` : ''}\n`);
    });
  }
  keyCache.delete(provider);
  const keys = new Set(readShared().ai?.keys ?? []);
  if (k) keys.add(provider);
  else keys.delete(provider);
  writeShared({ ai: { keys: [...keys] } });
}
