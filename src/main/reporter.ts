import { app, crashReporter, net } from 'electron';
import { homedir } from 'node:os';
import type { DvReport, DvReportKind, DvReportSettings, ReportShot } from '@shared/types';
import { store } from './store';
import { siteBase } from './shared';
import { platformId } from './companion';
import { maskSecrets } from './ai';
import { installId, updateChannel } from './updater';

/**
 * Report a Bug / Send Feedback and opt-in crash reports (Catzoid family TODO #65; the API is the Catzoid site's
 * `POST <shared site address>/api/reports`, native crashes `…/api/reports/minidump`). Nothing leaves without the
 * user: feedback when they press Send, errors only once "Send crash reports" is on (asked once, after the first
 * error). Everything is scrubbed first — DBCatz reports never carry hosts, users, connection strings, queries, data or
 * file paths outside the app (home → ~). Offline: kept in a small queue and sent later.
 */

const KEY = 'reports';
const QUEUE_MAX = 20;
/** Screenshots on a bug report (Catzoid #67): how many, how large, and how many queued reports may keep theirs. */
const SHOTS_MAX = 3;
const SHOT_BYTES = 2.5 * 1024 * 1024;
const QUEUED_WITH_SHOTS = 3;

/** The screenshots that may go: PNG / JPEG by their bytes, at most SHOTS_MAX of at most SHOT_BYTES each. */
function checkShots(shots: unknown[]): ReportShot[] {
  if (shots.length > SHOTS_MAX) throw new Error(`At most ${SHOTS_MAX} screenshots`);
  return shots.map((x) => {
    const s = x as Partial<ReportShot>;
    const bytes = Buffer.from(String(s.data ?? ''), 'base64');
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpeg) throw new Error('Screenshots must be PNG or JPEG');
    if (bytes.length > SHOT_BYTES) throw new Error('A screenshot is too large — try a smaller window');
    return { type: png ? 'image/png' : 'image/jpeg', data: String(s.data) };
  });
}
const RETRY = 10 * 60_000;

interface Stored {
  /** null: not asked yet. */
  crash: boolean | null;
  queue: DvReport[];
  /** fingerprint → day sent (one report per crash kind per version per day). */
  sent: Record<string, string>;
}
function stored(): Stored {
  const s = store.extra<Partial<Stored>>(KEY) ?? {};
  return { crash: typeof s.crash === 'boolean' ? s.crash : null, queue: Array.isArray(s.queue) ? s.queue.slice(-QUEUE_MAX) : [], sent: s.sent && typeof s.sent === 'object' ? s.sent : {} };
}
const save = (patch: Partial<Stored>) => store.setExtra(KEY, { ...stored(), ...patch });

const HOME = homedir();
/** Strips what a report must never carry. */
export function scrub(text: string): string {
  return maskSecrets(text)
    .split(HOME)
    .join('~')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi, '<url>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|id|dev|tech|local|internal|cloud|app|co|me|xyz|localhost)\b(?::\d+)?/gi, '<host>')
    .replace(/'[^'\n]{0,400}'/g, "'…'")
    .replace(/"[^"\n]{0,400}"/g, '"…"')
    .replace(/`[^`\n]{0,400}`/g, '`…`');
}


function base(): Omit<DvReport, 'type' | 'message'> {
  return {
    app: 'dbcatz',
    version: app.getVersion(),
    channel: updateChannel(),
    os: process.platform === 'darwin' ? 'macos' : process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    platform: platformId() ?? undefined,
    installId: installId(),
  };
}

export class Reporter {
  /** The first error while "Send crash reports" was never answered: the window asks once. */
  onAsk: () => void = () => undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    const enabled = stored().crash === true;
    // Native crashes (main, renderer, GPU) as minidumps; uploaded only while the switch is on.
    crashReporter.start({ productName: 'DBCatz', submitURL: `${siteBase()}/api/reports/minidump`, uploadToServer: enabled, compress: true, globalExtra: { prod: 'dbcatz', ver: app.getVersion() } });
    process.on('uncaughtException', (e) => {
      console.error('Uncaught:', e);
      this.error('main', e);
    });
    process.on('unhandledRejection', (e) => {
      console.error('Unhandled rejection:', e);
      this.error('main', e instanceof Error ? e : new Error(String(e)));
    });
    this.timer = setInterval(() => void this.flush(), RETRY);
    setTimeout(() => void this.flush(), 15_000);
  }

  settings(): DvReportSettings {
    return { crash: stored().crash, queued: stored().queue.length };
  }

  configure(crash: boolean): DvReportSettings {
    save({ crash });
    crashReporter.setUploadToServer(crash);
    return this.settings();
  }

  /** What Send would post, for Preview what is sent. */
  preview(kind: DvReportKind, message: string, email: string, shots = 0): DvReport {
    const r: DvReport = { ...base(), type: 'feedback', message: scrub(message).slice(0, 10_000), process: 'user', extra: { kind } };
    const e = email.trim();
    if (e) r.email = e.slice(0, 200);
    if (kind === 'bug' && shots > 0) r.screenshots = `${Math.min(shots, SHOTS_MAX)} image(s), sent as separate parts — exactly as shown in the dialog`;
    return r;
  }

  /** Report a Bug / Send Feedback: sent now, or queued when the site cannot be reached. */
  async feedback(kind: DvReportKind, message: string, email: string, shots: unknown[] = []): Promise<'sent' | 'queued'> {
    if (!message.trim()) throw new Error('Write a few words first');
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('That email address does not look right');
    const r = this.preview(kind, message, email);
    if (kind === 'bug' && shots.length) r.shots = checkShots(shots);
    try {
      await post(r);
      return 'sent';
    } catch (e) {
      if (e instanceof ReportRefused) throw e;
      this.enqueue(r);
      return 'queued';
    }
  }

  /** An uncaught error (main or a window). Sent only with the switch on; the first one asks. */
  error(process: string, e: Error): void {
    const s = stored();
    if (s.crash === false) return;
    if (s.crash === null) {
      this.onAsk();
      return;
    }
    const message = scrub(e.message || String(e)).slice(0, 10_000);
    const day = new Date().toISOString().slice(0, 10);
    const fp = `${process}:${app.getVersion()}:${message.split('\n')[0].slice(0, 200)}`;
    if (s.sent[fp] === day) return;
    save({ sent: { ...Object.fromEntries(Object.entries(s.sent).filter(([, d]) => d === day)), [fp]: day } });
    const r: DvReport = { ...base(), type: 'error', message, stack: scrub(e.stack ?? '').slice(0, 20_000), process };
    void post(r).catch((err) => !(err instanceof ReportRefused) && this.enqueue(r));
  }

  private enqueue(r: DvReport): void {
    const queue = [...stored().queue, r].slice(-QUEUE_MAX);
    // screenshots are heavy: only the newest few queued reports keep theirs, older ones go without
    let withShots = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!queue[i].shots?.length) continue;
      if (++withShots > QUEUED_WITH_SHOTS) queue[i] = { ...queue[i], shots: undefined };
    }
    save({ queue });
  }

  /** Sends what waited for the network. */
  async flush(): Promise<void> {
    const q = stored().queue;
    if (!q.length) return;
    const left: DvReport[] = [];
    for (const r of q) {
      try {
        await post(r);
      } catch (e) {
        if (!(e instanceof ReportRefused)) left.push(r);
      }
    }
    save({ queue: left });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** The site answered no (bad input, too big): retrying would not help. */
class ReportRefused extends Error {}

async function post(r: DvReport): Promise<void> {
  const { shots, screenshots: _preview, ...report } = r;
  const headers: Record<string, string> = { 'X-Catzoid-Install': r.installId ?? '', 'X-Catzoid-Version': r.version, 'X-Catzoid-Channel': r.channel ?? 'stable' };
  let body: string | FormData;
  if (shots?.length) {
    // with screenshots: the same JSON in `report`, each image in an `image` part (Catzoid #67)
    const form = new FormData();
    form.append('report', JSON.stringify(report));
    shots.forEach((s, i) => form.append('image', new Blob([Buffer.from(s.data, 'base64')], { type: s.type }), `screenshot-${i + 1}.${s.type === 'image/png' ? 'png' : 'jpg'}`));
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(report);
  }
  const res = await net.fetch(`${siteBase()}/api/reports`, { method: 'POST', headers, body, signal: AbortSignal.timeout(shots?.length ? 60_000 : 15_000) });
  if (res.status === 201) return;
  const text = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 400 || res.status === 413 || res.status === 422) throw new ReportRefused(`The site refused the report: ${text || res.status}`);
  throw new Error(`The site answered ${res.status}${text ? `: ${text}` : ''}`);
}
