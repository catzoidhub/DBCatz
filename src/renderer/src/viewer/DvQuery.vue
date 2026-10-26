<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { DvAiAnswer, DvAiPreview, DvAiRequest, DvAiTurn, DvConnection, DvResult, DvRows, DvSavedQuery, DvTable } from '@shared/types';
import { aiOn as aiOnFeature, attempt, api, notify, saveSettings, settings, showSettings } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DvCodeEditor from './DvCodeEditor.vue';
import DvDataGrid from './DvDataGrid.vue';
import DvPrompt from './DvPrompt.vue';
import DvReplyViewer from './DvReplyViewer.vue';
import { structured } from './pretty';
import type { Language } from './highlight';
import { redisComplete, sqlComplete } from './complete';
import { askWrite, fmtMs, fmtNum, formatSql, history, historyKey, isKv, isProd, isReadOnly, isSql, logActivity, remember, words } from './viewer';
import { statementKind } from '@shared/dbsafety';
import { splitStatements as splitSqlStatements } from '@shared/sqlsplit';
import CatMood from './CatMood.vue';

/**
 * The query editor: several editor tabs with syntax colours, ⌘⏎ runs the
 * whole text (or the selection), one result per statement; writes that drop
 * or delete ask first. A SELECT from one table whose primary key is in the
 * result is shown in the editable grid. Queries can be saved per connection.
 * Redis takes redis-cli lines, MongoDB mongosh-like calls, Elasticsearch
 * Kibana-console requests.
 */
const props = defineProps<{ conn: DvConnection; db: string; tables: DvTable[] }>();
const emit = defineEmits<{ changed: [] }>();
const e = props.conn.engine;
const W = words(e);
const language: Language = isSql(e) ? 'sql' : isKv(e) ? 'redis' : e === 'mongodb' ? 'mongo' : 'es';
const placeholder = isKv(e) ? 'SCAN 0 MATCH user:* COUNT 100\nGET user:1' : e === 'mongodb' ? 'db.users.find({ status: "active" }).sort({ createdAt: -1 }).limit(20)' : e === 'elasticsearch' ? 'GET /products/_search\n{ "query": { "match_all": {} }, "size": 20 }' : `SELECT * FROM ${props.tables[0]?.name ?? 'table'} LIMIT 100;`;
const names = computed(() => props.tables.map((t) => t.name));

// ---- suggestions (SQL): keywords, the database's tables, and the columns of the tables a statement uses
const columnCache = reactive(new Map<string, { name: string; type: string }[]>());
const loadingColumns = new Set<string>();
/** Bumped when columns arrive, so an open suggestion list is worked out again. */
const completeVersion = ref(0);
function needColumns(table: string) {
  if (loadingColumns.has(table) || columnCache.has(table)) return;
  loadingColumns.add(table);
  void api
    .dvStructure(props.conn.id, props.db, table)
    .then((st) => columnCache.set(table, st.columns.map((c) => ({ name: c.name, type: c.type }))))
    .catch(() => columnCache.set(table, []))
    .finally(() => {
      loadingColumns.delete(table);
      completeVersion.value++;
    });
}
// Redis / Valkey: key names come from a SCAN of what was typed so far (cached per prefix; a complete
// shorter prefix is narrowed here without asking the server again).
const KEY_LIMIT = 50;
const keyCache = reactive(new Map<string, { list: { key: string; type: string }[]; complete: boolean }>());
const loadingKeys = new Set<string>();
let keyTimer: ReturnType<typeof setTimeout> | null = null;
function keysFor(prefix: string): { key: string; type: string }[] | undefined {
  const exact = keyCache.get(prefix);
  if (exact) return exact.list;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const shorter = keyCache.get(prefix.slice(0, i));
    if (shorter?.complete) return shorter.list.filter((k) => k.key.startsWith(prefix));
  }
  if (keyTimer) clearTimeout(keyTimer);
  keyTimer = setTimeout(() => {
    if (loadingKeys.has(prefix)) return;
    loadingKeys.add(prefix);
    const glob = `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`;
    void api
      .dvKeys(props.conn.id, props.db, glob, KEY_LIMIT)
      .then((r) => keyCache.set(prefix, { list: r.keys.map((k) => ({ key: k.key, type: k.type })), complete: r.total <= r.keys.length }))
      .catch(() => keyCache.set(prefix, { list: [], complete: false }))
      .finally(() => {
        loadingKeys.delete(prefix);
        completeVersion.value++;
      });
  }, 150);
  return undefined;
}
const complete = isSql(e)
  ? (text: string, cursor: number, explicit: boolean) =>
      sqlComplete(text, cursor, { engine: e, tables: names.value, columns: (t) => columnCache.get(t), need: (t) => setTimeout(() => needColumns(t)) }, explicit)
  : isKv(e)
    ? (text: string, cursor: number, explicit: boolean) => redisComplete(text, cursor, { keys: keysFor }, explicit)
    : null;
// Tables can change (created, dropped): their columns are read again when next needed.
watch(
  () => props.tables,
  () => columnCache.clear(),
);

// ---- the results panel: its height is dragged on the bar above it; it can be folded away
const PANEL_KEY = 'dbcatz.query.panel';
const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem(PANEL_KEY) ?? 'null') as { height: number; folded: boolean } | null;
  } catch {
    return null;
  }
})();
const resultsHeight = ref(stored?.height ?? 0);
const folded = ref(stored?.folded ?? false);
/** The side panel (tables, saved, history) folded to a thin strip on the right. */
const sideFolded = ref((stored as { side?: boolean } | null)?.side ?? false);
function setSide(open: boolean, tab?: 'tables' | 'history' | 'saved') {
  sideFolded.value = !open;
  if (tab) side.value = tab;
  savePanel();
}
const column = ref<HTMLElement | null>(null);
const dragging = ref(false);
function savePanel() {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ height: resultsHeight.value, folded: folded.value, side: sideFolded.value }));
  } catch {
    /* only a convenience */
  }
}
/** The usable range: the editor keeps at least 6.5rem, the results at least 7rem when shown. */
function clampHeight(h: number): number {
  const total = column.value?.clientHeight ?? 600;
  return Math.round(Math.max(112, Math.min(h, total - 104 - 28)));
}
// The tab may mount hidden (height 0): size the panel once it is shown, and keep it inside when the window changes.
let sized = false;
const observer = new ResizeObserver(() => {
  const total = column.value?.clientHeight ?? 0;
  if (total < 200) return;
  if (!sized && !stored?.height) resultsHeight.value = clampHeight(total * 0.5);
  else resultsHeight.value = clampHeight(resultsHeight.value);
  sized = true;
});
onMounted(() => column.value && observer.observe(column.value));
onBeforeUnmount(() => observer.disconnect());
function startResize(ev: MouseEvent) {
  if ((ev.target as HTMLElement).closest('button')) return;
  ev.preventDefault();
  const startY = ev.clientY;
  const startH = folded.value ? 0 : resultsHeight.value;
  dragging.value = true;
  document.body.classList.add('dv-resizing-row');
  const move = (m: MouseEvent) => {
    const h = startH + (startY - m.clientY);
    if (h < 60) {
      folded.value = true;
    } else {
      folded.value = false;
      resultsHeight.value = clampHeight(h);
    }
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('dv-resizing-row');
    dragging.value = false;
    savePanel();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
function toggleFold() {
  folded.value = !folded.value;
  if (!folded.value) resultsHeight.value = clampHeight(resultsHeight.value || 320);
  savePanel();
}
function maximize() {
  folded.value = false;
  resultsHeight.value = clampHeight(Number.MAX_SAFE_INTEGER);
  savePanel();
}

interface Editor {
  id: number;
  text: string;
  results: DvResult[];
  running: boolean;
  shown: number;
  /** The saved query this editor came from (renamed / rewritten on Save). */
  savedId: string | null;
  savedName: string | null;
  /** Per result: the table it selects from when the grid can edit it. */
  editable: (string | null)[];
  ai: AiThread;
}
/** An Ask AI thread of one editor tab: follow-ups build on it. */
interface AiThread {
  open: boolean;
  prompt: string;
  turns: DvAiTurn[];
  busy: boolean;
  answer: DvAiAnswer | null;
  error: string | null;
  /** The query last put in the editor, to tell the user's own text from it. */
  inserted: string;
  /** The running request: its token (Stop), when it started, and the step it is at. */
  token: string;
  started: number;
  step: { step: number; steps: number; text: string; draft?: { query: string; explanation: string } } | null;
}
const newThread = (): AiThread => ({ open: false, prompt: '', turns: [], busy: false, answer: null, error: null, inserted: '', token: '', started: 0, step: null });
let seq = 1;
const editors = ref<Editor[]>([{ id: seq, text: '', results: [], running: false, shown: 0, savedId: null, savedName: null, editable: [], ai: newThread() }]);
const current = ref(seq);
const ed = computed(() => editors.value.find((x) => x.id === current.value)!);
const code = ref<InstanceType<typeof DvCodeEditor> | null>(null);
const side = ref<'tables' | 'history' | 'saved'>('tables');
const hist = computed(() => history.get(historyKey(props.conn.id, props.db)) ?? []);
const saved = ref<DvSavedQuery[]>([]);
const naming = ref(false);
const deleting = ref<DvSavedQuery | null>(null);
defineExpose({ run, newTab, format, askAi });

onMounted(async () => {
  saved.value = (await api.dvSavedQueries(props.conn.id, props.db).catch(() => [])) ?? [];
});

function newTab(text = '', from: DvSavedQuery | null = null, ai: AiThread = newThread()) {
  editors.value.push({ id: ++seq, text, results: [], running: false, shown: 0, savedId: from?.id ?? null, savedName: from?.name ?? null, editable: [], ai });
  current.value = seq;
  setTimeout(() => code.value?.focus());
}
function closeEditor(id: number) {
  if (editors.value.length === 1) {
    Object.assign(editors.value[0], { text: '', results: [], savedId: null, savedName: null, editable: [], ai: newThread() });
    return;
  }
  const i = editors.value.findIndex((x) => x.id === id);
  editors.value.splice(i, 1);
  if (current.value === id) current.value = editors.value[Math.max(0, i - 1)].id;
}
function format() {
  if (isSql(e)) ed.value.text = formatSql(ed.value.text);
}
/** The statements of a script, as the server will run them. */
function statementsOf(text: string): string[] {
  if (isSql(e)) return splitSqlStatements(text);
  if (e === 'mongodb') return text.split(/\n(?=db\.|\{)/).map((s) => s.trim()).filter(Boolean);
  if (e === 'elasticsearch') return text.split(/\n(?=(?:GET|POST|PUT|DELETE|HEAD)\s)/i).map((s) => s.trim()).filter(Boolean);
  return text.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

/**
 * Before running: Read-only connections refuse writes; destructive statements
 * (DROP, TRUNCATE, UPDATE / DELETE without WHERE, FLUSHALL …) always ask —
 * on Production with the connection name typed; other writes ask on Production.
 */
async function run() {
  const text = (code.value?.selection() || ed.value.text).trim();
  if (!text || ed.value.running) return;
  if (folded.value) toggleFold(); // results are what running is for
  const stmts = statementsOf(text);
  const kinds = stmts.map((s) => ({ s, k: statementKind(e, s) }));
  const writes = kinds.filter((x) => !x.k.read);
  if (isReadOnly(props.conn) && writes.length) return notify('error', `Read-only connection: ${writes.length === 1 ? 'this statement changes' : `${writes.length} statements change`} data or structure.`);
  const risky = kinds.filter((x) => x.k.destructive);
  if (risky.length) {
    const ok = await askWrite({
      title: isProd(props.conn) ? `Destructive on ${props.conn.name}?` : 'Run this?',
      detail: [...new Set(risky.map((x) => x.k.reason))].join('. ') + '. There is no undo.',
      statements: risky.map((x) => x.s.slice(0, 400)),
      word: isProd(props.conn) ? props.conn.name : null,
      tone: 'error',
      action: 'Run',
    });
    if (!ok) return;
  } else if (isProd(props.conn) && writes.length) {
    const ok = await askWrite({ title: `Write to ${props.conn.name}?`, detail: `${props.conn.name} is a Production connection: ${writes.length === 1 ? 'this statement changes' : `${writes.length} statements change`} the live database.`, statements: writes.map((x) => x.s.slice(0, 400)), word: null, action: 'Run' });
    if (!ok) return;
  }
  void execute(text);
}

/** `SELECT … FROM one_table [WHERE/ORDER/LIMIT]` without joins → that table, else null. */
function singleTable(statement: string): string | null {
  const m = /^\s*SELECT\s+[\s\S]+?\s+FROM\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s*(?:WHERE|ORDER|LIMIT|OFFSET|GROUP|HAVING|;|$)/i.exec(statement);
  if (!m || /\bJOIN\b|\bUNION\b|\bGROUP\s+BY\b|\bDISTINCT\b|\(\s*SELECT\b/i.test(statement)) return null;
  const t = props.tables.find((x) => x.name.toLowerCase() === m[1].toLowerCase());
  return t && t.type === 'table' ? t.name : null;
}

async function execute(text: string) {
  const editor = ed.value;
  editor.running = true;
  const r = await attempt(() => api.dvQuery(props.conn.id, props.db, text));
  editor.running = false;
  if (!r) return;
  editor.results = r;
  editor.shown = Math.max(0, r.length - 1);
  editor.editable = r.map(() => null);
  remember(props.conn.id, props.db, text);
  for (const x of r) logActivity(props.conn.id, { text: `[${props.db}] ${x.statement}`, ms: x.ms, affected: x.affected ?? (x.columns.length ? x.rows.length : null), error: x.error });
  const failed = r.find((x) => x.error);
  if (failed) notify('error', failed.error!);
  else if (r.some((x) => x.affected !== null)) {
    notify('success', `${r.reduce((n, x) => n + (x.affected ?? 0), 0)} ${W.rows} affected`);
    emit('changed');
  }
  if (/\b(CREATE|DROP|ALTER|RENAME)\b/i.test(text) || /\.(drop|createIndex|rename)\(/.test(text) || /^(PUT|DELETE)\s/im.test(text)) emit('changed');
  // Editable results: one table, its primary key among the columns.
  if (isSql(e)) {
    for (let i = 0; i < r.length; i++) {
      const t = r[i].columns.length ? singleTable(r[i].statement) : null;
      if (!t) continue;
      const st = await api.dvStructure(props.conn.id, props.db, t).catch(() => null);
      if (st?.primaryKey.length && st.primaryKey.every((k) => r[i].columns.includes(k))) editor.editable[i] = t;
    }
    if (editor.editable[editor.shown]) presets.value[`${editor.id}:${editor.shown}`] = await presetFor(editor.shown, editor);
  }
}
/** A result as grid rows, with the table's primary key so cells can be edited. */
async function presetFor(i: number, editor: Editor = ed.value): Promise<DvRows> {
  const r = editor.results[i];
  const st = await api.dvStructure(props.conn.id, props.db, editor.editable[i]!);
  return { columns: r.columns, rows: r.rows, total: r.rows.length, primaryKey: st.primaryKey, ms: r.ms };
}
const presets = ref<Record<string, DvRows>>({});
async function ensurePreset(i: number) {
  const key = `${ed.value.id}:${i}`;
  if (!presets.value[key]) presets.value[key] = await presetFor(i);
  return presets.value[key];
}
function rerun() {
  presets.value = {};
  void execute(ed.value.text);
}
function showResult(i: number) {
  ed.value.shown = i;
  if (ed.value.editable[i]) void ensurePreset(i);
}

// ---- Ask AI: a request in plain words becomes a query in the editor (never run here)
const aiOn = aiOnFeature('query');
const aiInput = ref<HTMLTextAreaElement | null>(null);
const preview = ref<DvAiPreview | null>(null);
/** Ask AI writes SQL, Redis / Valkey commands, mongosh calls and Kibana-console requests. */
const aiHere = true;
/** What the AI writes here, for the panel's words. */
const aiWrites = isKv(e) ? 'commands' : e === 'mongodb' ? 'calls' : e === 'elasticsearch' ? 'requests' : 'query';
/** Sample rows / values may go with the structure for this connection (off by default). */
const samplesOn = computed(() => settings.value?.ai.samples.includes(props.conn.id) === true);
function toggleSamples() {
  const list = settings.value?.ai.samples ?? [];
  void saveSettings({ ai: { samples: samplesOn.value ? list.filter((x) => x !== props.conn.id) : [...list, props.conn.id] } });
}
function askAi() {
  if (!aiHere) return;
  ed.value.ai.open = true;
  setTimeout(() => aiInput.value?.focus());
}
function closeAi() {
  ed.value.ai.open = false;
  setTimeout(() => code.value?.focus());
}
/** A plain copy: reactive arrays cannot cross the context bridge. */
function requestOf(t: AiThread, failed?: DvAiRequest['failed']): DvAiRequest {
  return { prompt: t.prompt, history: t.turns.map((x) => ({ role: x.role, text: x.text })), failed: failed ? { statement: failed.statement, error: failed.error } : undefined };
}
// Steps of running requests arrive by token; a clock ticks while one runs.
const offProgress = api.onAiProgress((p) => {
  const t = editors.value.find((x) => x.ai.token === p.token)?.ai;
  if (t?.busy) t.step = { step: p.step, steps: p.steps, text: p.text, draft: p.draft ?? t.step?.draft };
});
const now = ref(Date.now());
const clock = setInterval(() => {
  if (editors.value.some((x) => x.ai.busy)) now.value = Date.now();
}, 500);
onBeforeUnmount(() => {
  offProgress();
  clearInterval(clock);
});
const elapsed = (t: AiThread) => Math.max(0, Math.floor((now.value - t.started) / 1000));
function stopAi() {
  const t = ed.value.ai;
  if (t.busy && t.token) void api.aiCancel(t.token);
}

async function sendAi(failed?: DvAiRequest['failed']) {
  const editor = ed.value;
  const t = editor.ai;
  if (t.busy || (!t.prompt.trim() && !failed)) return;
  if (!aiOn.value) return void (t.error = 'off');
  t.busy = true;
  t.error = null;
  t.token = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  t.started = now.value = Date.now();
  t.step = { step: 1, steps: 0, text: 'Starting' };
  try {
    const a = await api.aiAsk(props.conn.id, props.db, requestOf(t, failed), t.token);
    t.turns = [...t.turns, { role: 'user', text: failed ? `${t.prompt.trim() ? `${t.prompt.trim()} — ` : ''}fix: ${failed.error}` : t.prompt.trim() }, { role: 'assistant', text: a.query ? `${a.query}\n-- ${a.explanation}` : a.explanation }];
    t.answer = a;
    t.prompt = '';
    t.busy = false;
    t.step = null;
    if (a.query && !a.unanswerable) {
      // The user's own text stays: the query then opens in a new editor tab with the thread.
      // A fix replaces the statement that failed, in place.
      const own = !failed && editor.text.trim() && editor.text.trim() !== t.inserted.trim();
      // SQL arrives formatted like ⌘⇧F would; Redis lines stay as they are.
      const query = isSql(e) ? formatSql(a.query) : a.query;
      t.inserted = query;
      if (own) {
        newTab(query, null, { ...t });
        editor.ai = newThread();
        setTimeout(() => aiInput.value?.focus());
      } else editor.text = query;
    }
  } catch (err) {
    const msg = String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    t.error = msg === 'Stopped' ? null : msg;
    if (msg === 'Stopped') notify('info', 'Ask AI stopped');
  }
  t.busy = false;
  t.step = null;
}
function fixWithAi(r: DvResult) {
  ed.value.ai.open = true;
  void sendAi({ statement: r.statement, error: r.error ?? '' });
}
async function showPreview() {
  const p = await attempt(() => api.aiPreview(props.conn.id, props.db, requestOf(ed.value.ai)));
  if (p) preview.value = p;
}
/** What running the answer would do: read, write (asks first), or refused here. */
const answerKind = computed(() => {
  const q = ed.value.ai.answer?.query;
  if (!q) return null;
  const writes = statementsOf(q).filter((x) => !statementKind(e, x).read).length;
  return !writes ? 'read' : isReadOnly(props.conn) ? 'refused' : 'write';
});
function onAiKey(ev: KeyboardEvent) {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    void sendAi();
  } else if (ev.key === 'Escape') closeAi();
}
function newThreadHere() {
  ed.value.ai = { ...newThread(), open: true };
  setTimeout(() => aiInput.value?.focus());
}

// ---- Redis / Valkey: a reply row opens in a drawer (Formatted / Raw), like a key's value
const reply = ref<{ result: DvResult; index: number } | null>(null);
/** Cells holding JSON or PHP serialize() output get a {} mark. */
const isStructured = (v: unknown) => typeof v === 'string' && v.length > 1 && structured(v) !== null;
watch([current, () => ed.value.results], () => (reply.value = null));

// ---- saved queries
async function save(name: string) {
  const editor = ed.value;
  const q = await attempt(() => api.dvSaveQuery(props.conn.id, props.db, { id: editor.savedId ?? undefined, name, text: editor.text }));
  if (!q) return;
  naming.value = false;
  editor.savedId = q.id;
  editor.savedName = q.name;
  saved.value = await api.dvSavedQueries(props.conn.id, props.db);
  notify('success', `Saved as ${q.name}`);
}
function saveClick() {
  if (!ed.value.text.trim()) return notify('info', 'Write a query first');
  if (ed.value.savedId) void save(ed.value.savedName!);
  else naming.value = true;
}
function openSaved(q: DvSavedQuery) {
  const open = editors.value.find((x) => x.savedId === q.id);
  if (open) current.value = open.id;
  else if (!ed.value.text.trim() && !ed.value.savedId) Object.assign(ed.value, { text: q.text, savedId: q.id, savedName: q.name });
  else newTab(q.text, q);
}
async function deleteSaved() {
  const q = deleting.value!;
  if (await attempt(() => api.dvDeleteQuery(props.conn.id, props.db, q.id).then(() => true))) {
    deleting.value = null;
    saved.value = await api.dvSavedQueries(props.conn.id, props.db);
    for (const x of editors.value) if (x.savedId === q.id) Object.assign(x, { savedId: null, savedName: null });
  }
}
function useHistory(t: string) {
  ed.value.text = t;
}
async function copyResult(r: DvResult, as: 'csv' | 'json') {
  const text = as === 'csv' ? [r.columns.join(','), ...r.rows.map((row) => row.map((v) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(','))].join('\n') : JSON.stringify(r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))), null, 2);
  await navigator.clipboard.writeText(text);
  notify('success', `Copied as ${as.toUpperCase()}`);
}
const short = (s: string) => s.replace(/^(\s*(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)+/, '').replace(/\s+/g, ' ').slice(0, 60);
const label = (x: Editor, i: number) => x.savedName ?? `${W.query === 'SQL' ? 'Query' : W.query[0].toUpperCase() + W.query.slice(1)} ${i + 1}`;
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Editor tabs + actions -->
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-base-300/60 px-2">
      <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        <button v-for="(x, i) in editors" :key="x.id" class="dv-qtab" :class="{ 'is-active': current === x.id }" @click="current = x.id">
          <svg v-if="x.savedId" viewBox="0 0 20 20" class="size-3 opacity-60" fill="currentColor"><path d="M5 3a2 2 0 0 0-2 2v11.5a.5.5 0 0 0 .8.4L10 13l6.2 3.9a.5.5 0 0 0 .8-.4V5a2 2 0 0 0-2-2H5Z" /></svg>
          {{ label(x, i) }}
          <span class="dv-tab-close" @click.stop="closeEditor(x.id)">×</span>
        </button>
        <button class="dv-tab-add" title="New editor (⌘T)" @click="newTab()">+</button>
      </div>
      <button v-if="aiHere && aiOn" class="btn btn-ghost btn-xs gap-1" :class="{ 'btn-active': ed.ai.open }" :title="`Ask AI: write the ${aiWrites} from plain words (⌘⇧K)`" @click="ed.ai.open ? closeAi() : askAi()">
        <svg viewBox="0 0 20 20" class="size-3.5 text-primary" fill="currentColor"><path d="M10 2.5a.75.75 0 0 1 .7.48l1.3 3.38 3.38 1.3a.75.75 0 0 1 0 1.4L12 10.36l-1.3 3.38a.75.75 0 0 1-1.4 0L8 10.36 4.62 9.06a.75.75 0 0 1 0-1.4L8 6.36l1.3-3.38a.75.75 0 0 1 .7-.48ZM15.5 12a.5.5 0 0 1 .47.33l.5 1.2 1.2.5a.5.5 0 0 1 0 .94l-1.2.5-.5 1.2a.5.5 0 0 1-.94 0l-.5-1.2-1.2-.5a.5.5 0 0 1 0-.94l1.2-.5.5-1.2a.5.5 0 0 1 .47-.33Z" /></svg>Ask AI
      </button>
      <button class="btn btn-ghost btn-xs" :title="ed.savedId ? `Save changes to ${ed.savedName}` : 'Save this query'" @click="saveClick">{{ ed.savedId ? 'Save' : 'Save…' }}</button>
      <button v-if="isSql(e)" class="btn btn-ghost btn-xs" title="Format (⌘⇧F)" @click="format">Format</button>
      <button class="btn btn-primary btn-xs gap-1" title="Run all, or the selection (⌘⏎)" :disabled="ed.running || !ed.text.trim()" @click="run">
        <span v-if="ed.running" class="loading loading-spinner loading-xs" />
        <svg v-else viewBox="0 0 20 20" class="size-3" fill="currentColor"><path d="M6 4.5v11a1 1 0 0 0 1.5.9l9-5.5a1 1 0 0 0 0-1.8l-9-5.5A1 1 0 0 0 6 4.5Z" /></svg>Run
      </button>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- Editor -->
      <div ref="column" class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- Ask AI -->
        <div v-if="ed.ai.open" class="shrink-0 border-b border-base-300/60 bg-primary/[0.04] px-3 py-2.5">
          <div v-if="!aiOn" class="flex items-center gap-3 text-xs">
            <span class="opacity-75">Ask AI in the Query tab is off. Turn on AI (and this feature) and add an API key, or a local Ollama model, in Settings → AI.</span>
            <span class="flex-1" />
            <button class="btn btn-primary btn-xs" @click="showSettings = true">Open Settings</button>
            <button class="btn btn-ghost btn-xs btn-square" title="Close" @click="closeAi">✕</button>
          </div>
          <template v-else>
            <div v-if="ed.ai.turns.length" class="mb-2 max-h-24 space-y-0.5 overflow-y-auto text-[11.5px]">
              <div v-for="(t, i) in ed.ai.turns.filter((x) => x.role === 'user')" :key="i" class="truncate opacity-60" :title="t.text"><span class="font-semibold">You:</span> {{ t.text }}</div>
            </div>
            <div class="flex items-start gap-2">
              <textarea ref="aiInput" v-model="ed.ai.prompt" rows="1" class="textarea textarea-sm min-h-0 flex-1 resize-none py-1.5 text-[13px] leading-snug" :placeholder="ed.ai.turns.length ? (isKv(e) ? 'Follow-up: “only the ones without a TTL”, “show their values”…' : 'Follow-up: “only active ones”, “add the category name”…') : isKv(e) ? 'Ask in plain words: “find the session keys”, “show the cart of user 42”…' : e === 'mongodb' || e === 'elasticsearch' ? 'Ask in plain words: “newest orders”, “how many users signed up this week”…' : `Ask in plain words: “newest products”, “top 10 customers by spend this month”…`" :disabled="ed.ai.busy" spellcheck="false" @keydown="onAiKey" @input="(ev) => { const el = ev.target as HTMLTextAreaElement; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px`; }" />
              <button v-if="ed.ai.busy" class="btn btn-sm" title="Stop this request" @click="stopAi">Stop</button>
              <button v-else class="btn btn-primary btn-sm" :disabled="!ed.ai.prompt.trim()" title="Write the query (⏎)" @click="sendAi()">Ask</button>
              <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" @click="closeAi">✕</button>
            </div>
            <!-- While it runs: the step, how long so far, a moving bar -->
            <div v-if="ed.ai.busy" class="mt-2 rounded-lg border border-primary/25 bg-primary/[0.07] px-3 py-2">
              <div class="flex items-center gap-2 text-xs">
                <span class="loading loading-spinner loading-xs text-primary" />
                <span class="min-w-0 flex-1 truncate font-medium">{{ ed.ai.step?.text ?? 'Starting' }}…</span>
                <span v-if="ed.ai.step?.steps" class="shrink-0 opacity-60">step {{ ed.ai.step.step }} of {{ ed.ai.step.steps }}</span>
                <span class="shrink-0 font-mono tabular-nums opacity-60">{{ elapsed(ed.ai) }} s</span>
              </div>
              <progress class="progress progress-primary mt-1.5 h-1 w-full" />
              <!-- The answer as it streams in -->
              <pre v-if="ed.ai.step?.draft?.query" class="mt-2 max-h-32 overflow-auto rounded bg-base-100/70 px-2 py-1.5 font-mono text-[11.5px] whitespace-pre-wrap opacity-85">{{ ed.ai.step.draft.query }}<span class="animate-pulse">▍</span></pre>
              <p v-if="ed.ai.step?.draft?.explanation" class="mt-1 text-[11.5px] opacity-70">{{ ed.ai.step.draft.explanation }}</p>
              <p v-if="elapsed(ed.ai) >= 20" class="mt-1 text-[11px] opacity-55">Bigger models can take a minute on a large schema. Stop and pick a faster model in Settings → AI if it keeps you waiting.</p>
            </div>
            <div v-else-if="ed.ai.error && ed.ai.error !== 'off'" class="mt-2 rounded-lg border border-error/30 bg-error/10 px-2.5 py-1.5 text-xs text-error">{{ ed.ai.error }}</div>
            <div v-else-if="ed.ai.answer" class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span v-if="ed.ai.answer.unanswerable" class="badge badge-warning badge-soft badge-sm">No query</span>
              <span v-else-if="answerKind === 'read'" class="badge badge-success badge-soft badge-sm" title="It only reads">Reads</span>
              <span v-else-if="answerKind === 'write'" class="badge badge-warning badge-soft badge-sm" title="Check it; Run asks first on Production">Changes data</span>
              <span v-else-if="answerKind === 'refused'" class="badge badge-error badge-soft badge-sm">Read-only connection: Run will refuse it</span>
              <span class="min-w-0 flex-1 opacity-75">{{ ed.ai.answer.explanation }}</span>
              <span v-for="t in ed.ai.answer.tables" :key="t" class="badge badge-ghost badge-sm font-mono">{{ t }}</span>
            </div>
            <div class="mt-1.5 flex items-center gap-3 text-[11px] opacity-55">
              <span>⏎ asks · ⇧⏎ new line · the {{ aiWrites === 'query' ? 'query goes' : `${aiWrites} go` }} into the editor, you press Run</span>
              <label class="flex cursor-pointer items-center gap-1" :class="{ 'text-warning opacity-100': samplesOn }" :title="samplesOn ? `On for ${conn.name}: a few values per ${isKv(e) ? 'key pattern' : W.table} go with the structure (clipped). Click to stop.` : `Off: only the structure goes. On: ${isKv(e) ? 'one value per key pattern' : `${3} ${W.rows} per ${W.table}`} go too (clipped), so the AI sees how values are written. For ${conn.name} only.`"><input type="checkbox" class="toggle toggle-xs" :checked="samplesOn" @change="toggleSamples" />Send samples</label>
              <span class="flex-1" />
              <a class="link" :title="samplesOn ? 'Exactly what goes to the model: the instructions, the structure and the sample values' : isKv(e) ? 'Exactly what goes to the model: the instructions and the key name patterns of this database, never values' : 'Exactly what goes to the model: the instructions and the structure of this database, never rows'" @click="showPreview">Preview what is sent</a>
              <a v-if="ed.ai.turns.length" class="link" @click="newThreadHere">New thread</a>
            </div>
          </template>
        </div>
        <DvCodeEditor ref="code" v-model="ed.text" :language="language" :names="names" :placeholder="placeholder" :complete="complete" :complete-version="completeVersion" :min-rows="3" @run="run" />

        <!-- The bar between editor and results: drag it to share the height; fold the results away -->
        <div class="dv-split" :class="{ 'is-dragging': dragging }" title="Drag to resize · double-click to fold the results" @mousedown="startResize" @dblclick="toggleFold">
          <span class="dv-split-grip" />
          <span class="truncate">{{ db }}</span>
          <span class="opacity-60">·</span>
          <span class="truncate opacity-80">⌘⏎ runs everything, or just the selected text<template v-if="complete"> · Ctrl+Space suggests</template></span>
          <span class="flex-1" />
          <span v-if="isKv(e)" class="shrink-0 opacity-80">one command per line</span>
          <span v-else-if="isSql(e)" class="shrink-0 opacity-80">statements end with ;</span>
          <span v-if="folded && ed.results.length" class="badge badge-ghost badge-xs shrink-0">{{ ed.results.length }} result{{ ed.results.length === 1 ? '' : 's' }}</span>
          <button type="button" class="dv-split-btn" title="Results to full height" @click="maximize">
            <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.2 12.8a.75.75 0 0 1 0-1.06l4.27-4.27a.75.75 0 0 1 1.06 0l4.27 4.27a.75.75 0 1 1-1.06 1.06L10 9.06l-3.74 3.74a.75.75 0 0 1-1.06 0Z" clip-rule="evenodd" /><path d="M4.5 4.25A.75.75 0 0 1 5.25 3.5h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Z" /></svg>
          </button>
          <button type="button" class="dv-split-btn" :title="folded ? 'Show the results' : 'Fold the results away'" @click="toggleFold">
            <svg viewBox="0 0 20 20" fill="currentColor" :class="{ 'rotate-180': folded }"><path fill-rule="evenodd" d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /><path d="M4.5 15.75a.75.75 0 0 1 .75-.75h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Z" /></svg>
          </button>
        </div>

        <!-- Results -->
        <div v-show="!folded" class="min-h-0 shrink-0 overflow-hidden" :style="{ height: `${resultsHeight}px` }">
          <div v-if="!ed.results.length" class="grid h-full place-items-center text-xs opacity-45">Results appear here.</div>
          <div v-else class="flex h-full flex-col">
            <div v-if="ed.results.length > 1" class="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-base-300/60 px-2 [scrollbar-width:none]">
              <button v-for="(r, i) in ed.results" :key="i" class="dv-qtab" :class="{ 'is-active': ed.shown === i, 'text-error': r.error }" :title="r.statement" @click="showResult(i)">{{ i + 1 }}. {{ short(r.statement) }}</button>
            </div>
            <template v-for="(r, i) in ed.results" :key="`${ed.id}:${i}`">
              <div v-if="ed.shown === i" class="flex min-h-0 flex-1 flex-col">
                <div v-if="r.error" class="m-3 alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
                  <span class="min-w-0 flex-1 font-mono text-xs">{{ r.error }}</span>
                  <button v-if="aiHere && aiOn" class="btn btn-xs gap-1" :disabled="ed.ai.busy" :title="isKv(e) ? 'Ask AI to fix this command' : 'Ask AI to fix this statement'" @click="fixWithAi(r)"><span v-if="ed.ai.busy" class="loading loading-spinner loading-xs" />Fix with AI</button>
                </div>
                <div v-else-if="!r.columns.length" class="m-3 alert alert-success alert-soft text-sm"><CatMood mood="success" class="size-7 shrink-0 -my-0.5" />{{ r.affected === null ? 'Done' : `${fmtNum(r.affected)} ${r.affected === 1 ? W.row : W.rows} affected` }} · {{ fmtMs(r.ms) }}</div>
                <template v-else-if="ed.editable[i]">
                  <DvDataGrid v-if="presets[`${ed.id}:${i}`]" :conn="conn" :db="db" :table="ed.editable[i]!" :preset="presets[`${ed.id}:${i}`]" @rerun="rerun" />
                  <div v-else class="grid flex-1 place-items-center opacity-60" @vue:mounted="ensurePreset(i)"><span class="loading loading-spinner loading-sm" /></div>
                </template>
                <template v-else>
                  <div class="min-h-0 flex-1 overflow-auto">
                    <table class="dv-grid">
                      <thead><tr><th class="dv-rownum">#</th><th v-for="c in r.columns" :key="c">{{ c }}</th></tr></thead>
                      <tbody>
                        <tr v-for="(row, ri) in r.rows" :key="ri" :class="{ 'cursor-pointer hover:bg-base-200/60': isKv(e), 'bg-primary/10': reply?.result === r && reply.index === ri }" :title="isKv(e) ? 'Open the value (Formatted / Raw)' : undefined" @click="isKv(e) && (reply = { result: r, index: ri })"><td class="dv-rownum">{{ ri + 1 }}</td><td v-for="(v, ci) in row" :key="ci" :class="{ 'is-null': v === null }"><span v-if="isKv(e) && isStructured(v)" class="mr-1.5 rounded bg-primary/15 px-1 font-sans text-[10px] font-semibold text-primary">{}</span>{{ v === null ? 'NULL' : String(v).length > 200 ? `${String(v).slice(0, 200)}…` : v }}</td></tr>
                        <tr v-if="!r.rows.length"><td :colspan="r.columns.length + 1" class="py-6 text-center text-xs opacity-50">No rows.</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <div class="flex h-8 shrink-0 items-center gap-2 border-t border-base-300/60 px-3 text-[11px] opacity-70">
                    <span>{{ fmtNum(r.rows.length) }} {{ r.rows.length === 1 ? W.row : W.rows }}{{ r.rows.length >= 5000 ? ' (first 5000)' : '' }} · {{ fmtMs(r.ms) }}</span>
                    <span v-if="isSql(e)" class="opacity-70">· read-only (joins, aggregates or no primary key in the result)</span>
                    <span class="flex-1" />
                    <button class="btn btn-ghost btn-xs" @click="copyResult(r, 'csv')">Copy CSV</button>
                    <button class="btn btn-ghost btn-xs" @click="copyResult(r, 'json')">Copy JSON</button>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- Side panel: tables to insert, history, saved queries -->
      <!-- Folded: a thin strip; its icons open the panel at that list -->
      <aside v-if="sideFolded" class="dv-side-strip">
        <button type="button" class="dv-split-btn" title="Show the side panel" @click="setSide(true)">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.8 4.2a.75.75 0 0 1 0 1.06L8.06 10l4.74 4.74a.75.75 0 1 1-1.06 1.06l-5.27-5.27a.75.75 0 0 1 0-1.06l5.27-5.27a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
        </button>
        <span class="my-1 h-px w-5 bg-base-content/10" />
        <button type="button" class="dv-split-btn" :title="W.tables[0].toUpperCase() + W.tables.slice(1)" @click="setSide(true, 'tables')">
          <svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11ZM4.5 7v2.5h4.75V7H4.5Zm6.25 0v2.5h4.75V7h-4.75ZM4.5 11v2.5h4.75V11H4.5Zm6.25 0v2.5h4.75V11h-4.75Z" /></svg>
        </button>
        <button type="button" class="dv-split-btn" title="Saved queries" @click="setSide(true, 'saved')">
          <svg viewBox="0 0 20 20" fill="currentColor"><path d="M5 2.75A1.75 1.75 0 0 1 6.75 1h6.5A1.75 1.75 0 0 1 15 2.75v14.5a.75.75 0 0 1-1.18.62L10 15.2l-3.82 2.67A.75.75 0 0 1 5 17.25V2.75Z" /></svg>
        </button>
        <button type="button" class="dv-split-btn" title="History" @click="setSide(true, 'history')">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-12.25a.75.75 0 0 0-1.5 0V10c0 .2.08.39.22.53l2.75 2.75a.75.75 0 1 0 1.06-1.06l-2.53-2.53V5.75Z" clip-rule="evenodd" /></svg>
        </button>
      </aside>
      <aside v-else class="flex w-56 shrink-0 flex-col border-l border-base-300/60 bg-base-200/30">
        <div class="m-2 flex items-center gap-1">
        <div role="tablist" class="seg seg-xs min-w-0 flex-1">
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': side === 'tables' }" @click="side = 'tables'">{{ W.tables[0].toUpperCase() + W.tables.slice(1) }}</a>
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': side === 'saved' }" @click="side = 'saved'">Saved</a>
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': side === 'history' }" @click="side = 'history'">History</a>
        </div>
        <button type="button" class="dv-split-btn" title="Fold the side panel to the right" @click="setSide(false)">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.2 15.8a.75.75 0 0 1 0-1.06L11.94 10 7.2 5.26a.75.75 0 1 1 1.06-1.06l5.27 5.27a.75.75 0 0 1 0 1.06L8.26 15.8a.75.75 0 0 1-1.06 0Z" clip-rule="evenodd" /></svg>
        </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <template v-if="side === 'history'">
            <p v-if="!hist.length" class="px-1 text-xs opacity-50">Queries you run in <span class="font-mono">{{ db }}</span> show here for this window’s life.</p>
            <button v-for="(h, i) in hist" :key="i" class="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-base-200" :title="h" @click="useHistory(h)">{{ short(h) }}</button>
          </template>
          <template v-else-if="side === 'saved'">
            <p v-if="!saved.length" class="px-1 text-xs opacity-50">Save a query with Save… above; it is kept for <span class="font-mono">{{ db }}</span>.</p>
            <p v-else class="px-1 pb-1.5 text-[11px] opacity-50">Saved for <span class="font-mono">{{ db }}</span></p>
            <div v-for="q in saved" :key="q.id" class="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-base-200">
              <button class="min-w-0 flex-1 text-left text-xs" :title="q.anyDb ? `${q.text}\n\nSaved before queries were kept per ${W.db}; save it again to keep it for ${db} only.` : q.text" @click="openSaved(q)">
                <span class="block truncate">{{ q.name }}</span>
                <span v-if="q.anyDb" class="block text-[10px] opacity-50">all {{ W.dbs }}</span>
              </button>
              <button class="btn btn-ghost btn-xs invisible h-5 min-h-0 px-1 text-error group-hover:visible" title="Delete" @click="deleting = q">✕</button>
            </div>
          </template>
          <template v-else>
            <p v-if="!tables.length" class="px-1 text-xs opacity-50">None yet.</p>
            <button v-for="t in tables" :key="t.name" class="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-base-200" :title="`Insert ${t.name} at the cursor`" @click="code?.insert(t.name)">{{ t.name }}</button>
          </template>
        </div>
      </aside>
    </div>

    <DvPrompt v-if="naming" title="Save query" label="Name" placeholder="e.g. Unpaid orders" confirm="Save" :hint="`Kept for the ${db} ${W.db} of ${conn.name}.`" @ok="save" @cancel="naming = false" />
 <dialog v-if="preview" open class="modal modal-open" @keydown.esc="preview = null">
      <div class="modal-box flex max-h-[85vh] w-[46rem] max-w-[95vw] flex-col gap-3">
        <div>
          <h3 class="text-lg font-semibold tracking-tight">What Ask AI sends</h3>
          <p class="text-sm opacity-65">To {{ preview.provider }} · <span class="font-mono">{{ preview.model }}</span>. {{ samplesOn ? `The structure of ${db} and a few sample values (Send samples is on for ${conn.name})` : isKv(e) ? `Key name patterns of database ${db} only (ids shown as *): no values` : `The structure of ${db} only: no rows` }}, no connection settings, no passwords.<template v-if="preview.staged"> This database has many tables: the list goes first, the structure of the tables picked in a second request.</template></p>
        </div>
        <pre class="min-h-0 flex-1 overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-[11px] whitespace-pre-wrap">{{ preview.system }}</pre>
        <div v-if="preview.messages.length" class="space-y-1">
          <span class="label-caps">Conversation</span>
          <pre class="max-h-40 overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-[11px] whitespace-pre-wrap">{{ preview.messages.map((m) => `${m.role === 'user' ? 'You' : 'AI'}: ${m.text || '(empty)'}`).join('\n\n') }}</pre>
        </div>
        <div class="modal-action mt-0"><button class="btn btn-sm" @click="preview = null">Close</button></div>
      </div>
      <div class="modal-backdrop" @click="preview = null" />
    </dialog>
    <DvReplyViewer v-if="reply" :result="reply.result" :index="reply.index" @close="reply = null" @move="(i) => reply && (reply = { result: reply.result, index: i })" />
    <ConfirmDialog v-if="deleting" :title="`Delete ${deleting.name}?`" text="Only the saved query is removed." confirm="Delete" tone="error" @ok="deleteSaved" @cancel="deleting = null" />
  </div>
</template>
