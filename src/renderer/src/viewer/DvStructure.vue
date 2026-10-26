<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DvAlterOp, DvCharsets, DvColumn, DvColumnDef, DvConnection, DvGridPrefs, DvRisk, DvStructure } from '@shared/types';
import DvRiskDialog from './DvRiskDialog.vue';
import DvColumnExtras from './DvColumnExtras.vue';
import { attempt, api, notify } from '../store';
import DvTypePicker from './DvTypePicker.vue';
import { BASE_TYPES } from './coltypes';
import { isSql, logActivity, words } from './viewer';
import CatMood from './CatMood.vue';

/** Columns, indexes, foreign keys and the CREATE statement, with add / change / drop column and add / drop index. */
const props = defineProps<{ conn: DvConnection; db: string; table: string }>();
const emit = defineEmits<{ changed: [] }>();
const W = words(props.conn.engine);
const sql = isSql(props.conn.engine);
const st = ref<DvStructure | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
type Dialog = { kind: 'column'; mode: 'add' | 'modify'; column: DvColumnDef; original?: string } | { kind: 'index'; name: string; columns: string[]; unique: boolean } | { kind: 'dropColumn'; name: string } | { kind: 'dropIndex'; name: string };
const dialog = ref<Dialog | null>(null);

async function load() {
  error.value = null;
  try {
    st.value = await api.dvStructure(props.conn.id, props.db, props.table);
  } catch (e) {
    error.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}
onMounted(load);

/** Columns with a one-column UNIQUE index (not the primary key) → that index's name. */
const uniqueIndex = computed(() => new Map((st.value?.indexes ?? []).filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => [i.columns[0], i.name])));
const fkCols = computed(() => new Set((st.value?.foreignKeys ?? []).flatMap((f) => f.columns)));

// ---- column order: the same per-table order as the Data tab (display only; the table is not changed)
const order = ref<string[]>([]);
onMounted(async () => {
  order.value = (await api.dvGridPrefs(props.conn.id, props.db, props.table).catch(() => null))?.order ?? [];
});
const columns = computed(() => {
  const list = st.value?.columns ?? [];
  const pos = new Map(order.value.map((c, i) => [c, i]));
  return list.map((c, i) => ({ c, i })).sort((a, b) => (pos.get(a.c.name) ?? 1e6 + a.i) - (pos.get(b.c.name) ?? 1e6 + b.i)).map((x) => x.c);
});
async function saveOrder(next: string[]) {
  order.value = next;
  // Read the latest prefs first so widths and saved filters set in the Data tab are kept.
  const cur: DvGridPrefs = (await api.dvGridPrefs(props.conn.id, props.db, props.table).catch(() => null)) ?? { widths: {}, order: [], filters: [] };
  await attempt(() => api.dvSetGridPrefs(props.conn.id, props.db, props.table, { ...cur, order: next }));
}
const dragCol = ref<string | null>(null);
const dropAt = ref<{ col: string; after: boolean } | null>(null);
function onDragStart(name: string, e: DragEvent) {
  dragCol.value = name;
  e.dataTransfer?.setData('text/plain', name);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(name: string, e: DragEvent) {
  if (!dragCol.value) return;
  e.preventDefault();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropAt.value = name === dragCol.value ? null : { col: name, after: e.clientY > r.top + r.height / 2 };
}
function onDrop() {
  const from = dragCol.value;
  const at = dropAt.value;
  dragCol.value = null;
  dropAt.value = null;
  if (!from || !at) return;
  const names = columns.value.map((c) => c.name).filter((n) => n !== from);
  names.splice(names.indexOf(at.col) + (at.after ? 1 : 0), 0, from);
  void saveOrder(names);
}
function onDragEnd() {
  dragCol.value = null;
  dropAt.value = null;
}
const toDef = (c: DvColumn): DvColumnDef => ({ name: c.name, type: c.type, nullable: c.nullable, default: c.default ?? '', primary: c.key, autoIncrement: c.autoIncrement, unique: uniqueIndex.value.has(c.name), charset: c.charset ?? '', collation: c.collation ?? '', comment: c.comment ?? '' });
/** Character sets / collations of the server (for the column dialog). */
const sets = ref<DvCharsets>({ charsets: [], collations: [] });
onMounted(async () => {
  if (sql) sets.value = (await api.dvCharsets(props.conn.id).catch(() => null)) ?? sets.value;
});
const readOnly = computed(() => props.conn.options?.mode === 'readonly');
/** A change waiting on the risk dialog. */
const pendingRisk = ref<{ risk: DvRisk; ops: DvAlterOp[]; done: string; title: string; action: string } | null>(null);
function addColumn() {
  dialog.value = { kind: 'column', mode: 'add', column: { name: '', type: BASE_TYPES[props.conn.engine][0]?.name ?? '', nullable: true, default: '', primary: false, autoIncrement: false } };
}
function modifyColumn(c: DvColumn) {
  dialog.value = { kind: 'column', mode: 'modify', column: toDef(c), original: c.name };
}
/** Checks the change first (primary key, foreign keys, data that would not fit …); asks when there is anything to say. */
async function apply(ops: DvAlterOp[], done: string, action = 'Apply change') {
  if (readOnly.value) return notify('error', 'This connection is read-only');
  busy.value = true;
  const risk = await attempt(() => api.dvAlterCheck(props.conn.id, props.db, props.table, JSON.parse(JSON.stringify(ops))));
  busy.value = false;
  if (!risk) return;
  if (risk.level === 'none' && props.conn.options?.mode !== 'production') return run(ops, done, '');
  pendingRisk.value = { risk: risk.level === 'none' ? { ...risk, level: 'warn', items: [{ level: 'warn', title: 'Production connection', detail: `${props.conn.name} is marked Production: this changes the live database.` }] } : risk, ops, done, title: `${action}?`, action };
}
async function run(ops: DvAlterOp[], done: string, confirm: string) {
  busy.value = true;
  const t0 = Date.now();
  const ok = await attempt(() => api.dvAlterTable(props.conn.id, props.db, props.table, JSON.parse(JSON.stringify(ops)), confirm).then(() => true));
  busy.value = false;
  pendingRisk.value = null;
  logActivity(props.conn.id, { text: `[${props.db}] ALTER ${props.table}: ${ops.map((o) => o.op + ('name' in o ? ` ${o.name}` : 'column' in o ? ` ${o.column.name} ${o.column.type}` : 'to' in o ? ` → ${o.to}` : '')).join(', ')}`, ms: Date.now() - t0, affected: null, error: ok ? null : 'failed' });
  if (!ok) return;
  dialog.value = null;
  notify('success', done);
  await load();
  emit('changed');
}
function submitColumn() {
  const d = dialog.value as Extract<Dialog, { kind: 'column' }>;
  const ops: DvAlterOp[] = [];
  if (d.mode === 'add') ops.push({ op: 'addColumn', column: d.column });
  else {
    const before = st.value?.columns.find((c) => c.name === d.original);
    if (d.original && d.original !== d.column.name) ops.push({ op: 'renameColumn', from: d.original, to: d.column.name });
    // Only a real column change becomes MODIFY (Unique alone is an index).
    const def = before ? toDef(before) : null;
    if (!def || def.type !== d.column.type || def.nullable !== d.column.nullable || def.default !== d.column.default || def.autoIncrement !== d.column.autoIncrement || (def.charset ?? '') !== (d.column.charset ?? '') || (def.collation ?? '') !== (d.column.collation ?? '') || (def.comment ?? '') !== (d.column.comment ?? '')) ops.push({ op: 'modifyColumn', column: d.column });
    const had = uniqueIndex.value.get(d.original ?? d.column.name);
    if (d.column.unique && !had && !d.column.primary) ops.push({ op: 'addIndex', name: `${props.table}_${d.column.name}_unique`, columns: [d.column.name], unique: true });
    if (!d.column.unique && had) ops.push({ op: 'dropIndex', name: had });
    if (!ops.length) return void (dialog.value = null);
  }
  void apply(ops, `${d.column.name} ${d.mode === 'add' ? 'added' : 'changed'}`, d.mode === 'add' ? 'Add column' : 'Change column');
}
function submitIndex() {
  const d = dialog.value as Extract<Dialog, { kind: 'index' }>;
  const columns = d.columns.filter(Boolean);
  if (!columns.length) return notify('error', 'Pick at least one column');
  void apply([{ op: 'addIndex', name: d.name || `${props.table}_${columns.join('_')}_${d.unique ? 'unique' : 'index'}`, columns, unique: d.unique }], 'Index added');
}
async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  notify('success', 'Copied');
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div v-if="error" class="m-4 alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span class="font-mono text-xs">{{ error }}</span></div>
    <div v-else-if="!st" class="grid h-full place-items-center opacity-60"><span class="loading loading-spinner" /></div>
    <div v-else class="mx-auto max-w-5xl space-y-6 p-6">
      <!-- Columns -->
      <section class="card">
        <div class="card-body card-table">
          <div class="card-head">
            <h2>{{ conn.engine === 'mongodb' ? 'Fields (from a sample of documents)' : conn.engine === 'elasticsearch' ? 'Mapping' : 'Columns' }}</h2>
            <span class="badge badge-ghost badge-sm">{{ st.columns.length }}</span>
            <span class="flex-1" />
            <button v-if="order.length" class="btn btn-ghost btn-sm" title="Show the columns in the table's own order again (here and in the Data tab)" @click="saveOrder([])">Reset order</button>
            <button v-if="sql" class="btn btn-sm" :disabled="readOnly" @click="addColumn">+ Column</button>
          </div>
          <table class="table table-sm">
            <thead>
              <tr>
                <th class="w-6 !px-0" />
                <th>Name</th>
                <th>Type</th>
                <th>Null</th>
                <th>Default</th>
                <th>Extra</th>
                <th v-if="sql" />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in columns"
                :key="c.name"
                class="group dv-struct-row"
                :class="{ 'is-dragging': dragCol === c.name, 'is-drop-before': dropAt?.col === c.name && !dropAt.after, 'is-drop-after': dropAt?.col === c.name && dropAt.after }"
                draggable="true"
                @dragstart="onDragStart(c.name, $event)"
                @dragover="onDragOver(c.name, $event)"
                @drop.prevent="onDrop"
                @dragend="onDragEnd"
              >
                <td class="!px-0 text-center"><span class="dv-grip" title="Drag to change the column order (shown in the Data tab too; the table itself is not changed)">⠿</span></td>
                <td class="font-mono text-xs">
                  <span class="flex items-center gap-1.5">
                    {{ c.name }}
                    <span v-if="c.key" class="dv-key-tag is-pk" title="Primary key">PK</span>
                    <span v-if="uniqueIndex.has(c.name)" class="dv-key-tag is-uq" :title="`Unique (${uniqueIndex.get(c.name)})`">UQ</span>
                    <span v-if="fkCols.has(c.name)" class="dv-key-tag is-fk" title="Foreign key">FK</span>
                  </span>
                </td>
                <td class="font-mono text-xs opacity-80">{{ c.type }}</td>
                <td class="text-xs">{{ c.nullable ? 'yes' : '—' }}</td>
                <td class="max-w-48 truncate font-mono text-xs opacity-70" :title="c.default ?? ''">{{ c.default ?? '' }}</td>
                <td class="text-xs opacity-70">{{ [c.autoIncrement ? 'auto increment' : '', c.extra && !/auto_increment/i.test(c.extra) ? c.extra : '', c.collation ?? '', c.comment ? `“${c.comment}”` : ''].filter(Boolean).join(' · ') }}</td>
                <td v-if="sql" class="text-right whitespace-nowrap">
                  <span class="invisible group-hover:visible">
                    <button class="btn btn-ghost btn-xs" :disabled="conn.engine === 'sqlite'" :title="conn.engine === 'sqlite' ? 'SQLite cannot change a column' : 'Change'" @click="modifyColumn(c)">Change</button>
                    <button class="btn btn-ghost btn-xs text-error" :disabled="readOnly" @click="apply([{ op: 'dropColumn', name: c.name }], 'Column dropped', 'Drop column')">Drop</button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="px-4 pt-2 pb-1 text-[11px] opacity-50">Drag a row by ⠿ to set the order columns are shown in, here and in the Data tab. It is a view setting: the table is not altered.</p>
        </div>
      </section>

      <!-- Indexes -->
      <section v-if="sql || conn.engine === 'mongodb'" class="card">
        <div class="card-body card-table">
          <div class="card-head">
            <h2>Indexes</h2>
            <span class="badge badge-ghost badge-sm">{{ st.indexes.length }}</span>
            <span class="flex-1" />
            <button class="btn btn-sm" :disabled="readOnly" @click="dialog = { kind: 'index', name: '', columns: [st.columns[0]?.name ?? ''], unique: false }">+ Index</button>
          </div>
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Kind</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in st.indexes" :key="i.name" class="group">
                <td class="font-mono text-xs">{{ i.name }}</td>
                <td class="font-mono text-xs opacity-80">{{ i.columns.join(', ') }}</td>
                <td class="text-xs">{{ i.primary ? 'primary' : i.unique ? 'unique' : 'index' }}</td>
                <td class="text-right"><button class="btn btn-ghost btn-xs invisible text-error group-hover:visible" :disabled="readOnly" @click="apply([{ op: 'dropIndex', name: i.name }], 'Index dropped', i.primary ? 'Drop primary key' : 'Drop index')">Drop</button></td>
              </tr>
              <tr v-if="!st.indexes.length"><td colspan="4" class="py-4 text-center text-xs opacity-50">No indexes.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Foreign keys -->
      <section v-if="sql" class="card">
        <div class="card-body card-table">
          <div class="card-head"><h2>Foreign keys</h2><span class="badge badge-ghost badge-sm">{{ st.foreignKeys.length }}</span></div>
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>References</th>
                <th>On delete</th>
                <th>On update</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in st.foreignKeys" :key="f.name">
                <td class="font-mono text-xs">{{ f.name }}</td>
                <td class="font-mono text-xs opacity-80">{{ f.columns.join(', ') }}</td>
                <td class="font-mono text-xs">{{ f.refTable }} ({{ f.refColumns.join(', ') }})</td>
                <td class="text-xs opacity-70">{{ f.onDelete ?? '' }}</td>
                <td class="text-xs opacity-70">{{ f.onUpdate ?? '' }}</td>
              </tr>
              <tr v-if="!st.foreignKeys.length"><td colspan="5" class="py-4 text-center text-xs opacity-50">No foreign keys.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- DDL -->
      <section class="card">
        <div class="card-body">
          <div class="flex items-center gap-2">
            <h2>{{ sql ? 'CREATE statement' : 'Definition' }}</h2>
            <span class="flex-1" />
            <button class="btn btn-ghost btn-sm" @click="copy(st.ddl)">Copy</button>
          </div>
          <pre class="selectable max-h-96 overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-xs leading-relaxed whitespace-pre">{{ st.ddl }}</pre>
        </div>
      </section>
    </div>

    <!-- Column dialog -->
    <dialog v-if="dialog?.kind === 'column'" open class="modal modal-open" @keydown.esc="!busy && (dialog = null)">
      <form class="modal-box w-[30rem] max-w-[95vw] space-y-4" @submit.prevent="submitColumn">
        <h3 class="text-lg font-semibold tracking-tight">{{ dialog.mode === 'add' ? 'Add column' : `Change ${dialog.original}` }}</h3>
        <fieldset class="grid grid-cols-2 gap-3">
          <label class="block"><span class="label-caps mb-1 block">Name</span><input v-model="dialog.column.name" class="input input-sm w-full font-mono" required spellcheck="false" pattern="[A-Za-z_][A-Za-z0-9_]*" /></label>
          <div class="block"><span class="label-caps mb-1 block">Type</span><DvTypePicker v-model="dialog.column.type" :engine="conn.engine" /></div>
          <label class="col-span-2 block"><span class="label-caps mb-1 block">Default <span class="normal-case opacity-60">(empty = none; expressions like CURRENT_TIMESTAMP work)</span></span><input v-model="dialog.column.default" class="input input-sm w-full font-mono" spellcheck="false" /></label>
          <label class="flex cursor-pointer items-center gap-2 text-sm"><input v-model="dialog.column.nullable" type="checkbox" class="checkbox checkbox-sm" />Allows NULL</label>
          <label v-if="dialog.mode === 'add'" class="flex cursor-pointer items-center gap-2 text-sm"><input v-model="dialog.column.autoIncrement" type="checkbox" class="checkbox checkbox-sm" />Auto increment</label>
          <div class="col-span-2"><DvColumnExtras :column="dialog.column" :engine="conn.engine" :sets="sets" /></div>
          <label class="flex cursor-pointer items-center gap-2 text-sm" :class="{ 'opacity-50': dialog.column.primary }" :title="dialog.column.primary ? 'A primary key is unique already' : 'No two rows may hold the same value (a UNIQUE index)'"><input v-model="dialog.column.unique" type="checkbox" class="checkbox checkbox-sm" :disabled="dialog.column.primary" />Unique</label>
        </fieldset>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="dialog = null">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ dialog.mode === 'add' ? 'Add' : 'Save' }}</button>
        </div>
      </form>
      <div class="modal-backdrop" @click="!busy && (dialog = null)" />
    </dialog>

    <!-- Index dialog -->
    <dialog v-if="dialog?.kind === 'index'" open class="modal modal-open" @keydown.esc="!busy && (dialog = null)">
      <form class="modal-box w-[28rem] max-w-[95vw] space-y-4" @submit.prevent="submitIndex">
        <h3 class="text-lg font-semibold tracking-tight">Add index</h3>
        <label class="block"><span class="label-caps mb-1 block">Name <span class="normal-case opacity-60">(optional)</span></span><input v-model="dialog.name" class="input input-sm w-full font-mono" spellcheck="false" /></label>
        <fieldset>
          <span class="label-caps mb-1 block">Columns (in order)</span>
          <div class="space-y-1.5">
            <div v-for="(_, i) in dialog.columns" :key="i" class="flex gap-1">
              <select v-model="dialog.columns[i]" class="select select-sm flex-1 font-mono text-xs"><option v-for="c in st?.columns ?? []" :key="c.name" :value="c.name">{{ c.name }}</option></select>
              <button v-if="dialog.columns.length > 1" type="button" class="btn btn-ghost btn-sm btn-square" @click="dialog.columns.splice(i, 1)">✕</button>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" @click="dialog.columns.push(st?.columns[0]?.name ?? '')">+ Column</button>
          </div>
        </fieldset>
        <label class="flex cursor-pointer items-center gap-2 text-sm"><input v-model="dialog.unique" type="checkbox" class="checkbox checkbox-sm" />Unique</label>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="dialog = null">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy"><span v-if="busy" class="loading loading-spinner loading-xs" />Add index</button>
        </div>
      </form>
      <div class="modal-backdrop" @click="!busy && (dialog = null)" />
    </dialog>

    <DvRiskDialog v-if="pendingRisk" :risk="pendingRisk.risk" :title="pendingRisk.title" :action="pendingRisk.action" :busy="busy" @ok="(w) => run(pendingRisk!.ops, pendingRisk!.done, w)" @cancel="pendingRisk = null" />
  </div>
</template>
