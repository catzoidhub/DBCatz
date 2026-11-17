import type { DvActivity, DvSession, DvSessionTab } from '@shared/types';

/**
 * What the window shows for this run of DBCatz, kept in the main process (Catzoid #95 level 1): closing the window ends
 * its renderer, and reopening it brings back the Logs, the query History and the open tabs. Only for this run — a new
 * launch starts at Connections, so DBCatz never opens a connection (a production one, an SSH tunnel) by itself.
 * MCatzP reads the Logs and History from here, window open or not.
 */
const LOG_MAX = 500;
const HISTORY_MAX = 50;

const activity = new Map<string, DvActivity[]>();
const history = new Map<string, string[]>();
let tabs: DvSessionTab[] = [];
let active = -1;

const key = (connId: string, db: string) => `${connId}\n${db}`;

export function logActivity(connId: string, a: Partial<DvActivity> & { text: string }): DvActivity {
  const e: DvActivity = { time: typeof a.time === 'number' ? a.time : Date.now(), text: String(a.text).slice(0, 20_000), ms: a.ms ?? null, affected: a.affected ?? null, error: a.error ?? null };
  const list = activity.get(connId) ?? [];
  list.unshift(e);
  if (list.length > LOG_MAX) list.length = LOG_MAX;
  activity.set(connId, list);
  return e;
}

export function remember(connId: string, db: string, text: string): void {
  const k = key(connId, db);
  const t = String(text).slice(0, 100_000);
  history.set(k, [t, ...(history.get(k) ?? []).filter((x) => x !== t)].slice(0, HISTORY_MAX));
}

export const activityOf = (connId: string): DvActivity[] => [...(activity.get(connId) ?? [])];
export const historyOf = (connId: string, db: string): string[] => [...(history.get(key(connId, db)) ?? [])];

export function setTabs(list: DvSessionTab[], at: number): void {
  tabs = (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t.connId === 'string' && t.connId)
    .slice(0, 50)
    .map((t) => ({ connId: t.connId, db: typeof t.db === 'string' ? t.db : undefined, table: typeof t.table === 'string' ? t.table : undefined, mode: typeof t.mode === 'string' ? t.mode : undefined }));
  active = Number.isInteger(at) && at >= 0 && at < tabs.length ? at : -1;
}

export function snapshot(): DvSession {
  return {
    activity: Object.fromEntries(activity),
    history: Object.fromEntries([...history].map(([k, v]) => [k, v])),
    tabs,
    active,
  };
}
