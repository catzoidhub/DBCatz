import { computed, ref, watch } from 'vue';
import { showSettings } from '../store';
import { active, connections, openTab, tabs } from './viewer';

/**
 * Back / forward through the screens seen in this window, like a browser:
 * the ← → buttons in the title bar (right-click lists them), ⌘[ / ⌘], the
 * mouse's back / forward buttons, a three-finger swipe and Windows' browser
 * keys. A screen is a tab at a database, table and view (Data, Structure,
 * Query …), the Connections tab, or Settings. The history is kept on this
 * Mac across restarts; screens of the last session reopen their connection.
 */

export interface Place {
  /** Tab id ('home' = Connections). */
  tab: string;
  /** The connection, to reopen the tab when it was closed meanwhile. */
  connId?: string;
  db?: string;
  table?: string;
  mode?: string;
  settings?: boolean;
  /** A filter for the Data grid (Ask DBCatz's filter-rows). */
  where?: string;
}
export interface Entry extends Place {
  label: string;
  at: number;
}

const LIMIT = 50;
const backStack = ref<Entry[]>([]);
const forwardStack = ref<Entry[]>([]);
const here = ref<Entry | null>(null);

// ---- kept across restarts (localStorage: a convenience of this Mac)
const SAVE_KEY = 'dbcatz.nav';
/** Tab ids start again at tab-1 each launch: last session's are marked so they never match a new tab. */
const OLD = 'old:';
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as { back: Entry[]; here: Entry | null } | null;
    if (!saved) return;
    const mark = (e: Entry): Entry => ({ ...e, tab: e.tab === 'home' || e.tab.startsWith(OLD) ? e.tab : `${OLD}${e.tab}` });
    // Settings and Connections from last time are not worth going back to; places in connections are.
    const keep = (e: Entry) => !e.settings && e.tab !== 'home';
    backStack.value = [...(saved.back ?? []), ...(saved.here ? [saved.here] : [])].filter(keep).map(mark).slice(-LIMIT);
  } catch {
    /* nothing kept, or private mode */
  }
})();
watch([backStack, here], () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ back: backStack.value, here: here.value }));
  } catch {
    /* only a convenience */
  }
});
export const canBack = computed(() => backStack.value.length > 0);
export const canForward = computed(() => forwardStack.value.length > 0);
/** Newest first, as the right-click lists show them. */
export const backList = computed(() => [...backStack.value].reverse());
export const forwardList = computed(() => [...forwardStack.value].reverse());

/** Workspaces move themselves to a place (database, table, view); the promise ends once they are there (or says why not). */
const movers = new Map<string, (p: Place) => Promise<void> | void>();
export function onPlace(tab: string, fn: (p: Place) => Promise<void> | void): () => void {
  movers.set(tab, fn);
  return () => movers.delete(tab);
}

/** Where each workspace is now (it reports every change). */
const where = new Map<string, Place>();
const MODE_NAME: Record<string, string> = { data: 'Data', structure: 'Structure', query: 'Query', keys: 'Keys', logs: 'Logs' };

function labelOf(p: Place): string {
  if (p.settings) return 'Settings';
  if (p.tab === 'home') return 'Connections';
  const name = connections.value.find((c) => c.id === p.connId)?.name ?? 'Connection';
  return [name, p.db, p.table].filter(Boolean).join(' › ') + (p.mode ? ` · ${MODE_NAME[p.mode] ?? p.mode}` : '');
}
const same = (a: Place | null, b: Place) => !!a && a.tab === b.tab && !!a.settings === !!b.settings && (a.settings || (a.db ?? '') === (b.db ?? '') && (a.table ?? '') === (b.table ?? '') && (a.mode ?? '') === (b.mode ?? ''));

/** The screen now: Settings over everything, else the active tab where its workspace is. */
function current(): Place {
  if (showSettings.value) return { tab: active.value, settings: true };
  return where.get(active.value) ?? { tab: active.value };
}

let moving = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * Something changed: record the screen. Changes that come together (a new
 * database clears the table, a new tab connects) are one step.
 */
export function changed(): void {
  if (moving) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const p = current();
    if (same(here.value, p)) {
      // Same screen, maybe a better label (the connection list arrived).
      if (here.value) here.value = { ...here.value, ...p, label: labelOf(p) };
      return;
    }
    const e: Entry = { ...p, label: labelOf(p), at: Date.now() };
    if (here.value) backStack.value = [...backStack.value, here.value].slice(-LIMIT);
    forwardStack.value = [];
    here.value = e;
  }, 60);
}

/** A workspace's database / table / view changed. */
export function report(tab: string, p: Omit<Place, 'tab'>): void {
  where.set(tab, { tab, ...p });
  if (tab === active.value) changed();
}
export function forgetTab(tab: string): void {
  where.delete(tab);
  movers.delete(tab);
}

/** Moves `steps` back (negative) or forward; places whose connection is gone are skipped. */
export function go(steps: number): void {
  if (!steps) return;
  const from = steps < 0 ? backStack : forwardStack;
  const to = steps < 0 ? forwardStack : backStack;
  const n = Math.min(Math.abs(steps), from.value.length);
  if (!n || !here.value) return;
  const taken = from.value.slice(from.value.length - n).reverse(); // nearest first
  const target = taken[n - 1];
  from.value = from.value.slice(0, from.value.length - n);
  // What was passed over (and the screen we leave) goes on the other side, nearest last.
  to.value = [...to.value, here.value, ...taken.slice(0, n - 1)].slice(-LIMIT);
  here.value = target;
  if (!show(target)) {
    // The connection was deleted: skip this one too.
    here.value = to.value.pop() ?? null;
    if (from.value.length) go(steps < 0 ? -1 : 1);
  }
}
/** Connection tabs that are connected and listed (ready to move), or why they could not connect. */
export const tabStatus = new Map<string, 'ready' | { error: string }>();

/**
 * Goes to a connection (its open tab, or a new one), waits until it is
 * connected, then to a database / table / view, with a filter: Ask DBCatz's
 * actions. Recorded in the history like any move.
 */
export async function goTo(p: { connId: string; db?: string; table?: string; mode?: string; where?: string }): Promise<string> {
  const conn = connections.value.find((c) => c.id === p.connId);
  if (!conn) throw new Error('That connection is not in DBCatz any more');
  showSettings.value = false;
  let tab = tabs.value.find((t) => t.connection?.id === p.connId);
  if (tab) active.value = tab.id;
  else {
    openTab(conn, { fresh: true });
    tab = tabs.value[tabs.value.length - 1];
  }
  const id = tab.id;
  for (let i = 0; tabStatus.get(id) !== 'ready'; i++) {
    const st = tabStatus.get(id);
    if (st && st !== 'ready') throw new Error(`Could not connect to ${conn.name}: ${st.error}`);
    if (i > 600) throw new Error(`${conn.name} is taking too long to connect`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (p.db || p.table || p.mode || p.where) await movers.get(id)?.({ tab: id, connId: p.connId, db: p.db, table: p.table, mode: p.mode, where: p.where });
  return id;
}

export const back = () => go(-1);
export const forward = () => go(1);

function show(p: Entry): boolean {
  moving = true;
  try {
    if (p.settings) {
      showSettings.value = true;
      return true;
    }
    showSettings.value = false;
    if (p.tab === 'home') {
      active.value = 'home';
      return true;
    }
    // A screen of the last session: the connection's tab if it is open now.
    let tab = tabs.value.find((t) => t.id === p.tab) ?? (p.tab.startsWith(OLD) ? tabs.value.find((t) => t.connection?.id === p.connId) : undefined);
    if (tab && tab.id !== p.tab) {
      const id = tab.id;
      for (const list of [backStack, forwardStack]) list.value = list.value.map((e) => (e.tab === p.tab ? { ...e, tab: id } : e));
      here.value = { ...p, tab: id };
    }
    if (!tab) {
      // The tab was closed: open the connection again where it was.
      const conn = connections.value.find((c) => c.id === p.connId);
      if (!conn) return false;
      openTab(conn, { fresh: true, db: p.db, table: p.table, mode: p.mode });
      tab = tabs.value[tabs.value.length - 1];
      const id = tab.id;
      // Entries of the closed tab now live in the new one.
      for (const list of [backStack, forwardStack]) list.value = list.value.map((e) => (e.tab === p.tab ? { ...e, tab: id } : e));
      here.value = { ...p, tab: id };
    }
    active.value = tab.id;
    movers.get(tab.id)?.({ ...p, tab: tab.id });
    return true;
  } finally {
    // Watchers run after this tick (a database switch clears the table first): let them settle before recording again.
    setTimeout(() => (moving = false), 150);
  }
}
