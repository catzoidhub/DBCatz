import { type ActionDef, type BridgeEntry, type ConfirmAnswer, McatzpHost } from '@catzoid/mcatzp-host';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app } from 'electron';
import type { DbCatzApi, DvConnection, McatzpAsk } from '@shared/types';
import { setBridgeMcatzp } from '../bridge';
import { saveMcatzpShared, setMcatzpClients, settings } from '../settings';
import { findConnection, type ReadQuery, readActions, type Scopes, type WindowReads } from './actions';
import { ActivityLog } from './activity';
import { type ChangeAction, changeActions, type McatzpPage } from './changes';

/** Unanswered questions lapse before MCatzP stops waiting (3 and 10 minutes), so a late Allow never runs for nobody. */
const PAIR_WAIT_MS = 150_000;
const CHANGE_WAIT_MS = 9 * 60_000;

/** What the controller needs from the viewer: its connections right now, without a round through the API. */
interface Viewer extends ReadQuery {
  connections(): DvConnection[];
  closeReaders(): void;
}

/** What it needs from the window. */
export interface McatzpWindow extends WindowReads {
  show(ask: McatzpAsk | null): void;
  settingsChanged(): void;
  /** After Allow: the page of what was asked. */
  open(page: McatzpPage): void;
  /** A change ran: the window reloads what it shows. */
  refresh(): void;
  logQuery(connId: string, r: { text: string; ms: number; affected: number | null; error: string | null }): void;
}

/**
 * DBCatz's end of MCatzP: the local channel from the shared host, open only while Settings → MCatzP is on. Approved
 * clients and what is shared live in the settings, the activity log in its own file (TODO §16). DevCatz's
 * src/main/mcatzp/index.ts is the model; keep the two alike.
 */
export class Mcatzp {
  readonly activity = new ActivityLog(join(app.getPath('userData'), 'mcatzp-activity.jsonl'));
  private readonly host: McatzpHost;
  /** start() / stop() run one after the other: the switch can flip while the socket is still opening. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Questions waiting for the dialog, the oldest first; it shows one at a time. */
  private asks: { ask: McatzpAsk; done(answer: ConfirmAnswer): void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    private readonly api: DbCatzApi,
    private readonly viewer: Viewer,
    private readonly win: McatzpWindow,
  ) {
    this.host = new McatzpHost({
      app: { id: 'dbcatz', name: 'DBCatz', version: app.getVersion() },
      dataDir: app.getPath('userData'),
      actions: () => this.actions(),
      isPaired: (name) => settings().mcatzp.clients.some((c) => c.name === name),
      onPaired: (name) => {
        if (!settings().mcatzp.clients.some((c) => c.name === name)) setMcatzpClients([...settings().mcatzp.clients, { name, approvedAt: new Date().toISOString() }]);
        setBridgeMcatzp(this.host.entry());
        this.win.settingsChanged();
      },
      approved: () => settings().mcatzp.clients.map((c) => c.name),
      // A connection named in the call must be shared; one that does not exist answers with its own error in run().
      inScope: (_action, args) => {
        if (typeof args.connection !== 'string') return true;
        try {
          return this.scopes().connection(findConnection(this.viewer.connections(), args.connection));
        } catch {
          return true;
        }
      },
      pair: (client) => this.ask({ id: randomUUID(), kind: 'pair', client: client.name, version: client.version ?? null }, PAIR_WAIT_MS).then((a) => a !== 'deny'),
      confirm: async (req) => {
        const change = this.changes().find((c) => c.name === req.action.name);
        if (!change) return 'deny';
        if (change.noDialog) return 'once';
        // If this throws, the action never runs: its error goes to the client instead of a question.
        const { page, ...question } = await change.preview(req.args);
        const answer = await this.ask({ id: randomUUID(), kind: 'change', client: req.client, allowSession: req.allowSession && !question.typeName, ...question }, CHANGE_WAIT_MS, req.signal);
        // The user is right here and just said yes: take them to what is happening. Not for allowed-for-the-session calls.
        if (answer !== 'deny' && !req.signal.aborted && page) this.win.open(page);
        return answer;
      },
      log: (e) => this.activity.add(e),
    });
    setBridgeMcatzp(this.host.entry());
  }

  private actions(): ActionDef[] {
    const reads = readActions(this.api, this.viewer, this.scopes(), this.win, (id, r) => this.win.logQuery(id, r));
    // The window follows what a client changed, as if it was done there.
    const changes = this.changes().map((c) => ({
      ...c,
      run: async (args: Record<string, unknown>, ctx: Parameters<ChangeAction['run']>[1]) => {
        const out = await c.run(args, ctx);
        this.win.refresh();
        return out;
      },
    }));
    return [...reads, ...changes];
  }

  private changes(): ChangeAction[] {
    return changeActions(this.api, this.scopes(), (id, r) => this.win.logQuery(id, r), (id) => {
      saveMcatzpShared(id);
      this.host.notifyChanged();
      this.win.settingsChanged();
    });
  }

  private scopes(): Scopes {
    const s = settings().mcatzp;
    const shared = new Set(s.connections);
    return {
      // A connection opened from a URL is for this session and this window. Production never goes along with "all".
      connection: (c) => !c.temporary && (shared.has(c.id) || (s.all && c.options.mode !== 'production')),
      rows: s.rows,
      changes: s.changes,
    };
  }

  /** The switch: opens or closes the channel and tells bridge.json. */
  set(on: boolean): Promise<void> {
    const next = this.queue.then(async () => {
      if (on === this.host.running) return;
      if (!on) {
        for (const a of this.asks.splice(0)) {
          clearTimeout(a.timer);
          a.done('deny');
        }
        this.win.show(null);
        this.viewer.closeReaders();
      }
      setBridgeMcatzp(await (on ? this.host.start() : this.host.stop()));
    });
    this.queue = next.catch((e) => console.warn('MCatzP channel:', (e as Error).message));
    return next;
  }

  /** The app is quitting and will not wait: bridge.json says off now, the socket closes as far as it gets. */
  quit(): void {
    if (!this.host.running) return;
    const { channel: _c, tokenFile: _t, ...entry } = this.host.entry();
    // `closed` tells the server the app is shut, not that the switch is off. The field is newer than the published protocol types.
    setBridgeMcatzp({ ...entry, enabled: false, closed: true } as BridgeEntry);
    void this.host.stop().catch(() => undefined);
  }

  /** What is shared changed: connected clients get the new list of tools. */
  scopesChanged(): void {
    this.host.notifyChanged();
  }

  /** Forgets a client and closes every connection (a new token): the others reconnect, this one asks again. */
  revoke(name: string): Promise<void> {
    setMcatzpClients(settings().mcatzp.clients.filter((c) => c.name !== name));
    setBridgeMcatzp(this.host.entry());
    this.win.settingsChanged();
    const next = this.queue.then(async () => {
      if (!this.host.running) return;
      await this.host.stop();
      setBridgeMcatzp(await this.host.start());
    });
    this.queue = next.catch((e) => console.warn('MCatzP channel:', (e as Error).message));
    return next;
  }

  private ask(ask: McatzpAsk, waitMs: number, gone?: AbortSignal): Promise<ConfirmAnswer> {
    return new Promise((done) => {
      const timer = setTimeout(() => this.answer(ask.id, 'deny'), waitMs);
      this.asks.push({ ask, done, timer });
      // The client gave up or left: nobody is waiting for this any more, so the question must not stay to be allowed later.
      gone?.addEventListener('abort', () => this.answer(ask.id, 'deny'), { once: true });
      if (this.asks.length === 1) this.win.show(ask);
    });
  }

  /** What a window that just opened should show. */
  pending(): McatzpAsk | null {
    return this.asks[0]?.ask ?? null;
  }

  /** The user's answer in the dialog (or the wait running out); then the next question, if any. */
  answer(id: string, answer: ConfirmAnswer, typed?: string): void {
    const at = this.asks.findIndex((a) => a.ask.id === id);
    if (at < 0) return;
    // The dialog checks this too; here it is what counts.
    const need = this.asks[at].ask.kind === 'change' ? (this.asks[at].ask as { typeName?: string }).typeName : undefined;
    if (need && answer !== 'deny' && typed?.trim() !== need) throw new Error(`Type ${need} to confirm`);
    const [a] = this.asks.splice(at, 1);
    clearTimeout(a.timer);
    a.done(answer);
    this.win.show(this.asks[0]?.ask ?? null);
  }
}
