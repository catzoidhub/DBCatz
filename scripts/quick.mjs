// Quick build for this Mac (no notarization): quit the running DBCatz, build the app, replace
// /Applications/DBCatz.app with it, and open it again. `bun run quick`.
// /Applications is the one copy: the dist/ build is removed once installed, so Spotlight, Launchpad, the
// Dock and dbcatz:// links never find an older DBCatz.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const APP = '/Applications/DBCatz.app';
const BUILT = 'dist/quick/mac-arm64/DBCatz.app';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const PROC = 'DBCatz.app/Contents/MacOS/DBCatz';
const running = () => spawnSync('pgrep', ['-f', PROC]).status === 0;

// 1. Quit (gracefully, then wait; kill only if it hangs).
if (running()) {
  console.log('Quitting DBCatz…');
  spawnSync('osascript', ['-e', 'tell application id "com.mrcatz.dbcatz" to quit']);
  for (let i = 0; i < 50 && running(); i++) spawnSync('sleep', ['0.2']);
  if (running()) spawnSync('pkill', ['-f', PROC]);
}

// 2. Build the .app (signed with the Developer ID when it is in the keychain; not notarized).
run('bun', ['run', 'build']);
run('node_modules/.bin/electron-builder', ['--mac', 'dir', '--arm64', '-c.mac.notarize=false', '-c.directories.output=dist/quick'], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'true' } });
if (!existsSync(BUILT)) throw new Error(`${BUILT} was not built`);

// 3. Install.
if (existsSync(APP)) run('rm', ['-rf', APP]);
run('ditto', [BUILT, APP]);
run('rm', ['-rf', BUILT]);
const sig = spawnSync('codesign', ['--verify', '--deep', '--strict', APP], { encoding: 'utf8' });
console.log(sig.status === 0 ? 'Signature OK' : `Signature check: ${sig.stderr.trim() || 'unsigned (ad-hoc)'}`);

// 4. Open with a clean environment (a Claude Code / terminal shell's variables must not leak into the app).
const env = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, SHELL: process.env.SHELL ?? '/bin/zsh', TMPDIR: process.env.TMPDIR ?? '/tmp', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
spawnSync('/usr/bin/open', ['-F', APP], { env, stdio: 'inherit' });
console.log(`DBCatz installed at ${APP} and opened.`);
