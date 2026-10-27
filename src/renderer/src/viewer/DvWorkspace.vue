<script setup lang="ts">
import { keyLabel, words as platformWords } from '@shared/platform';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DvConnection, DvTable } from '@shared/types';
import { attempt, api, notify, openDevCatzDownload } from '../store';
import CatMood from './CatMood.vue';
import { DB_LOGO } from '../db';
import DvProgress from './DvProgress.vue';
import devcatzLogo from '../assets/logos/devcatz.png';
import { confirmProdWrite, isProd, isReadOnly, isSql, active, closeTab, editing, jobs, ENGINE_NAME, newToken, progress, DV_HINT, fmtBytes, fmtNum, isKv, isSystemDb, isSystemTable, logActivity, onCommand, tabState, words, type Command } from './viewer';
import DvDataGrid from './DvDataGrid.vue';
import DvStructure from './DvStructure.vue';
import DvQuery from './DvQuery.vue';
import DvKeys from './DvKeys.vue';
import DvPrompt from './DvPrompt.vue';
import DvDanger from './DvDanger.vue';
import DvCreateTable from './DvCreateTable.vue';
import DvTransfer from './DvTransfer.vue';
import DvLogs from './DvLogs.vue';
import DvCreateDatabase from './DvCreateDatabase.vue';
import DvDbPicker from './DvDbPicker.vue';
import DvBulkDanger from './DvBulkDanger.vue';
import { forgetTab, onPlace, report, tabStatus } from './nav';
import DvNavButtons from './DvNavButtons.vue';

/**
 * One connection's workspace: databases and tables in the sidebar, the
 * Data / Structure / Query (or Keys / Command) area on the right, and the
 * dialogs the toolbar, context menus and native menus open.
 */
const props = defineProps<{ connection: DvConnection; active: boolean; tabId: string; initialDb?: string; initialTable?: string; initialMode?: string }>();
const c = computed(() => props.connection);
const W = computed(() => words(c.value.engine));
const kv = computed(() => isKv(c.value.engine));

const info = ref<{ version: string; user: string } | null>(null);
const error = ref<string | null>(null);
const connecting = ref(true);
const databases = ref<string[]>([]);
const db = ref('');
const tables = ref<DvTable[]>([]);
const loadingTables = ref(false);
const table = ref('');
const filter = ref('');
type Mode = 'data' | 'structure' | 'query' | 'keys' | 'logs';
const mode = ref<Mode>('data');
const userDbs = computed(() => databases.value.filter((d) => !isSystemDb(c.value.engine, d)));
const systemDbs = computed(() => databases.value.filter((d) => isSystemDb(c.value.engine, d)));
const filtered = computed(() => tables.value.filter((t) => !filter.value || t.name.toLowerCase().includes(filter.value.toLowerCase())));
// The user's own tables first; the ones the server ships with in a System tables group below.
const ownTables = computed(() => filtered.value.filter((t) => !isSystemTable(c.value.engine, db.value, t.name)));
const systemTables = computed(() => filtered.value.filter((t) => isSystemTable(c.value.engine, db.value, t.name)));
const systemCount = computed(() => tables.value.filter((t) => isSystemTable(c.value.engine, db.value, t.name)).length);
/** The System tables group is open: by choice, or because there is nothing else to show / the filter or the open table is in it. */
const systemOpen = ref(false);
const showSystem = computed(() => systemOpen.value || !!filter.value || ownTables.value.length === 0 || systemTables.value.some((t) => t.name === table.value));
watch(db, () => (systemOpen.value = false));
const current = computed(() => tables.value.find((t) => t.name === table.value) ?? null);
/** Query editors remount per database; the grid per table. */
const gridKey = ref(0);

/** The current connection attempt (progress steps arrive as viewer:progress for this token). */
const token = ref('');
/** Disconnect was used (here, in the list or the menu): the tab waits for Reconnect. */
const disconnected = ref(false);
watch(
  () => c.value.connected,
  (now, before) => {
    if (before && !now && !connecting.value && !error.value) disconnected.value = true;
  },
);
async function disconnect() {
  await api.dvDisconnect(c.value.id);
  disconnected.value = true;
}
async function connect() {
  connecting.value = true;
  disconnected.value = false;
  error.value = null;
  tabStatus.delete(props.tabId);
  const mine = (token.value = newToken(props.tabId));
  try {
    info.value = await api.dvServerInfo(c.value.id, mine);
    if (token.value !== mine) return; // cancelled meanwhile
    databases.value = await api.dvDatabases(c.value.id);
    const wanted = props.initialDb && databases.value.includes(props.initialDb) ? props.initialDb : c.value.database && databases.value.includes(c.value.database) ? c.value.database : null;
    db.value = wanted ?? userDbs.value[0] ?? databases.value[0] ?? '';
    mode.value = kv.value ? 'keys' : 'data';
    if (props.initialTable) pendingTable = props.initialTable;
    // Reopened by back / forward: the view it was at (applied once the table list is in).
    if (props.initialMode && ['data', 'structure', 'query', 'keys', 'logs'].includes(props.initialMode)) pendingMode = props.initialMode as Mode;
  } catch (e) {
    if (token.value !== mine) return;
    error.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    tabStatus.set(props.tabId, { error: error.value });
  }
  connecting.value = false;
}
/** Cancel always ends the wait here, even when the attempt is already past the point of aborting. */
function cancelConnect() {
  const t = token.value;
  void api.dvCancelConnect(t);
  token.value = '';
  connecting.value = false;
  error.value = 'Cancelled';
}

/** A table to select once the list is in (a duplicated tab). */
let pendingTable: string | null = null;
/** The view to show once the list is in (back / forward to another database). */
let pendingMode: Mode | null = null;
/** Resolved when the table list of a newly picked database is in (Ask DBCatz waits for it). */
let loaded: (() => void) | null = null;
async function loadTables(keep = true) {
  if (!db.value) {
    tables.value = [];
    tabStatus.set(props.tabId, 'ready');
    loaded?.();
    loaded = null;
    return;
  }
  loadingTables.value = true;
  const list = await attempt(() => api.dvTables(c.value.id, db.value));
  loadingTables.value = false;
  tables.value = list ?? [];
  if (!keep || !tables.value.some((t) => t.name === table.value)) table.value = '';
  if (pendingTable && tables.value.some((t) => t.name === pendingTable)) table.value = pendingTable;
  pendingTable = null;
  if (pendingMode) {
    const m = pendingMode;
    pendingMode = null;
    await nextTick(); // after the table watcher, which would switch Query / Logs back to Data
    mode.value = m;
  }
  tabStatus.set(props.tabId, 'ready');
  loaded?.();
  loaded = null;
}

const refreshing = ref(false);
async function refreshAll() {
  refreshing.value = true;
  try {
    await refreshNow();
  } finally {
    refreshing.value = false;
  }
}
async function refreshNow() {
  void api.aiForget(c.value.id, db.value);
  const list = await attempt(() => api.dvDatabases(c.value.id));
  if (list) databases.value = list;
  if (!databases.value.includes(db.value)) db.value = databases.value[0] ?? '';
  await loadTables();
  gridKey.value++;
}

watch(db, () => {
  table.value = '';
  void loadTables(false);
});
watch(table, (t) => {
  if (t && (mode.value === 'query' || mode.value === 'logs')) mode.value = 'data';
});
/** Runs a change and records it in the connection's activity log. */
async function act(text: string, fn: () => Promise<unknown>): Promise<boolean> {
  const t0 = Date.now();
  try {
    await fn();
    logActivity(c.value.id, { text, ms: Date.now() - t0, affected: null, error: null });
    return true;
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    logActivity(c.value.id, { text, ms: Date.now() - t0, affected: null, error: msg });
    notify('error', msg);
    return false;
  }
}

onMounted(connect);

function pick(t: DvTable) {
  table.value = t.name;
  if (mode.value !== 'structure') mode.value = 'data';
}

// ---- several tables picked: ⌘-click toggles, ⇧-click a range, ⌘A all, Esc none; the right-click menu acts on them
const picked = ref<Set<string>>(new Set());
let anchor = '';
/** The tables in the order the sidebar shows them. */
const shownTables = computed(() => [...ownTables.value, ...(showSystem.value ? systemTables.value : [])]);
watch(db, () => (picked.value = new Set()));
watch(tables, () => (picked.value = new Set([...picked.value].filter((n) => tables.value.some((t) => t.name === n)))));
function clickTable(e: MouseEvent, t: DvTable) {
  if (e.metaKey || e.ctrlKey) {
    const s = new Set(picked.value.size ? picked.value : table.value ? [table.value] : []);
    s.has(t.name) ? s.delete(t.name) : s.add(t.name);
    picked.value = s;
    anchor = t.name;
    return;
  }
  if (e.shiftKey && (anchor || table.value)) {
    const names = shownTables.value.map((x) => x.name);
    const a = names.indexOf(anchor || table.value);
    const b = names.indexOf(t.name);
    if (a >= 0 && b >= 0) {
      picked.value = new Set(names.slice(Math.min(a, b), Math.max(a, b) + 1));
      return;
    }
  }
  picked.value = new Set();
  anchor = t.name;
  pick(t);
}
const sidebarList = ref<HTMLElement | null>(null);
/** ⌘A (Edit → Select All) while the table list has the focus. */
function selectAllTables(): boolean {
  if (!sidebarList.value?.contains(document.activeElement)) return false;
  picked.value = new Set(shownTables.value.map((t) => t.name));
  return true;
}
const kindOf = (t: DvTable) => (c.value.engine === 'mongodb' ? 'collection' : c.value.engine === 'elasticsearch' ? 'index' : t.type);
/** The picked tables in sidebar order. */
const pickedList = () => shownTables.value.map((t) => t.name).filter((n) => picked.value.has(n));
const quoteName = (n: string) => (c.value.engine === 'mysql' || c.value.engine === 'mariadb' ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`);

async function bulk(kind: 'drop' | 'truncate', list: string[], confirm: string, force: boolean) {
  busy.value = true;
  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof api.dvDropTables>> | undefined;
  try {
    // A plain array: a reactive one cannot cross the context bridge.
    r = await (kind === 'drop' ? api.dvDropTables : api.dvTruncateTables)(c.value.id, db.value, [...list], confirm, force);
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    logActivity(c.value.id, { text: `${kind === 'drop' ? 'Drop' : 'Truncate'} ${list.length} in ${db.value}${force ? ' (force)' : ''}: ${list.join(', ')}`, ms: Date.now() - t0, affected: null, error: msg });
    notify('error', msg);
  }
  busy.value = false;
  if (!r) return;
  logActivity(c.value.id, { text: `${kind === 'drop' ? 'Drop' : 'Truncate'} ${r.done.length} in ${db.value}${force ? ' (force)' : ''}: ${r.done.join(', ')}`, ms: Date.now() - t0, affected: null, error: r.failed.length ? r.failed.map((f) => `${f.table}: ${f.error}`).join('; ') : null });
  dialog.value = null;
  picked.value = new Set();
  notify(r.failed.length ? 'info' : 'success', `${kind === 'drop' ? 'Dropped' : 'Emptied'} ${r.done.length} ${r.done.length === 1 ? W.value.table : W.value.tables}${r.failed.length ? `; not ${r.failed.map((f) => f.table).join(', ')} (${r.failed[0].error})` : ''}`);
  await loadTables(kind === 'truncate');
  gridKey.value++;
}
async function copyDdls(list: string[]) {
  const parts: string[] = [];
  for (const n of list) {
    const st = await attempt(() => api.dvStructure(c.value.id, db.value, n));
    if (st?.ddl) parts.push(st.ddl.trim().replace(/;?$/, ';'));
  }
  await navigator.clipboard.writeText(parts.join('\n\n'));
  notify('success', `${parts.length} CREATE statements copied`);
}

// ---- foreign-key links: open the referenced table filtered to the row, with a way back
/** Where the grid opens (a followed link), and the tables walked through to get here. */
const followWhere = ref('');
const trail = ref<{ table: string; where: string }[]>([]);
let following = false;
watch(table, () => {
  if (!following) {
    followWhere.value = '';
    trail.value = [];
  }
  following = false;
});
watch(db, () => {
  followWhere.value = '';
  trail.value = [];
});
function follow(f: { table: string; where: string; from: string }) {
  if (!tables.value.some((t) => t.name === f.table)) return notify('info', `${f.table} is not in ${db.value}; open it with a query instead.`);
  trail.value.push({ table: table.value, where: f.from });
  followWhere.value = f.where;
  following = f.table !== table.value;
  table.value = f.table;
  mode.value = 'data';
  gridKey.value++;
}
function goBack() {
  const t = trail.value.pop();
  if (!t) return;
  followWhere.value = t.where;
  following = t.table !== table.value;
  table.value = t.table;
  gridKey.value++;
}
function openQuery() {
  mode.value = 'query';
}

// ---------------------------------------------------------------- dialogs

type Dialog =
  | { kind: 'createDb'; name?: string }
  | { kind: 'dropDb'; name: string }
  | { kind: 'flush'; name: string }
  | { kind: 'createTable'; name?: string }
  | { kind: 'rename'; table: string; to?: string }
  | { kind: 'truncate'; table: string }
  | { kind: 'drop'; table: string; type: 'table' | 'view' }
  | { kind: 'export'; tables: string[]; format?: string }
  | { kind: 'import'; format?: string }
  | { kind: 'backup'; databases?: string[] }
  | { kind: 'bulk'; what: 'drop' | 'truncate'; tables: string[] };
const dialog = ref<Dialog | null>(null);
const busy = ref(false);

async function createDb(name: string, options?: { charset: string; collation: string }) {
  if (!(await confirmProdWrite(c.value, `Create ${W.value.db}`, `CREATE DATABASE ${name}`))) return;
  busy.value = true;
  const ok = await act(`Create ${W.value.db} ${name}${options?.charset ? ` (${options.charset}${options.collation ? ` / ${options.collation}` : ''})` : ''}`, () => api.dvCreateDatabase(c.value.id, name, options));
  busy.value = false;
  if (!ok) return;
  dialog.value = null;
  notify('success', `${name} created`);
  const list = await api.dvDatabases(c.value.id);
  databases.value = list;
  db.value = name;
}
async function dropDb(name: string, confirm: string) {
  busy.value = true;
  const ok = await act(`Drop ${W.value.db} ${name}`, () => api.dvDropDatabase(c.value.id, name, confirm));
  busy.value = false;
  if (!ok) return;
  dialog.value = null;
  notify('success', `${name} dropped`);
  await refreshAll();
}
async function flush(name: string, confirm: string) {
  busy.value = true;
  const ok = await act(`Flush ${name}`, () => api.dvFlush(c.value.id, name, confirm));
  busy.value = false;
  if (!ok) return;
  dialog.value = null;
  notify('success', `${name} flushed`);
  gridKey.value++;
}
async function rename(from: string, to: string) {
  if (!(await confirmProdWrite(c.value, `Rename ${W.value.table}`, `RENAME ${from} TO ${to}`))) return;
  busy.value = true;
  const ok = await act(`Rename ${from} → ${to}`, () => api.dvAlterTable(c.value.id, db.value, from, [{ op: 'renameTable', to }]));
  busy.value = false;
  if (!ok) return;
  dialog.value = null;
  await loadTables(false);
  table.value = to;
}
async function truncate(t: string, confirm: string) {
  busy.value = true;
  const ok = await act(`Truncate ${db.value}.${t}`, () => api.dvTruncateTable(c.value.id, db.value, t, confirm));
  busy.value = false;
  if (!ok) return;
  dialog.value = null;
  notify('success', `${t} emptied`);
  gridKey.value++;
  await loadTables();
}
async function drop(t: string, confirm: string) {
  busy.value = true;
  const ok = await act(`Drop ${db.value}.${t}`, () => api.dvDropTable(c.value.id, db.value, t, confirm));
  busy.value = false;
  if (!ok) return;
  dialog.value = null;
  notify('success', `${t} dropped`);
  await loadTables(false);
}

async function copyDdl(t: string) {
  const st = await attempt(() => api.dvStructure(c.value.id, db.value, t));
  if (st) {
    await navigator.clipboard.writeText(st.ddl);
    notify('success', 'CREATE statement copied');
  }
}

// Menu bar / context menu commands (only the visible workspace answers).
const grid = ref<InstanceType<typeof DvDataGrid> | null>(null);
const query = ref<InstanceType<typeof DvQuery> | null>(null);
const keys = ref<InstanceType<typeof DvKeys> | null>(null);
const picker = ref<InstanceType<typeof DvDbPicker> | null>(null);
function onCmd({ command, table: t, db: wantedDb, text, tables: wantedTables, databases: wantedDbs, format, name, run: andRun, pattern }: Command) {
  if (!props.active) return;
  const target = t ?? table.value;
  switch (command) {
    case 'refresh':
      return void refreshAll();
    case 'dbPick':
      return void picker.value?.show();
    case 'askAi':
      mode.value = 'query';
      return void query.value?.askAi();
    case 'dbCreate':
      return void (dialog.value = { kind: 'createDb', name });
    case 'dbDrop':
      return void (db.value && (dialog.value = { kind: 'dropDb', name: db.value }));
    case 'dbFlush':
      return void (kv.value && db.value && (dialog.value = { kind: 'flush', name: db.value }));
    case 'tableCreate':
      return void (dialog.value = { kind: 'createTable', name });
    case 'tableData':
      if (target) {
        table.value = target;
        mode.value = 'data';
      }
      return;
    case 'tableStructure':
      if (target) {
        table.value = target;
        mode.value = 'structure';
      }
      return;
    case 'tableRename':
      return void (target && (dialog.value = { kind: 'rename', table: target, to: name }));
    case 'tableTruncate':
      return void (target && (dialog.value = { kind: 'truncate', table: target }));
    case 'tableDrop':
      return void (target && (dialog.value = { kind: 'drop', table: target, type: tables.value.find((x) => x.name === target)?.type ?? 'table' }));
    case 'tableExport':
      return void (dialog.value = { kind: 'export', tables: target ? [target] : [] });
    case 'tableCopyName':
      return void (target && navigator.clipboard.writeText(target).then(() => notify('success', 'Name copied')));
    case 'tableCopyDdl':
      return void (target && copyDdl(target));
    case 'export':
      return void (dialog.value = { kind: 'export', tables: wantedTables ?? (table.value ? [table.value] : []), format });
    case 'import':
      return void (dialog.value = { kind: 'import', format });
    case 'backup':
      return void (dialog.value = { kind: 'backup', databases: wantedDbs });
    case 'selectAll':
      return void selectAllTables();
    case 'tablesExport':
      return void (wantedTables?.length && (dialog.value = { kind: 'export', tables: wantedTables }));
    case 'tablesCopyNames':
      return void (wantedTables?.length && navigator.clipboard.writeText(wantedTables.join('\n')).then(() => notify('success', `${wantedTables.length} names copied`)));
    case 'tablesCopyDdl':
      return void (wantedTables?.length && copyDdls(wantedTables));
    case 'tablesCount':
      // A read: through the Query tab's Run, like any query.
      if (!wantedTables?.length || !isSql(c.value.engine)) return;
      mode.value = 'query';
      return void nextTick(() => setTimeout(() => {
        query.value?.newTab(`${wantedTables.map((n) => `SELECT '${n.replace(/'/g, "''")}' AS table_name, COUNT(*) AS row_count FROM ${quoteName(n)}`).join('\nUNION ALL\n')}\nORDER BY row_count DESC;`);
        setTimeout(() => query.value?.run(), 50);
      }));
    case 'tablesOptimize': {
      // Maintenance writes: through Run too, so Read-only refuses and Production asks.
      if (!wantedTables?.length || !isSql(c.value.engine)) return;
      const names = wantedTables.map(quoteName);
      const sql = c.value.engine === 'postgresql' ? `VACUUM (ANALYZE) ${names.join(', ')};` : c.value.engine === 'sqlite' ? names.map((n) => `ANALYZE ${n};`).join('\n') : `OPTIMIZE TABLE ${names.join(', ')};`;
      mode.value = 'query';
      return void nextTick(() => setTimeout(() => {
        query.value?.newTab(sql);
        setTimeout(() => query.value?.run(), 50);
      }));
    }
    case 'tablesTruncate':
    case 'tablesDrop':
      if (!wantedTables?.length) return;
      if (isReadOnly(c.value)) return notify('error', `${c.value.name} is read-only: ${command === 'tablesDrop' ? 'dropping' : 'emptying'} ${W.value.tables} is not allowed`);
      return void (dialog.value = { kind: 'bulk', what: command === 'tablesDrop' ? 'drop' : 'truncate', tables: wantedTables });
    case 'queryText':
      // Ask DBCatz's write-query: a new editor with the query, not run.
      mode.value = 'query';
      return void nextTick(() =>
        setTimeout(() => {
          query.value?.newTab(text ?? '');
          // run-query: through Run, so Read-only refuses and Production / destructive statements ask as usual.
          if (andRun) setTimeout(() => query.value?.run(), 50);
        }),
      );
    case 'keysPattern':
      mode.value = 'keys';
      return void nextTick(() => setTimeout(() => keys.value?.setPattern(pattern ?? '*')));
    case 'rowInsert':
      return void (mode.value === 'data' ? grid.value?.startInsert() : mode.value === 'keys' ? keys.value?.startNew() : undefined);
    case 'rowDelete':
    case 'keyDelete':
      return void (mode.value === 'data' ? grid.value?.deleteSelected() : mode.value === 'keys' ? keys.value?.deleteSelected() : undefined);
    case 'keyNew':
      return void keys.value?.startNew();
    case 'filter':
      return void (mode.value === 'data' ? grid.value?.focusFilter() : mode.value === 'keys' ? keys.value?.focusFilter() : undefined);
    case 'queryNew':
      mode.value = 'query';
      return void query.value?.newTab();
    case 'queryRun':
      return void (mode.value === 'query' && query.value?.run());
    case 'queryFormat':
      return void (mode.value === 'query' && query.value?.format());
    case 'logs':
      return void (mode.value = 'logs');
    case 'disconnect':
      return void disconnect();
    case 'openDb':
      if (wantedDb && databases.value.includes(wantedDb)) db.value = wantedDb;
      return;
  }
}
const off = onCommand(onCmd);
// An import into this connection ended in the background: show what it added.
const seenJobs = new Set(jobs.value.filter((j) => j.finished).map((j) => j.id));
watch(jobs, (list) => {
  for (const j of list) {
    if (!j.finished || seenJobs.has(j.id)) continue;
    seenJobs.add(j.id);
    if (j.connId === c.value.id && j.kind === 'import' && (!j.error || j.cancelled)) void refreshNow();
  }
});

// ---- back / forward: this tab reports where it is and can be moved back there
watch([db, table, mode, connecting], () => {
  if (!connecting.value && !error.value) report(props.tabId, { connId: c.value.id, db: db.value, table: table.value, mode: mode.value });
});
const offPlace = onPlace(props.tabId, async (p) => {
  const m = (p.mode as Mode | undefined) ?? null;
  if (p.db && p.db !== db.value) {
    if (!databases.value.includes(p.db)) throw new Error(`${c.value.name} has no ${W.value.db} called ${p.db}`);
    pendingTable = p.table || null;
    pendingMode = m;
    const done = new Promise<void>((r) => (loaded = r));
    db.value = p.db;
    await done;
    if (p.table && table.value !== p.table) throw new Error(`No ${W.value.table} called ${p.table} in ${p.db}`);
  } else {
    // undefined keeps the table (Ask DBCatz), '' clears it (a history entry without one).
    if (p.table) {
      if (!tables.value.some((t) => t.name === p.table)) throw new Error(`No ${W.value.table} called ${p.table} in ${db.value}`);
      table.value = p.table;
    } else if (p.table === '') table.value = '';
    if (m) {
      await nextTick();
      mode.value = m;
    }
  }
  if (p.where !== undefined) {
    // After the table watcher, which clears a followed filter.
    await nextTick();
    followWhere.value = p.where;
    trail.value = [];
    mode.value = 'data';
    gridKey.value++;
  }
});
tabState.set(props.tabId, () => ({ db: db.value, table: table.value }));
onBeforeUnmount(() => {
  off();
  offPlace();
  forgetTab(props.tabId);
  tabStatus.delete(props.tabId);
  tabState.delete(props.tabId);
});

function contextMenu(t: DvTable) {
  // Right-click inside a selection of several: the bulk menu for them; elsewhere the table's own menu.
  if (picked.value.size > 1 && picked.value.has(t.name)) return void api.dvTableMenu(t.name, kindOf(t), { tables: pickedList(), readOnly: isReadOnly(c.value), sql: isSql(c.value.engine) });
  picked.value = new Set();
  table.value = t.name;
  void api.dvTableMenu(t.name, kindOf(t));
}
const tableIcon = (t: DvTable) => (t.type === 'view' ? 'M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Zm8 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z' : 'M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11ZM4.5 7v2.5h4.75V7H4.5Zm6.25 0v2.5h4.75V7h-4.75ZM4.5 11v2.5h4.75V11H4.5Zm6.25 0v2.5h4.75V11h-4.75Z');
/** Open in DevCatz on a service's error screen; without the DevCatz app, its download page instead. */
async function openService(serviceId: string) {
  if (await api.openInDevCatz(serviceId)) return;
  notify('info', `DevCatz is not installed on ${platformWords.thisComputer}: opening its download page`);
  await openDevCatzDownload();
}
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <!-- Sidebar -->
    <aside class="flex w-[264px] shrink-0 flex-col border-r border-base-300/60 bg-base-200/40">
      <div class="space-y-2 px-3 pt-3">
        <div class="flex items-center gap-2 px-1">
          <img :src="DB_LOGO[c.engine]" alt="" class="size-6 rounded-md bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5"><span class="truncate text-sm font-semibold">{{ c.name }}</span><span v-if="isProd(c)" class="dv-mode-chip is-prod">PROD</span><span v-else-if="isReadOnly(c)" class="dv-mode-chip is-ro">READ-ONLY</span></div>
            <div class="flex items-center gap-1.5 truncate font-mono text-[11px] opacity-55">
              <span class="status status-xs shrink-0" :class="c.connected && !disconnected ? 'status-success' : 'status-neutral'" />{{ info?.version ?? ENGINE_NAME[c.engine] }}
            </div>
          </div>
          <button v-if="c.connected && !disconnected" class="btn btn-ghost btn-xs btn-square" title="Disconnect (closes the connection and any SSH tunnel)" @click="disconnect">
            <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M10 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm-4.2 3.3a1 1 0 0 1 0 1.4 5 5 0 1 0 8.4 0 1 1 0 1 1 1.4-1.4 7 7 0 1 1-11.2 0 1 1 0 0 1 1.4 0Z" /></svg>
          </button>
        </div>
        <div v-if="!error && !connecting && !disconnected" class="flex gap-1">
          <DvDbPicker ref="picker" v-model="db" :conn="c" :databases="databases" />
          <button class="btn btn-sm btn-square" :class="{ 'opacity-60': refreshing }" :title="`Reload the ${W.dbs} and ${W.tables} (${keyLabel('mod+R')})`" :disabled="refreshing" @click="refreshAll"><span v-if="refreshing" class="loading loading-spinner loading-xs" /><template v-else>↻</template></button>
          <button v-if="!kv && c.engine !== 'elasticsearch'" class="btn btn-sm btn-square" :title="isReadOnly(c) ? 'Read-only connection' : `Create ${W.db}`" :disabled="isReadOnly(c)" @click="dialog = { kind: 'createDb' }">+</button>
        </div>
        <label v-if="!kv && !error && !connecting && !disconnected" class="input input-sm flex w-full items-center gap-2">
          <svg viewBox="0 0 20 20" class="size-3.5 opacity-50" fill="currentColor"><path d="M8.5 3a5.5 5.5 0 1 0 3.4 9.8l3.6 3.6a1 1 0 0 0 1.4-1.4l-3.6-3.6A5.5 5.5 0 0 0 8.5 3ZM5 8.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0Z" /></svg>
          <input v-model="filter" class="grow text-xs" :placeholder="`Filter ${W.tables}`" spellcheck="false" />
        </label>
      </div>

      <div ref="sidebarList" class="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2" @keydown.esc="picked = new Set()">
        <div v-if="picked.size > 1" class="mx-1 mb-1.5 flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-[11px]">
          <span class="font-medium">{{ picked.size }} selected</span>
          <span class="opacity-55">· right-click for actions</span>
          <span class="flex-1" />
          <button class="btn btn-ghost btn-xs h-5 min-h-0 px-1" title="Clear the selection (Esc)" @click="picked = new Set()">✕</button>
        </div>
        <template v-if="!kv && !error && !connecting && !disconnected">
          <div class="label-caps flex items-center px-2 pt-1 pb-1.5">
            {{ W.tables }}
            <span class="ml-1 opacity-60" :title="systemCount ? `${tables.length - systemCount} of your own, ${systemCount} built in` : ''">{{ tables.length - systemCount }}</span>
            <span class="flex-1" />
            <button v-if="!isReadOnly(c)" class="btn btn-ghost btn-xs h-5 min-h-0 px-1 normal-case" :title="`Create ${W.table}`" @click="dialog = { kind: 'createTable' }">+ New</button>
          </div>
          <p v-if="loadingTables && !tables.length" class="px-2 py-3 text-xs opacity-50"><span class="loading loading-spinner loading-xs" /> Loading…</p>
          <p v-else-if="!tables.length" class="px-2 py-3 text-xs opacity-50">No {{ W.tables }} in {{ db || `this ${W.db}` }} yet. Create one with + New, import a file, or run a query.</p>
          <p v-else-if="!filtered.length" class="px-2 py-3 text-xs opacity-50">Nothing matches “{{ filter }}”.</p>
          <button v-for="t in ownTables" :key="t.name" class="dv-table" :class="{ 'is-active': table === t.name && picked.size < 2, 'is-picked': picked.has(t.name) && picked.size > 1 }" :title="t.rows !== null ? `${fmtNum(t.rows)} ${W.rows}${t.size ? ` · ${fmtBytes(t.size)}` : ''}` : t.name" @click="clickTable($event, t)" @contextmenu.prevent="contextMenu(t)">
            <svg viewBox="0 0 20 20" class="size-4 shrink-0 opacity-50" fill="currentColor"><path :d="tableIcon(t)" /></svg>
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ t.name }}</span>
            <span v-if="t.rows !== null" class="shrink-0 font-mono text-[10px] tabular-nums opacity-40">{{ t.rows >= 1000 ? `${(t.rows / 1000).toFixed(t.rows >= 10000 ? 0 : 1)}k` : t.rows }}</span>
          </button>
          <template v-if="systemTables.length">
            <button type="button" class="dv-sys-head" :class="{ 'mt-2': ownTables.length }" :title="showSystem ? 'Hide the tables the server keeps for itself' : 'Show the tables the server keeps for itself'" @click="systemOpen = !showSystem">
              <svg viewBox="0 0 20 20" class="size-3 shrink-0 transition-transform" :class="{ 'rotate-90': showSystem }" fill="currentColor"><path fill-rule="evenodd" d="M7.2 14.8a.75.75 0 0 1 0-1.06L10.94 10 7.2 6.26a.75.75 0 1 1 1.06-1.06l4.27 4.27a.75.75 0 0 1 0 1.06L8.26 14.8a.75.75 0 0 1-1.06 0Z" clip-rule="evenodd" /></svg>
              <span>System {{ W.tables }}</span>
              <span class="opacity-60">{{ filter ? systemTables.length : systemCount }}</span>
              <span class="flex-1" />
              <span class="text-[10px] font-normal normal-case tracking-normal opacity-50">built in</span>
            </button>
            <template v-if="showSystem">
            <button v-for="t in systemTables" :key="t.name" class="dv-table is-system" :class="{ 'is-active': table === t.name && picked.size < 2, 'is-picked': picked.has(t.name) && picked.size > 1 }" :title="t.rows !== null ? `${fmtNum(t.rows)} ${W.rows}${t.size ? ` · ${fmtBytes(t.size)}` : ''}` : t.name" @click="clickTable($event, t)" @contextmenu.prevent="contextMenu(t)">
              <svg viewBox="0 0 20 20" class="size-4 shrink-0 opacity-50" fill="currentColor"><path :d="tableIcon(t)" /></svg>
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ t.name }}</span>
              <span v-if="t.rows !== null" class="shrink-0 font-mono text-[10px] tabular-nums opacity-40">{{ t.rows >= 1000 ? `${(t.rows / 1000).toFixed(t.rows >= 10000 ? 0 : 1)}k` : t.rows }}</span>
            </button>
            </template>
          </template>
        </template>
        <template v-else-if="kv && !error && !connecting && !disconnected">
          <p class="px-2 py-3 text-xs opacity-55">Keys of {{ db }} are listed on the right. Redis has no tables: use the pattern box to narrow the list (e.g. <code>user:*</code>).</p>
        </template>
      </div>

      <div v-if="!error && !connecting && !disconnected" class="flex gap-1 border-t border-base-300/60 p-2">
        <button class="btn btn-ghost btn-xs flex-1 gap-1" :class="{ 'btn-active': mode === 'query' }" :title="kv ? `Run commands (${keyLabel('mod+T')})` : `Write a query (${keyLabel('mod+T')})`" @click="openQuery">
          <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M7.3 5.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4-1.4L10.6 10 7.3 6.7a1 1 0 0 1 0-1.4Z" /></svg>{{ kv ? 'Command' : 'Query' }}
        </button>
        <button class="btn btn-ghost btn-xs flex-1 gap-1" :class="{ 'btn-active': mode === 'logs' }" :title="`Server log and DBCatz activity (${keyLabel('mod+L')})`" @click="mode = 'logs'">Logs</button>
        <button class="btn btn-ghost btn-xs flex-1 gap-1" :title="`Export… (${keyLabel('mod+E')})`" @click="dialog = { kind: 'export', tables: table ? [table] : [] }">Export</button>
        <button class="btn btn-ghost btn-xs flex-1 gap-1" :title="`Import… (${keyLabel('mod+I')})`" @click="dialog = { kind: 'import' }">Import</button>
        <button class="btn btn-ghost btn-xs btn-square" :title="`Refresh (${keyLabel('mod+R')})`" @click="refreshAll">↻</button>
      </div>
    </aside>

    <!-- Main area -->
    <div class="flex min-w-0 flex-1 flex-col">
      <div v-if="disconnected && !connecting" class="grid flex-1 place-items-center p-8">
        <div class="max-w-sm text-center">
          <!-- The engine stays centred; the cat sits small at its left, middles level -->
          <div class="relative mx-auto w-fit">
            <CatMood mood="warning" class="absolute top-1/2 right-full mr-2 size-9 -translate-y-1/2" />
            <img :src="DB_LOGO[c.engine]" alt="" class="size-12 rounded-xl bg-white p-1.5 opacity-60 ring-1 ring-base-content/10 grayscale" draggable="false" />
          </div>
          <h2 class="mt-3 text-base font-semibold">Disconnected from {{ c.name }}</h2>
          <p class="mt-1 font-mono text-xs opacity-55">{{ DV_HINT(c) }}</p>
          <div class="mt-4 flex justify-center gap-2">
            <button class="btn btn-ghost btn-sm" @click="closeTab(tabId)">Close tab</button>
            <button class="btn btn-primary btn-sm" @click="connect">Reconnect</button>
          </div>
        </div>
      </div>
      <div v-else-if="connecting || error" class="grid flex-1 place-items-center overflow-y-auto p-8">
        <div class="w-full max-w-lg">
          <div class="mb-4 flex items-center gap-3">
            <img :src="DB_LOGO[c.engine]" alt="" class="size-11 shrink-0 rounded-xl bg-white p-1.5 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-base font-semibold">{{ error === 'Cancelled' ? `Connecting to ${c.name} was cancelled` : error ? `Could not connect to ${c.name}` : `Connecting to ${c.name}` }}</h2>
              <p class="truncate font-mono text-xs opacity-55">{{ DV_HINT(c) }}</p>
            </div>
            <!-- The cat on the right, the engine and title on the left -->
            <CatMood v-if="error" mood="error" class="size-11 shrink-0" />
          </div>
          <DvProgress :progress="progress.get(token) ?? null" :error="error" @cancel="cancelConnect" />
          <p v-if="error && progress.get(token) && !progress.get(token)?.error" class="mt-3 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] text-error">{{ error }}</p>
          <div v-if="error" class="mt-4 flex flex-wrap justify-end gap-2">
            <button class="btn btn-ghost btn-sm" @click="closeTab(tabId)">Close tab</button>
            <button v-if="!c.serviceId" class="btn btn-sm" @click="editing = c; active = 'home'">Edit connection</button>
            <button v-else class="btn btn-sm gap-2" title="Show this service on DevCatz's Database page, where it can be started" @click="openService(c.serviceId!)">
              <img :src="devcatzLogo" alt="" class="size-5 drop-shadow-sm" draggable="false" />Open in DevCatz
            </button>
            <button class="btn btn-primary btn-sm" @click="connect">Try again</button>
          </div>
          <p v-if="error && c.serviceId" class="mt-3 text-xs opacity-60">Start the service in DevCatz (Database page), then try again.</p>
        </div>
      </div>
      <template v-else>
        <!-- Breadcrumb + mode tabs -->
        <div class="flex h-11 shrink-0 items-center gap-3 border-b border-base-300/60 pr-4 pl-2">
          <DvNavButtons />
          <div class="flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <span class="opacity-60">{{ db || '—' }}</span>
            <template v-if="!kv && table"><span class="opacity-30">›</span><span class="truncate font-semibold">{{ table }}</span></template>
            <span v-if="current && current.rows !== null" class="ml-1 badge badge-ghost badge-xs font-sans">{{ fmtNum(current.rows) }} {{ W.rows }}</span>
          </div>
          <span class="flex-1" />
          <div role="tablist" class="seg seg-xs">
            <template v-if="kv">
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': mode === 'keys' }" @click="mode = 'keys'">Keys</a>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': mode === 'query' }" @click="mode = 'query'">Command</a>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': mode === 'logs' }" @click="mode = 'logs'">Logs</a>
            </template>
            <template v-else>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': mode === 'data', 'opacity-40': !table }" @click="table && (mode = 'data')">Data</a>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': mode === 'structure', 'opacity-40': !table }" @click="table && (mode = 'structure')">Structure</a>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': mode === 'query' }" @click="mode = 'query'">Query</a>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': mode === 'logs' }" @click="mode = 'logs'">Logs</a>
            </template>
          </div>
        </div>

        <div class="relative min-h-0 flex-1">
          <DvKeys v-if="kv && mode === 'keys'" ref="keys" :key="`${db}:${gridKey}`" :conn="c" :db="db" />
          <DvQuery v-show="mode === 'query'" ref="query" :key="db" :conn="c" :db="db" :tables="tables" @changed="loadTables(); api.aiForget(c.id, db)" />
          <DvLogs v-if="mode === 'logs'" :conn="c" :db="db" />
          <template v-if="!kv && mode !== 'query' && mode !== 'logs'">
            <div v-if="!table" class="grid h-full place-items-center p-8">
              <div class="max-w-sm text-center">
                <svg viewBox="0 0 20 20" class="mx-auto size-10 opacity-20" fill="currentColor"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11ZM4.5 7v2.5h4.75V7H4.5Zm6.25 0v2.5h4.75V7h-4.75ZM4.5 11v2.5h4.75V11H4.5Zm6.25 0v2.5h4.75V11h-4.75Z" /></svg>
                <h2 class="mt-3 text-base font-semibold">{{ tables.length ? `Pick a ${W.table}` : `No ${W.tables} yet` }}</h2>
                <p class="mt-1 text-sm opacity-60">{{ tables.length ? `Choose one in the sidebar to browse and edit its ${W.rows}, or open the Query tab.` : `Create one with + New in the sidebar, import a file, or write a ${W.query}.` }}</p>
                <div class="mt-4 flex justify-center gap-2">
                  <button class="btn btn-sm" @click="dialog = { kind: 'createTable' }">Create {{ W.table }}</button>
                  <button class="btn btn-sm" @click="dialog = { kind: 'import' }">Import…</button>
                  <button class="btn btn-primary btn-sm" @click="openQuery">{{ kv ? 'Command' : 'Query' }}</button>
                </div>
              </div>
            </div>
            <DvDataGrid v-else-if="mode === 'data'" ref="grid" :key="`${db}:${table}:${gridKey}`" :conn="c" :db="db" :table="table" :initial-where="followWhere" :back="trail.length ? trail[trail.length - 1].table : null" @follow="follow" @back="goBack" />
            <DvStructure v-else-if="mode === 'structure'" :key="`${db}:${table}:${gridKey}`" :conn="c" :db="db" :table="table" @changed="loadTables()" />
          </template>
        </div>
      </template>
    </div>

    <!-- Dialogs -->
    <DvCreateDatabase v-if="dialog?.kind === 'createDb'" :conn="c" :busy="busy" :initial-name="dialog.name" @ok="createDb" @cancel="dialog = null" />
    <DvDanger v-if="dialog?.kind === 'dropDb'" :title="`Drop ${dialog.name}?`" :text="`Every ${W.table} and all data in ${dialog.name} will be deleted. This cannot be undone.`" :name="dialog.name" confirm="Drop database" :busy="busy" @ok="(t) => dropDb((dialog as any).name, t)" @cancel="dialog = null" />
    <DvDanger v-if="dialog?.kind === 'flush'" :title="`Flush ${dialog.name}?`" :text="`Every key in ${dialog.name} will be deleted. This cannot be undone.`" :name="dialog.name" confirm="Flush keys" :busy="busy" @ok="(t) => flush((dialog as any).name, t)" @cancel="dialog = null" />
    <DvCreateTable v-if="dialog?.kind === 'createTable'" :conn="c" :db="db" :initial-name="dialog.name" @done="(name) => { dialog = null; loadTables(false).then(() => { table = name; mode = 'structure'; }); }" @cancel="dialog = null" />
    <DvPrompt v-if="dialog?.kind === 'rename'" :title="`Rename ${dialog.table}`" label="New name" :initial="dialog.to || dialog.table" :busy="busy" confirm="Rename" @ok="(to) => rename((dialog as any).table, to)" @cancel="dialog = null" />
    <DvDanger v-if="dialog?.kind === 'truncate'" :title="`Empty ${dialog.table}?`" :text="`All ${W.rows} of ${dialog.table} will be deleted; the ${W.table} itself stays.`" :name="dialog.table" confirm="Delete all rows" :busy="busy" @ok="(t) => truncate((dialog as any).table, t)" @cancel="dialog = null" />
    <DvDanger v-if="dialog?.kind === 'drop'" :title="`Drop ${dialog.table}?`" :text="`The ${dialog.type === 'view' ? 'view' : W.table} and ${dialog.type === 'view' ? 'its definition' : `all its ${W.rows}`} will be deleted. This cannot be undone.`" :name="dialog.table" :confirm="`Drop ${dialog.type === 'view' ? 'view' : W.table}`" :busy="busy" @ok="(t) => drop((dialog as any).table, t)" @cancel="dialog = null" />
    <DvBulkDanger v-if="dialog?.kind === 'bulk'" :kind="dialog.what" :conn="c" :db="db" :tables="dialog.tables" :busy="busy" @ok="(confirm, force) => bulk((dialog as any).what, (dialog as any).tables, confirm, force)" @cancel="dialog = null" />
    <DvTransfer v-if="dialog?.kind === 'export' || dialog?.kind === 'import' || dialog?.kind === 'backup'" :mode="dialog.kind" :conn="c" :db="db" :databases="databases" :tables="tables" :preselected="dialog.kind === 'export' ? dialog.tables : []" :initial-format="dialog.kind === 'export' || dialog.kind === 'import' ? dialog.format : undefined" :preselected-dbs="dialog.kind === 'backup' ? dialog.databases : undefined" @done="dialog = null" @cancel="dialog = null" />
  </div>
</template>
