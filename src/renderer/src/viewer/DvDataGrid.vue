<script setup lang="ts">
import { keyLabel } from '@shared/platform';
import { computed, onMounted, ref, watch } from 'vue';
import type { DvColumn, DvConnection, DvGridPrefs, DvRows, DvStructure } from '@shared/types';
import { attempt, api, notify } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DvCellEditor from './DvCellEditor.vue';
import DvPrompt from './DvPrompt.vue';
import DvInsertForm from './DvInsertForm.vue';
import DvJsonViewer from './DvJsonViewer.vue';
import { editorFor } from './coltypes';
import { confirmProdWrite, fmtMs, fmtNum, isDoc, isReadOnly, logActivity, words } from './viewer';
import CatMood from './CatMood.vue';

/**
 * A table's rows: paged, sortable by column, filtered with a WHERE clause (a
 * JSON filter / query string for documents), edited in place (double-click a
 * cell; the editor follows the column type: ENUM dropdown, BOOLEAN toggle,
 * date / time pickers, numbers, JSON), with insert and delete of selected rows.
 * With `preset` (a query result from one table) the rows come from the caller
 * and there is no paging or filter; edits still go to the table.
 *
 * Columns can be resized (drag the edge of a header; double-click it for the
 * natural width) and reordered (drag a header); both are kept per table with
 * its saved filters. A foreign-key value carries a link to the row it points
 * at: the referenced table opens filtered to it (`follow`), with a way back.
 */
const props = defineProps<{ conn: DvConnection; db: string; table: string; preset?: DvRows | null; initialWhere?: string; back?: string | null }>();
const emit = defineEmits<{ rerun: []; follow: [target: { table: string; where: string; from: string }]; back: [] }>();
const W = words(props.conn.engine);
const doc = isDoc(props.conn.engine);
const PAGE = 200;
const page = ref(0);
const orderBy = ref<string | null>(null);
const desc = ref(false);
const where = ref(props.initialWhere ?? '');
const whereDraft = ref(props.initialWhere ?? '');
const result = ref<DvRows | null>(props.preset ?? null);
const structure = ref<DvStructure | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const selected = ref<Set<number>>(new Set());
const editing = ref<{ row: number; col: number; value: string | null } | null>(null);
/** The New row form is open. */
const inserting = ref(false);
const confirmDelete = ref(false);
const busy = ref(false);
const filterInput = ref<HTMLInputElement | null>(null);

const pages = computed(() => Math.max(1, Math.ceil((result.value?.total ?? 0) / PAGE)));
const pk = computed(() => result.value?.primaryKey ?? []);
const editable = computed(() => pk.value.length > 0 && pk.value.every((k) => result.value?.columns.includes(k)));
const colInfo = (name: string) => structure.value?.columns.find((c) => c.name === name);
const typeOf = (name: string) => colInfo(name)?.type ?? '';
const uniqueCols = computed(() => new Set((structure.value?.indexes ?? []).filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0])));

// ---- per-table view: column widths and order, saved filters
const prefs = ref<DvGridPrefs>({ widths: {}, order: [], filters: [] });
async function loadPrefs() {
  prefs.value = await api.dvGridPrefs(props.conn.id, props.db, props.table).catch(() => prefs.value);
}
function savePrefs() {
  const p = JSON.parse(JSON.stringify(prefs.value)) as DvGridPrefs;
  void api.dvSetGridPrefs(props.conn.id, props.db, props.table, p).catch((e: Error) => notify('error', e.message));
}
/** Result column indexes in display order (saved order first, new columns after, as they come). */
const view = computed<number[]>(() => {
  const cols = result.value?.columns ?? [];
  const pos = new Map(prefs.value.order.map((c, i) => [c, i]));
  return cols.map((_, i) => i).sort((a, b) => (pos.get(cols[a]) ?? 1e6 + a) - (pos.get(cols[b]) ?? 1e6 + b));
});
const customized = computed(() => Object.keys(prefs.value.widths).length > 0 || prefs.value.order.length > 0);
const widthOf = (col: string) => {
  const w = prefs.value.widths[col];
  return w ? { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px` } : undefined;
};
function resetColumns() {
  prefs.value.widths = {};
  prefs.value.order = [];
  savePrefs();
}

// resize: drag a header's right edge
let suppressSort = false;
function startResize(col: string, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const th = (e.target as HTMLElement).closest('th')!;
  const startX = e.clientX;
  const startW = th.getBoundingClientRect().width;
  document.body.classList.add('dv-resizing');
  const move = (ev: MouseEvent) => (prefs.value.widths[col] = Math.max(48, Math.min(2000, Math.round(startW + ev.clientX - startX))));
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('dv-resizing');
    suppressSort = true;
    setTimeout(() => (suppressSort = false), 0);
    savePrefs();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
function autoWidth(col: string) {
  delete prefs.value.widths[col];
  savePrefs();
}

// reorder: drag a header onto another
const dragCol = ref<string | null>(null);
const dropAt = ref<{ col: string; after: boolean } | null>(null);
function onDragStart(col: string, e: DragEvent) {
  dragCol.value = col;
  e.dataTransfer?.setData('text/plain', col);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(col: string, e: DragEvent) {
  if (!dragCol.value) return;
  e.preventDefault();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropAt.value = col === dragCol.value ? null : { col, after: e.clientX > r.left + r.width / 2 };
}
function onDrop() {
  const from = dragCol.value;
  const at = dropAt.value;
  dragCol.value = null;
  dropAt.value = null;
  if (!from || !at || !result.value) return;
  const names = view.value.map((i) => result.value!.columns[i]).filter((c) => c !== from);
  names.splice(names.indexOf(at.col) + (at.after ? 1 : 0), 0, from);
  prefs.value.order = names;
  savePrefs();
}
function onDragEnd() {
  dragCol.value = null;
  dropAt.value = null;
}

// saved filters
const naming = ref(false);
const activeFilter = computed(() => prefs.value.filters.find((f) => f.where === where.value) ?? null);
function useFilter(text: string) {
  whereDraft.value = text;
  applyFilter();
  (document.activeElement as HTMLElement | null)?.blur();
}
function saveFilter(name: string) {
  const id = `f-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const same = prefs.value.filters.find((f) => f.name === name);
  if (same) same.where = where.value;
  else prefs.value.filters.push({ id, name, where: where.value });
  naming.value = false;
  savePrefs();
  notify('success', `Filter “${name}” saved for ${props.table}`);
}
function deleteFilter(id: string) {
  prefs.value.filters = prefs.value.filters.filter((f) => f.id !== id);
  savePrefs();
}

// ---- foreign keys: a link from the value to the row it points at
const fkOf = computed(() => {
  const m = new Map<string, { refTable: string; refColumn: string }>();
  for (const f of structure.value?.foreignKeys ?? []) if (f.columns.length === 1 && f.refColumns.length === 1) m.set(f.columns[0], { refTable: f.refTable, refColumn: f.refColumns[0] });
  return m;
});
const mysqlLike = props.conn.engine === 'mysql' || props.conn.engine === 'mariadb';
const ident = (n: string) => (mysqlLike ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`);
function literal(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  const t = String(v);
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return `'${(mysqlLike ? t.replace(/\\/g, '\\\\') : t).replace(/'/g, "''")}'`;
}
function follow(col: string, v: unknown) {
  const fk = fkOf.value.get(col);
  if (!fk || v === null) return;
  emit('follow', { table: fk.refTable, where: `${ident(fk.refColumn)} = ${literal(v)}`, from: where.value });
}

async function load() {
  if (props.preset) {
    result.value = props.preset;
    structure.value ??= await api.dvStructure(props.conn.id, props.db, props.table).catch(() => null);
    selected.value = new Set();
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    result.value = await api.dvRows(props.conn.id, props.db, props.table, { offset: page.value * PAGE, limit: PAGE, orderBy: orderBy.value, desc: desc.value, where: where.value });
    structure.value ??= await api.dvStructure(props.conn.id, props.db, props.table).catch(() => null);
  } catch (e) {
    error.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  loading.value = false;
  selected.value = new Set();
}
onMounted(() => {
  void load();
  void loadPrefs();
});
watch([page, orderBy, desc, where], load);
watch(
  () => props.preset,
  () => void load(),
);
defineExpose({ startInsert, deleteSelected, focusFilter, reload: load });

function sort(col: string) {
  if (props.preset || suppressSort) return;
  if (orderBy.value === col) {
    if (desc.value) orderBy.value = null;
    desc.value = !desc.value && orderBy.value === col;
  } else {
    orderBy.value = col;
    desc.value = false;
  }
  page.value = 0;
}
function applyFilter() {
  where.value = whereDraft.value.trim();
  page.value = 0;
}
function focusFilter() {
  filterInput.value?.focus();
  filterInput.value?.select();
}
const reload = () => (props.preset ? emit('rerun') : load());

function keyOf(row: unknown[]): Record<string, unknown> {
  const cols = result.value!.columns;
  return Object.fromEntries(pk.value.map((k) => [k, row[cols.indexOf(k)]]));
}

// ---- inline edit (a small panel anchored to the cell: editor, then NULL / Cancel / Save)
const pop = ref<{ top: number; left: number; width: number; above: boolean } | null>(null);
const readOnly = computed(() => isReadOnly(props.conn));
function startEdit(r: number, c: number, e?: MouseEvent) {
  if (readOnly.value) return notify('info', 'This connection is read-only');
  if (!editable.value) return notify('info', `This ${W.table} has no primary key in the result, so cells cannot be edited here.`);
  const v = result.value!.rows[r][c];
  editing.value = { row: r, col: c, value: v === null ? null : String(v) };
  const cell = (e?.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  const kind = editorFor(typeOf(result.value!.columns[c])).kind;
  const width = Math.min(window.innerWidth - 24, Math.max(cell?.width ?? 0, kind === 'json' || kind === 'textarea' || kind === 'set' ? 420 : 320));
  const height = kind === 'json' || kind === 'textarea' ? 230 : 150;
  const below = (cell?.bottom ?? 0) + 6;
  const above = below + height > window.innerHeight - 12;
  pop.value = {
    top: above ? Math.max(12, (cell?.top ?? 0) - 6 - height) : below,
    left: Math.max(12, Math.min(cell?.left ?? 12, window.innerWidth - width - 12)),
    width,
    above,
  };
}
function cancelEdit() {
  editing.value = null;
  pop.value = null;
}
async function commitEdit() {
  const e = editing.value;
  if (!e) return;
  const row = result.value!.rows[e.row];
  const col = result.value!.columns[e.col];
  const old = row[e.col];
  const value = e.value;
  editing.value = null;
  pop.value = null;
  if ((old === null && value === null) || (old !== null && String(old) === value)) return;
  const key = keyOf(row);
  if (!(await confirmProdWrite(props.conn, 'Update 1 row', `UPDATE ${props.table} SET ${col} = ${value === null ? 'NULL' : JSON.stringify(value)} WHERE ${Object.entries(key).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(' AND ')}`))) return;
  busy.value = true;
  const t0 = Date.now();
  const ok = await attempt(() => api.dvUpdateRow(props.conn.id, props.db, props.table, key, { [col]: value }).then(() => true));
  busy.value = false;
  logActivity(props.conn.id, { text: `[${props.db}] UPDATE ${props.table} SET ${col} = ${value === null ? 'NULL' : JSON.stringify(value)} WHERE ${Object.entries(key).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(' AND ')}`, ms: Date.now() - t0, affected: ok ? 1 : 0, error: ok ? null : 'failed' });
  if (ok) row[e.col] = value;
}
function setNull() {
  if (editing.value) {
    editing.value.value = null;
    void commitEdit();
  }
}

// ---- insert (a form with a typed field per column, like editing a cell)
function startInsert() {
  if (readOnly.value) return notify('info', 'This connection is read-only');
  inserting.value = true;
}
/** The form's fields, in the grid's column order; a column the structure does not describe gets a plain text field. */
const insertColumns = computed<DvColumn[]>(() => {
  const known = structure.value?.columns ?? [];
  const names = result.value ? view.value.map((i) => result.value!.columns[i]) : known.map((c) => c.name);
  for (const c of known) if (!names.includes(c.name)) names.push(c.name);
  return names.map((n) => colInfo(n) ?? { name: n, type: '', nullable: true, default: null, key: false, autoIncrement: false, comment: null, extra: null });
});
async function commitInsert(values: Record<string, unknown>) {
  const shown = JSON.stringify(values);
  if (!(await confirmProdWrite(props.conn, 'Insert a row', `INSERT INTO ${props.table} ${shown}`))) return;
  busy.value = true;
  const t0 = Date.now();
  const ok = await attempt(() => api.dvInsertRow(props.conn.id, props.db, props.table, values).then(() => true));
  busy.value = false;
  logActivity(props.conn.id, { text: `[${props.db}] INSERT INTO ${props.table} ${shown}`, ms: Date.now() - t0, affected: ok ? 1 : 0, error: ok ? null : 'failed' });
  if (!ok) return;
  inserting.value = false;
  notify('success', `${W.row} inserted`);
  await reload();
}

// ---- select / delete
function toggleRow(i: number, e: MouseEvent) {
  const s = new Set(e.metaKey || e.ctrlKey ? selected.value : []);
  if (e.shiftKey && selected.value.size) {
    const last = [...selected.value].pop()!;
    for (let k = Math.min(last, i); k <= Math.max(last, i); k++) s.add(k);
  } else s.has(i) && (e.metaKey || e.ctrlKey) ? s.delete(i) : s.add(i);
  selected.value = s;
}
function deleteSelected() {
  if (readOnly.value) return notify('info', 'This connection is read-only');
  if (!selected.value.size) return notify('info', `Select ${W.rows} first (click; ${keyLabel('mod')}-click or ${keyLabel('shift')}-click for several).`);
  if (!editable.value) return notify('info', `This ${W.table} has no primary key in the result; delete with a query instead.`);
  confirmDelete.value = true;
}
async function doDelete() {
  if (!(await confirmProdWrite(props.conn, `Delete ${selected.value.size} ${selected.value.size === 1 ? W.row : W.rows}`, `DELETE FROM ${props.table} — ${selected.value.size} by primary key`))) return void (confirmDelete.value = false);
  busy.value = true;
  const keys = [...selected.value].map((i) => keyOf(result.value!.rows[i]));
  const t0 = Date.now();
  const n = await attempt(() => api.dvDeleteRows(props.conn.id, props.db, props.table, keys));
  busy.value = false;
  confirmDelete.value = false;
  logActivity(props.conn.id, { text: `[${props.db}] DELETE FROM ${props.table} (${keys.length} ${keys.length === 1 ? W.row : W.rows} by primary key)`, ms: Date.now() - t0, affected: n ?? 0, error: n === undefined ? 'failed' : null });
  if (n !== undefined) {
    notify('success', `${n} ${n === 1 ? W.row : W.rows} deleted`);
    await reload();
  }
}

// ---- JSON cells: a { } button opens the value formatted and coloured (DvJsonViewer); double-click still edits.
const viewing = ref<{ row: number; col: number; el: HTMLElement } | null>(null);
/** json / jsonb / JSON columns, MongoDB objects and arrays, and text that looks like a JSON object or array. */
function isJsonCell(v: unknown, col: string): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'object') return true;
  if (editorFor(typeOf(col)).kind === 'json') return true;
  const s = String(v).trim();
  return s.length > 1 && ((s[0] === '{' && s.endsWith('}')) || (s[0] === '[' && s.endsWith(']')));
}
function openJson(r: number, c: number, e: MouseEvent) {
  viewing.value = { row: r, col: c, el: (e.currentTarget as HTMLElement).closest('td')! };
}
/** Edit from the viewer: the usual cell editor, placed at the cell. */
function editFromViewer() {
  const v = viewing.value!;
  viewing.value = null;
  startEdit(v.row, v.col, { currentTarget: v.el } as unknown as MouseEvent);
}

/** Cell text: NULL dimmed, booleans spelled out, long text cut. */
function display(v: unknown, col: string): string {
  if (v === null) return 'NULL';
  const k = editorFor(typeOf(col)).kind;
  if (k === 'bool') return /^(1|true|t|yes)$/i.test(String(v)) ? 'true' : /^(0|false|f|no)$/i.test(String(v)) ? 'false' : String(v);
  const s = String(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Toolbar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-base-300/60 px-3 py-2">
      <button v-if="back && !preset" type="button" class="btn btn-ghost btn-sm gap-1 px-2" :title="`Back to ${back}`" @click="emit('back')">
        <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M12.8 4.2a.75.75 0 0 1 0 1.06L8.06 10l4.74 4.74a.75.75 0 1 1-1.06 1.06l-5.27-5.27a.75.75 0 0 1 0-1.06l5.27-5.27a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
        <span class="max-w-32 truncate font-mono text-xs">{{ back }}</span>
      </button>
      <form v-if="!preset" class="flex min-w-0 flex-1 items-center gap-2" @submit.prevent="applyFilter">
        <label class="input input-sm flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
          <span class="shrink-0 font-sans text-[11px] font-semibold tracking-wide uppercase opacity-50">{{ doc ? 'Filter' : 'Where' }}</span>
          <input ref="filterInput" v-model="whereDraft" class="grow" :placeholder="conn.engine === 'mongodb' ? '{ status: \'active\' }' : conn.engine === 'elasticsearch' ? 'title:shoes or { match: { … } }' : 'id > 100 AND name LIKE \'%a%\''" spellcheck="false" />
          <button v-if="whereDraft || where" type="button" class="opacity-50 hover:opacity-100" title="Clear" @click="whereDraft = ''; applyFilter()">✕</button>
        </label>
        <button class="btn btn-sm">Filter</button>
        <div class="dropdown dropdown-end">
          <button type="button" tabindex="0" class="btn btn-sm gap-1.5" :class="{ 'btn-active': activeFilter }" :title="activeFilter ? `Saved filter: ${activeFilter.name}` : 'Saved filters of this table'">
            <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M5 2.75A1.75 1.75 0 0 1 6.75 1h6.5A1.75 1.75 0 0 1 15 2.75v14.5a.75.75 0 0 1-1.18.62L10 15.2l-3.82 2.67A.75.75 0 0 1 5 17.25V2.75Z" /></svg>
            <span class="max-w-28 truncate">{{ activeFilter?.name ?? 'Saved' }}</span>
            <span v-if="prefs.filters.length && !activeFilter" class="badge badge-ghost badge-xs">{{ prefs.filters.length }}</span>
          </button>
          <div tabindex="0" class="dropdown-content z-30 mt-1.5 w-80 rounded-box border border-base-300/70 bg-base-100 p-2 shadow-xl">
            <p class="label-caps px-2 pt-1 pb-2">Saved filters · {{ table }}</p>
            <p v-if="!prefs.filters.length" class="px-2 pb-2 text-xs opacity-60">None yet. Filter the rows, then save the filter here to reuse it.</p>
            <ul class="max-h-72 space-y-0.5 overflow-y-auto">
              <li v-for="f in prefs.filters" :key="f.id" class="group flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-base-content/5" :class="{ 'bg-primary/10': activeFilter?.id === f.id }">
                <button type="button" class="min-w-0 flex-1 text-left" @click="useFilter(f.where)">
                  <span class="block truncate text-sm font-medium">{{ f.name }}</span>
                  <span class="block truncate font-mono text-[11px] opacity-55">{{ f.where }}</span>
                </button>
                <button type="button" class="btn btn-ghost btn-xs btn-square opacity-0 group-hover:opacity-60 hover:!opacity-100" title="Delete this saved filter" @click.stop="deleteFilter(f.id)">✕</button>
              </li>
            </ul>
            <div class="mt-1.5 border-t border-base-300/60 pt-2">
              <button type="button" class="btn btn-ghost btn-sm w-full justify-start gap-2" :disabled="!where" :title="where ? '' : 'Apply a filter first'" @click="naming = true; ($event.currentTarget as HTMLElement).blur()">
                <span class="text-base leading-none">+</span>{{ activeFilter ? 'Save under another name…' : 'Save current filter…' }}
              </button>
            </div>
          </div>
        </div>
      </form>
      <span v-else class="min-w-0 flex-1 truncate text-xs opacity-60">Rows of <span class="font-mono">{{ table }}</span> — editable like the Data tab; rerun the query to refresh.</span>
      <span class="w-px self-stretch bg-base-300/60" />
      <button class="btn btn-sm" :title="readOnly ? 'Read-only connection' : `Insert row (${keyLabel('mod+shift+I')})`" :disabled="!!inserting || readOnly" @click="startInsert">+ {{ W.row }}</button>
      <button class="btn btn-sm" :class="{ 'btn-error btn-soft': selected.size }" :title="`Delete selected rows (${keyLabel('mod+⌫')})`" :disabled="!selected.size" @click="deleteSelected">Delete{{ selected.size ? ` ${selected.size}` : '' }}</button>
      <button v-if="customized" class="btn btn-ghost btn-sm btn-square" title="Reset column widths and order" @click="resetColumns">
        <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 5A.75.75 0 0 1 2.75 9h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 9.75Zm.75 4.25a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Z" /></svg>
      </button>
      <button class="btn btn-ghost btn-sm btn-square" :title="preset ? 'Run the query again' : 'Reload'" :disabled="loading" @click="reload"><span v-if="loading" class="loading loading-spinner loading-xs" /><template v-else>↻</template></button>
    </div>

    <div v-if="error" class="m-4 alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span class="font-mono text-xs">{{ error }}</span></div>

    <!-- Grid -->
    <div v-else class="min-h-0 flex-1 overflow-auto" @keydown.esc="cancelEdit" @scroll="editing && cancelEdit()">
      <table v-if="result" class="dv-grid">
        <thead>
          <tr>
            <th class="dv-rownum">#</th>
            <th
              v-for="i in view"
              :key="result.columns[i]"
              :style="widthOf(result.columns[i])"
              :class="{ 'is-sorted': orderBy === result.columns[i], 'cursor-default': preset, 'is-dragging': dragCol === result.columns[i], 'is-drop-before': dropAt?.col === result.columns[i] && !dropAt.after, 'is-drop-after': dropAt?.col === result.columns[i] && dropAt.after }"
              :title="`${result.columns[i]}${typeOf(result.columns[i]) ? ` · ${typeOf(result.columns[i])}` : ''}${pk.includes(result.columns[i]) ? ' · primary key' : ''}${fkOf.get(result.columns[i]) ? ` · → ${fkOf.get(result.columns[i])!.refTable}.${fkOf.get(result.columns[i])!.refColumn}` : ''}\nDrag to move · drag the edge to resize`"
              draggable="true"
              @click="sort(result.columns[i])"
              @dragstart="onDragStart(result.columns[i], $event)"
              @dragover="onDragOver(result.columns[i], $event)"
              @drop.prevent="onDrop"
              @dragend="onDragEnd"
            >
              <span class="flex items-center gap-1">
                <svg v-if="pk.includes(result.columns[i])" viewBox="0 0 20 20" class="size-3 shrink-0 text-warning" fill="currentColor"><path d="M12.5 2a5.5 5.5 0 0 0-5.3 7l-4.9 4.9a1 1 0 0 0-.3.7V17a1 1 0 0 0 1 1h2.4a1 1 0 0 0 .7-.3l.6-.6V15.5h1.6v-1.6h1.6l1.2-1.2A5.5 5.5 0 1 0 12.5 2Zm1.5 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" /></svg>
                <span class="truncate">{{ result.columns[i] }}</span>
                <span v-if="uniqueCols.has(result.columns[i])" class="dv-key-tag is-uq" title="Unique">UQ</span>
                <span v-if="fkOf.get(result.columns[i])" class="dv-key-tag is-fk" :title="`Foreign key → ${fkOf.get(result.columns[i])!.refTable}.${fkOf.get(result.columns[i])!.refColumn}`">FK</span>
                <span v-if="typeOf(result.columns[i])" class="text-[9px] font-normal tracking-wide uppercase opacity-40">{{ editorFor(typeOf(result.columns[i])).kind === 'text' ? '' : editorFor(typeOf(result.columns[i])).kind }}</span>
                <span v-if="orderBy === result.columns[i]" class="opacity-70">{{ desc ? '↓' : '↑' }}</span>
              </span>
              <span class="dv-col-resize" title="Drag to resize · double-click for the natural width" draggable="false" @mousedown="startResize(result.columns[i], $event)" @click.stop @dblclick.stop="autoWidth(result.columns[i])" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in result.rows" :key="ri" :class="{ 'is-selected': selected.has(ri) }">
            <td class="dv-rownum" @click="toggleRow(ri, $event)">{{ page * PAGE + ri + 1 }}</td>
            <td
              v-for="ci in view"
              :key="ci"
              :style="widthOf(result.columns[ci])"
              :class="{ 'is-null': row[ci] === null, 'is-editing': editing?.row === ri && editing.col === ci, 'is-fk': row[ci] !== null && fkOf.has(result.columns[ci]), 'has-json': isJsonCell(row[ci], result.columns[ci]) }"
              @click="editing || toggleRow(ri, $event)"
              @dblclick="startEdit(ri, ci, $event)"
            >
              <button
                v-if="row[ci] !== null && fkOf.has(result.columns[ci])"
                type="button"
                class="dv-fk-link"
                :title="`Open the ${fkOf.get(result.columns[ci])!.refTable} row with ${fkOf.get(result.columns[ci])!.refColumn} = ${row[ci]}`"
                @click.stop="follow(result.columns[ci], row[ci])"
                @dblclick.stop
              >
                <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.64l-3.22-3.22a.75.75 0 1 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.22-3.22H3.75A.75.75 0 0 1 3 10Z" clip-rule="evenodd" /></svg>
              </button>{{ display(row[ci], result.columns[ci]) }}<button
                v-if="isJsonCell(row[ci], result.columns[ci])"
                type="button"
                class="dv-json-open"
                title="View as formatted JSON"
                @click.stop="openJson(ri, ci, $event)"
                @dblclick.stop
              >{ }</button>
            </td>
          </tr>
          <tr v-if="!result.rows.length">
            <td :colspan="result.columns.length + 1" class="py-10 text-center text-sm opacity-50">{{ where ? 'No rows match the filter.' : `No ${W.rows} yet — add one with + ${W.row}.` }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="loading" class="grid h-full place-items-center opacity-60"><span class="loading loading-spinner" /></div>
    </div>

    <!-- Footer: paging, timing, insert actions -->
    <div class="flex h-9 shrink-0 items-center gap-3 border-t border-base-300/60 px-3 text-xs">
      <template v-if="result">
        <span class="tabular-nums opacity-70">{{ fmtNum(result.total) }} {{ result.total === 1 ? W.row : W.rows }}<template v-if="where"> match</template> · {{ fmtMs(result.ms) }}</span>
        <span v-if="!editable" class="opacity-50" title="A primary key is needed to edit rows in place">read-only (no primary key)</span>
        <span v-else-if="readOnly" class="opacity-50">read-only connection</span>
        <span v-else class="opacity-40">double-click a cell to edit</span>
        <span class="flex-1" />
        <span v-if="selected.size" class="opacity-70">{{ selected.size }} selected</span>
        <div v-if="!preset" class="join">
          <button class="btn btn-ghost btn-xs join-item" :disabled="page === 0" @click="page = 0">«</button>
          <button class="btn btn-ghost btn-xs join-item" :disabled="page === 0" @click="page--">‹</button>
          <span class="join-item flex items-center px-2 tabular-nums">{{ page + 1 }} / {{ pages }}</span>
          <button class="btn btn-ghost btn-xs join-item" :disabled="page >= pages - 1" @click="page++">›</button>
          <button class="btn btn-ghost btn-xs join-item" :disabled="page >= pages - 1" @click="page = pages - 1">»</button>
        </div>
      </template>
    </div>

    <!-- Cell editor panel -->
    <Teleport to="body">
      <template v-if="editing && pop && result">
        <div class="fixed inset-0 z-40" @mousedown="commitEdit" />
        <div class="dv-pop fixed z-50" :class="{ 'is-above': pop.above }" :style="{ top: `${pop.top}px`, left: `${pop.left}px`, width: `${pop.width}px` }" @keydown.esc.stop="cancelEdit">
          <div class="dv-pop-head">
            <svg v-if="pk.includes(result.columns[editing.col])" viewBox="0 0 20 20" class="size-3 shrink-0 text-warning" fill="currentColor"><path d="M12.5 2a5.5 5.5 0 0 0-5.3 7l-4.9 4.9a1 1 0 0 0-.3.7V17a1 1 0 0 0 1 1h2.4a1 1 0 0 0 .7-.3l.6-.6V15.5h1.6v-1.6h1.6l1.2-1.2A5.5 5.5 0 1 0 12.5 2Zm1.5 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" /></svg>
            <span class="truncate font-mono text-xs font-semibold">{{ result.columns[editing.col] }}</span>
            <span v-if="typeOf(result.columns[editing.col])" class="badge badge-ghost badge-xs shrink-0 font-mono">{{ typeOf(result.columns[editing.col]) }}</span>
            <span class="flex-1" />
            <span class="shrink-0 text-[11px] opacity-50">row {{ page * PAGE + editing.row + 1 }}</span>
          </div>
          <div class="dv-pop-body">
            <DvCellEditor v-model="editing.value" :type="typeOf(result.columns[editing.col])" :options="colInfo(result.columns[editing.col])?.options" :nullable="colInfo(result.columns[editing.col])?.nullable ?? true" autofocus @commit="commitEdit" @cancel="cancelEdit" />
            <p v-if="editing.value === null" class="mt-1.5 text-[11px] italic opacity-50">NULL — type to set a value</p>
          </div>
          <div class="dv-pop-foot">
            <button class="btn btn-ghost btn-sm font-mono" :disabled="colInfo(result.columns[editing.col])?.nullable === false" :title="colInfo(result.columns[editing.col])?.nullable === false ? 'This column does not allow NULL' : 'Save NULL'" @mousedown.prevent.stop="setNull">Set NULL</button>
            <span class="flex-1" />
            <button class="btn btn-ghost btn-sm" @mousedown.prevent.stop="cancelEdit">Cancel <kbd class="kbd kbd-xs ml-1 opacity-60">esc</kbd></button>
            <button class="btn btn-primary btn-sm" @mousedown.prevent.stop="commitEdit">Save <kbd class="kbd kbd-xs ml-1 border-0 bg-white/20 text-current">⏎</kbd></button>
          </div>
        </div>
      </template>
    </Teleport>

    <DvJsonViewer
      v-if="viewing && result"
      :value="result.rows[viewing.row][viewing.col]"
      :column="result.columns[viewing.col]"
      :type="typeOf(result.columns[viewing.col])"
      :row="page * PAGE + viewing.row + 1"
      :editable="editable && !readOnly"
      @edit="editFromViewer"
      @close="viewing = null"
    />
    <DvInsertForm v-if="inserting" :table="table" :columns="insertColumns" :row-word="W.row" :busy="busy" @save="commitInsert" @cancel="inserting = false" />
    <DvPrompt v-if="naming" title="Save filter" label="Name" :initial="activeFilter?.name ?? ''" placeholder="e.g. Active customers" confirm="Save" :hint="`${doc ? 'Filter' : 'WHERE'} ${where}`" @ok="saveFilter" @cancel="naming = false" />
    <ConfirmDialog v-if="confirmDelete" :title="`Delete ${selected.size} ${selected.size === 1 ? W.row : W.rows}?`" :text="`They are removed from ${table} right away; there is no undo.`" confirm="Delete" tone="error" :busy="busy" @ok="doDelete" @cancel="confirmDelete = false" />
  </div>
</template>
