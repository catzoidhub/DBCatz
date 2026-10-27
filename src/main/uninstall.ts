import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DvUninstallPlan } from '@shared/types';
import { readShared, SHARED_DIR } from './shared';
import { words } from '@shared/platform';

/**
 * Uninstall DBCatz (Catzoid family TODO #55; the Homebrew cask's `zap` lists the same paths): what DBCatz put on this
 * Mac — its data folder (saved connections, starred / recent databases, history), the "DBCatz Safe Storage" Keychain
 * item (connection secrets), logs, caches, preferences and saved window state — then the app goes to the Trash (or
 * `brew uninstall --cask dbcatz` for a Homebrew install). The settings shared with the Catzoid apps go only when the
 * user switches them on (on by default only when no other Catzoid app is here, as in DialCatz). Exports and backups the user saved are never touched.
 *
 * The removal runs in a small shell script after DBCatz has quit, so nothing writes the files back on the way out.
 * DBCATZ_UNINSTALL_DRY (tests) and unpackaged builds only report the plan.
 */

const BUNDLE_ID = 'com.mrcatz.dbcatz';
const SAFE_STORAGE = 'DBCatz Safe Storage';
const SHARED_KEYS = 'Catzoid AI';
const OTHERS: { name: string; id: string }[] = [
  { name: 'DevCatz', id: 'com.mrcatz.devcatz' },
  { name: 'DialCatz', id: 'com.mrcatz.dialcatz' },
  { name: 'DoCatz', id: 'com.mrcatz.docatz' },
];

const home = homedir();
const lib = (...p: string[]) => join(home, 'Library', ...p);
const dryRun = () => !!process.env.DBCATZ_UNINSTALL_DRY || !app.isPackaged;
const run = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((resolve) => execFile(cmd, args, { timeout: 10_000 }, (e, out) => resolve({ ok: !e, out: String(out ?? '') })));

/** The running app bundle (…/DBCatz.app). */
function bundle(): string | null {
  const i = process.execPath.indexOf('.app/');
  return i > 0 ? process.execPath.slice(0, i + 4) : null;
}

async function keychainHas(service: string, account?: string): Promise<boolean> {
  return (await run('/usr/bin/security', ['find-generic-password', '-s', service, ...(account ? ['-a', account] : [])])).ok;
}

async function installed(id: string, name: string): Promise<boolean> {
  if ([join('/Applications', `${name}.app`), join(home, 'Applications', `${name}.app`)].some(existsSync)) return true;
  const r = await run('mdfind', [`kMDItemCFBundleIdentifier == '${id}'`]);
  return r.out.split('\n').some((p) => p.trim().endsWith('.app') && !p.includes('/.Trash/'));
}

function brew(): string | null {
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync) ?? null;
}
const homebrewInstall = () => ['/opt/homebrew/Caskroom/dbcatz', '/usr/local/Caskroom/dbcatz'].some(existsSync);

export async function uninstallPlan(): Promise<DvUninstallPlan> {
  const files: { label: string; path: string }[] = [
    { label: 'Saved connections, starred and recent databases, history, bridge.json', path: app.getPath('userData') },
    { label: 'Logs', path: app.getPath('logs') },
    { label: 'Caches', path: lib('Caches', 'DBCatz') },
    { label: 'Caches', path: lib('Caches', BUNDLE_ID) },
    { label: 'Update downloads', path: lib('Caches', `${BUNDLE_ID}.ShipIt`) },
    { label: 'Update downloads', path: lib('Caches', 'dbcatz-updater') },
    { label: 'Preferences', path: lib('Preferences', `${BUNDLE_ID}.plist`) },
    { label: 'Saved window state', path: lib('Saved Application State', `${BUNDLE_ID}.savedState`) },
    { label: 'Web storage', path: lib('HTTPStorages', BUNDLE_ID) },
  ].filter((f) => existsSync(f.path));
  const items = [...files];
  if (await keychainHas(SAFE_STORAGE)) items.push({ label: `Connection secrets (${words.secretStore})`, path: `Keychain: ${SAFE_STORAGE}` });
  const b = bundle();
  const homebrew = homebrewInstall();
  if (b && app.isPackaged) items.push({ label: homebrew ? 'The app (brew uninstall --cask dbcatz)' : 'The app (moved to the Trash)', path: b });

  const shared: { label: string; path: string }[] = [];
  if (existsSync(join(SHARED_DIR, 'shared.json'))) shared.push({ label: 'Theme, AI provider and site address shared by the Catzoid apps', path: join(SHARED_DIR, 'shared.json') });
  for (const p of readShared().ai?.keys ?? []) if (await keychainHas(SHARED_KEYS, p)) shared.push({ label: `${p} API key (${words.secretStore})`, path: `Keychain: ${SHARED_KEYS} · ${p}` });

  const otherApps: string[] = [];
  for (const o of OTHERS) if (await installed(o.id, o.name)) otherApps.push(o.name);
  return { items, shared, otherApps, homebrew, dryRun: dryRun() };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Removes DBCatz after it quits. `shared`: the shared Catzoid settings too. `beforeQuit` closes connections and jobs. */
export async function uninstallRun(confirm: string, shared: boolean, beforeQuit: () => Promise<void>): Promise<DvUninstallPlan> {
  if (confirm.trim() !== 'DBCatz') throw new Error('Type DBCatz to confirm');
  const plan = await uninstallPlan();
  const withShared = shared;
  if (plan.dryRun) return { ...plan, shared: withShared ? plan.shared : [] };

  await beforeQuit();
  const lines = ['#!/bin/sh', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`];
  for (const f of plan.items) {
    if (f.path.startsWith('Keychain: ')) lines.push(`/usr/bin/security delete-generic-password -s ${q(SAFE_STORAGE)} >/dev/null 2>&1`);
    else if (!f.path.endsWith('.app')) lines.push(`rm -rf ${q(f.path)}`);
  }
  if (withShared) {
    lines.push(`rm -f ${q(join(SHARED_DIR, 'shared.json'))}`, `rmdir ${q(SHARED_DIR)} 2>/dev/null`);
    for (const p of readShared().ai?.keys ?? []) lines.push(`/usr/bin/security delete-generic-password -s ${q(SHARED_KEYS)} -a ${q(p)} >/dev/null 2>&1`);
  }
  const b = bundle();
  const brewBin = brew();
  if (plan.homebrew && brewBin) lines.push(`${q(brewBin)} uninstall --cask dbcatz >/dev/null 2>&1`);
  else if (b) lines.push(`mv ${q(b)} ${q(join(home, '.Trash', `DBCatz ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.app`))}`);
  lines.push('rm -f "$0"');
  const script = join(tmpdir(), `dbcatz-uninstall-${process.pid}.sh`);
  writeFileSync(script, lines.join('\n') + '\n', { mode: 0o700 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', cwd: dirname(script) }).unref();
  setImmediate(() => app.exit(0));
  return plan;
}
