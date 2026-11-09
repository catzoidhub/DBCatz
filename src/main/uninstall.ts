import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findCatzoidApp } from './companion';
import type { DvUninstallPlan } from '@shared/types';
import { readShared, setSharedKey, SHARED_DIR } from './shared';
import { isLinux, isWin } from './platform';
import { runAsRootLinux, shq } from './linuxadmin';
import { appImageDesktopFile, appImageIconFile } from './appimage';
import type { DvAiProvider } from '@shared/types';
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
 *
 * Windows (as DevCatz): the data folder %APPDATA%\DBCatz (the connection secrets are DPAPI-encrypted inside it, in
 * Electron's Local State) and electron-updater's %LOCALAPPDATA%\dbcatz-updater go to the Recycle Bin, the app goes
 * with its own NSIS uninstaller (the app, its shortcuts, its entry in Installed apps), and the dbcatz:// link goes —
 * all from a small progress window that starts once DBCatz has quit (Windows keeps a running app's profile locked).
 * The shared AI keys are the Catzoid\keys\<provider>.dpapi files.
 *
 * Linux (TODO §18, as DevCatz and DoCatz): ~/.config/DBCatz, its caches, update downloads and the AppImage's menu entry
 * go after it quits; the app is the AppImage (deleted) or the .deb (`dpkg -r` behind the password prompt, while DBCatz
 * still runs). The shared AI keys are Secret Service items (shared.ts).
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

/** The running app bundle (…/DBCatz.app); on Windows the NSIS uninstaller next to DBCatz.exe. */
function bundle(): string | null {
  // Linux: the AppImage file, or a .deb's /opt/DBCatz.
  if (isLinux) return process.env.APPIMAGE || (process.execPath.startsWith('/opt/') ? dirname(process.execPath) : null);
  if (isWin) {
    const u = join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
    return existsSync(u) ? u : null;
  }
  const i = process.execPath.indexOf('.app/');
  return i > 0 ? process.execPath.slice(0, i + 4) : null;
}

async function keychainHas(service: string, account?: string): Promise<boolean> {
  // Windows: the shared AI keys are files (shared.ts); the connection secrets live in the data folder.
  if (isWin) return service === SHARED_KEYS && !!account && existsSync(join(SHARED_DIR, 'keys', `${account}.dpapi`));
  // Linux: the shared AI keys are Secret Service items (shared.ts); Electron's own safe storage is not listed there.
  if (isLinux) return service === SHARED_KEYS && !!account && (await run('secret-tool', ['lookup', 'service', service, 'account', account])).ok;
  return (await run('/usr/bin/security', ['find-generic-password', '-s', service, ...(account ? ['-a', account] : [])])).ok;
}

/** Another Catzoid app on this computer (its usual folder, its link handler, or Spotlight — companion.ts). */
async function installed(id: string, name: string): Promise<boolean> {
  return (await findCatzoidApp(name, name.toLowerCase(), id)) !== null;
}

function brew(): string | null {
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync) ?? null;
}
const homebrewInstall = () => ['/opt/homebrew/Caskroom/dbcatz', '/usr/local/Caskroom/dbcatz'].some(existsSync);

/** Windows: what DBCatz keeps outside its data folder (electron-updater's downloads). */
function winLeftovers(): { label: string; path: string }[] {
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  return [{ label: 'Update downloads', path: join(local, 'dbcatz-updater') }].filter((f) => existsSync(f.path));
}

/** Linux: the .deb package this DBCatz came from (null for an AppImage or a copied folder). */
async function linuxPackage(): Promise<string | null> {
  if (!isLinux || process.env.APPIMAGE) return null;
  const r = await run('dpkg', ['-S', process.execPath]);
  return r.ok ? r.out.split(':')[0]?.trim() || null : null;
}

/** Linux: what DBCatz keeps outside its data folder (caches, update downloads, the AppImage's menu entry). */
function linuxLeftovers(): { label: string; path: string }[] {
  const cache = process.env.XDG_CACHE_HOME || join(home, '.cache');
  return [
    { label: 'Caches', path: join(cache, 'DBCatz') },
    { label: 'Update downloads', path: join(cache, 'dbcatz-updater') },
    { label: 'The menu entry', path: appImageDesktopFile() },
    { label: 'The menu entry’s icon', path: appImageIconFile() },
  ].filter((f) => existsSync(f.path));
}

export async function uninstallPlan(): Promise<DvUninstallPlan> {
  if (isLinux) {
    const items = [{ label: 'Saved connections and their secrets, starred and recent databases, history, bridge.json', path: app.getPath('userData') }, ...linuxLeftovers()];
    const b = bundle();
    const pkg = await linuxPackage();
    // A folder under /opt that no package owns (copied there by hand) is root's: DBCatz cannot remove it, so it is not listed.
    if (b && app.isPackaged && (pkg || !b.startsWith('/opt/'))) items.push({ label: pkg ? `The app (the ${pkg} package, removed with your password)` : 'The app', path: b });
    const shared: { label: string; path: string }[] = [];
    if (existsSync(join(SHARED_DIR, 'shared.json'))) shared.push({ label: 'Theme, AI provider and site address shared by the Catzoid apps', path: join(SHARED_DIR, 'shared.json') });
    for (const p of readShared().ai?.keys ?? []) if (await keychainHas(SHARED_KEYS, p)) shared.push({ label: `${p} API key (${words.secretStore})`, path: `Keyring: ${SHARED_KEYS} · ${p}` });
    const otherApps: string[] = [];
    for (const o of OTHERS) if (await installed(o.id, o.name)) otherApps.push(o.name);
    return { items, shared, otherApps, homebrew: false, dryRun: dryRun() };
  }
  if (isWin) {
    const items = [{ label: `Saved connections and their secrets (${words.secretStore}), starred and recent databases, history, bridge.json`, path: app.getPath('userData') }, ...winLeftovers()];
    const u = bundle();
    if (u && app.isPackaged) items.push({ label: 'The app, its shortcuts and its entry in Installed apps (its own uninstaller)', path: u });
    const shared: { label: string; path: string }[] = [];
    if (existsSync(join(SHARED_DIR, 'shared.json'))) shared.push({ label: 'Theme, AI provider and site address shared by the Catzoid apps', path: join(SHARED_DIR, 'shared.json') });
    for (const p of readShared().ai?.keys ?? []) if (await keychainHas(SHARED_KEYS, p)) shared.push({ label: `${p} API key (${words.secretStore})`, path: join(SHARED_DIR, 'keys', `${p}.dpapi`) });
    const otherApps: string[] = [];
    for (const o of OTHERS) if (await installed(o.id, o.name)) otherApps.push(o.name);
    return { items, shared, otherApps, homebrew: false, dryRun: dryRun() };
  }
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
  if (isWin) {
    if (withShared) for (const p of readShared().ai?.keys ?? []) await setSharedKey(p as DvAiProvider, '').catch(() => undefined);
    const folders = [app.getPath('userData'), ...winLeftovers().map((f) => f.path), ...(withShared && existsSync(SHARED_DIR) ? [SHARED_DIR] : [])];
    await afterQuitWin(bundle(), folders);
    setImmediate(() => app.exit(0));
    return plan;
  }
  if (isLinux) {
    if (withShared) for (const p of readShared().ai?.keys ?? []) await setSharedKey(p as DvAiProvider, '').catch(() => undefined);
    // The .deb's files are root's: dpkg removes them (and the menu entry) behind the password prompt; a running program
    // keeps its open files, so DBCatz still finishes and quits.
    const pkg = await linuxPackage();
    if (pkg) {
      const r = await runAsRootLinux(`dpkg -r ${shq(pkg)} >/dev/null`);
      if (!r.ok) console.warn('uninstall: dpkg -r:', r.message);
    }
    const out = ['#!/bin/sh', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`];
    for (const f of plan.items) if (!f.path.startsWith('/opt/')) out.push(`rm -rf ${q(f.path)}`);
    if (withShared) out.push(`rm -f ${q(join(SHARED_DIR, 'shared.json'))}`, `rmdir ${q(SHARED_DIR)} 2>/dev/null`);
    out.push('rm -f "$0"');
    const script = join(tmpdir(), `dbcatz-uninstall-${process.pid}.sh`);
    writeFileSync(script, out.join('\n') + '\n', { mode: 0o700 });
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', cwd: dirname(script) }).unref();
    setImmediate(() => app.exit(0));
    return plan;
  }
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

/**
 * Windows: a detached PowerShell (DevCatz's helper) that finishes once DBCatz has quit, in a small window of its own so
 * the user sees it happen: waits for DBCatz to close, runs the NSIS uninstaller silently, removes the dbcatz:// link,
 * moves the folders to the Recycle Bin, says it is done and removes itself. Started by Task Scheduler as a task of
 * this user, not as DBCatz's child (a child went with DBCatz when it quit).
 */
async function afterQuitWin(uninstaller: string | null, folders: string[]): Promise<void> {
  const pq = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const task = `DBCatz uninstall ${Date.now()}`;
  const script = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$exe = ${pq(process.execPath)}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Win.Dpi]::SetProcessDPIAware() | Out-Null
[Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object Windows.Forms.Form
$f.Text = 'Uninstalling DBCatz'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.ClientSize = New-Object Drawing.Size(460, 254); $f.Font = New-Object Drawing.Font('Segoe UI', 9.5); $f.TopMost = $true
$f.Icon = [Drawing.Icon]::ExtractAssociatedIcon($exe)
$title = New-Object Windows.Forms.Label; $title.Text = 'Removing DBCatz from this PC'; $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 11)
$title.SetBounds(20, 16, 420, 26); $f.Controls.Add($title)
$names = @('Waiting for DBCatz to close', 'Removing the app, its shortcuts and its entry in Installed apps', 'Moving its data and settings to the Recycle Bin')
$rows = @(); $y = 52
foreach ($n in $names) { $l = New-Object Windows.Forms.Label; $l.Text = "○  $n"; $l.ForeColor = [Drawing.Color]::Gray; $l.SetBounds(20, $y, 420, 22); $f.Controls.Add($l); $rows += $l; $y += 26 }
$bar = New-Object Windows.Forms.ProgressBar; $bar.SetBounds(20, 136, 420, 14); $bar.Maximum = $names.Count; $f.Controls.Add($bar)
$note = New-Object Windows.Forms.Label; $note.Text = 'Your exports, backups and databases are not touched.'; $note.ForeColor = [Drawing.Color]::Gray; $note.SetBounds(20, 160, 420, 40); $f.Controls.Add($note)
$ok = New-Object Windows.Forms.Button; $ok.Text = 'Close'; $ok.SetBounds(350, 208, 90, 30); $ok.Enabled = $false; $ok.Add_Click({ $f.Close() }); $f.Controls.Add($ok)
$f.Show(); [Windows.Forms.Application]::DoEvents()
function Step($i) { if ($i -gt 0) { $rows[$i - 1].Text = '✓  ' + $names[$i - 1]; $rows[$i - 1].ForeColor = [Drawing.Color]::FromArgb(22, 128, 61) }; if ($i -lt $rows.Count) { $rows[$i].Text = '●  ' + $names[$i]; $rows[$i].ForeColor = [Drawing.SystemColors]::ControlText }; $bar.Value = $i; [Windows.Forms.Application]::DoEvents() }
function Wait($cond) { for ($i = 0; $i -lt 240 -and (& $cond); $i++) { Start-Sleep -Milliseconds 250; [Windows.Forms.Application]::DoEvents() } }
Step 0; Wait { Get-Process | Where-Object { $_.Path -eq $exe } }
Step 1
${uninstaller ? `$u = Start-Process -FilePath ${pq(uninstaller)} -ArgumentList '/S' -PassThru; Wait { -not $u.HasExited }
# The uninstaller hands over to a copy of itself in the temp folder and returns at once: wait for the app to go.
Wait { Test-Path $exe }` : ''}
# The dbcatz:// link Electron registered for this user (the uninstaller leaves it), when it still points here.
$link = 'HKCU:\Software\Classes\dbcatz'; if ((Get-ItemProperty "$link\shell\open\command").'(default)' -like "*$exe*") { Remove-Item -Recurse -Force $link }
Step 2
foreach ($p in @(${folders.map(pq).join(', ')})) { if (Test-Path $p) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch { Remove-Item -Recurse -Force $p } }; [Windows.Forms.Application]::DoEvents() }
Step 3
$title.Text = 'DBCatz has been removed'
$note.Text = 'Your exports, backups and databases are not touched. Its data is in the Recycle Bin until you empty it.'
$ok.Enabled = $true; $ok.Focus() | Out-Null
Remove-Item -Force $MyInvocation.MyCommand.Path
schtasks.exe /delete /tn ${pq(task)} /f | Out-Null
$t = New-Object Windows.Forms.Timer; $t.Interval = 30000; $t.Add_Tick({ $f.Close() }); $t.Start()
while ($f.Visible) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
`;
  const file = join(tmpdir(), `dbcatz-uninstall-${Date.now()}.ps1`);
  // UTF-8 with a byte-order mark: Windows PowerShell 5 reads a file without one as the ANSI code page (✓ ● ○).
  writeFileSync(file, `\ufeff${script.replace(/\r?\n/g, '\r\n')}`);
  const ps = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${file}"`;
  const made = await runCode('schtasks.exe', ['/create', '/tn', task, '/tr', ps, '/sc', 'once', '/st', '00:00', '/it', '/f']);
  if (made === 0 && (await runCode('schtasks.exe', ['/run', '/tn', task])) === 0) return;
  console.warn('uninstall: schtasks failed, starting the helper directly');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
const runCode = (cmd: string, args: string[]) =>
  new Promise<number>((resolve) => execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (e) => resolve(e ? Number((e as NodeJS.ErrnoException).code) || 1 : 0)));

