<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { DvColumnDef, DvConnection } from '@shared/types';
import { attempt, api, notify } from '../store';
import { BASE_TYPES } from './coltypes';
import DvTypePicker from './DvTypePicker.vue';
import { confirmProdWrite, isDoc, isSql, words } from './viewer';
import DvColumnExtras from './DvColumnExtras.vue';
import type { DvCharsets } from '@shared/types';

/** Create a table (columns with type / null / default / primary / auto) — or just a named collection / index for document engines. */
const props = defineProps<{ conn: DvConnection; db: string; initialName?: string }>();
const emit = defineEmits<{ done: [name: string]; cancel: [] }>();
const W = words(props.conn.engine);
const sql = isSql(props.conn.engine);
const name = ref(props.initialName ?? '');
const busy = ref(false);
const idType = props.conn.engine === 'postgresql' ? 'bigint' : props.conn.engine === 'sqlite' ? 'INTEGER' : 'BIGINT';
const firstType = BASE_TYPES[props.conn.engine][0]?.name ?? '';
const col = (over: Partial<DvColumnDef> = {}): DvColumnDef => ({ name: '', type: firstType, nullable: true, default: '', primary: false, autoIncrement: false, ...over });
const columns = ref<DvColumnDef[]>([]);
// Stable keys per column row, so removing one does not reuse another row's editors.
const rowKeys = new WeakMap<DvColumnDef, number>();
let rowSeq = 0;
const keyOf = (c: DvColumnDef) => rowKeys.get(c) ?? (rowKeys.set(c, ++rowSeq), rowSeq);
const sets = ref<DvCharsets>({ charsets: [], collations: [] });
const open = ref<Set<number>>(new Set());
const toggleMore = (k: number) => {
  const s = new Set(open.value);
  s.has(k) ? s.delete(k) : s.add(k);
  open.value = s;
};
onMounted(async () => {
  if (sql) sets.value = (await api.dvCharsets(props.conn.id).catch(() => null)) ?? sets.value;
  if (sql) columns.value = [col({ name: 'id', type: idType, nullable: false, primary: true, autoIncrement: true }), col({ name: 'name', type: props.conn.engine === 'postgresql' ? 'varchar(255)' : 'VARCHAR(255)', nullable: false })];
  else if (props.conn.engine === 'elasticsearch') columns.value = [];
});
function addTimestamps() {
  const ts = props.conn.engine === 'postgresql' ? 'timestamp' : props.conn.engine === 'sqlite' ? 'TEXT' : 'TIMESTAMP';
  columns.value.push(col({ name: 'created_at', type: ts }), col({ name: 'updated_at', type: ts }));
}
async function submit() {
  if (!(await confirmProdWrite(props.conn, `Create ${W.table}`, `CREATE TABLE ${name.value.trim()} (${columns.value.length} columns)`))) return;
  busy.value = true;
  const ok = await attempt(() => api.dvCreateTable(props.conn.id, props.db, name.value.trim(), JSON.parse(JSON.stringify(columns.value))).then(() => true));
  busy.value = false;
  if (!ok) return;
  notify('success', `${name.value.trim()} created`);
  emit('done', name.value.trim());
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <form class="modal-box w-[44rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <h3 class="text-lg font-semibold tracking-tight">Create {{ W.table }} in {{ db }}</h3>
      <label class="block">
        <span class="label-caps mb-1 block">Name</span>
        <input v-model="name" class="input input-sm w-full font-mono" placeholder="e.g. orders" required spellcheck="false" autocomplete="off" pattern="[A-Za-z_][A-Za-z0-9_]*" />
      </label>
      <template v-if="sql || conn.engine === 'elasticsearch'">
        <div class="rounded-box border border-base-300/60">
          <table class="table table-xs">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th class="text-center">Null</th>
                <th>Default</th>
                <th v-if="sql" class="text-center" title="Primary key">PK</th>
                <th v-if="sql" class="text-center" title="Auto increment">Auto</th>
                <th v-if="sql" class="text-center" title="Unique: no two rows hold the same value">UQ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <template v-for="(c, i) in columns" :key="keyOf(c)">
              <tr>
                <td><input v-model="c.name" class="input input-xs w-full font-mono" required spellcheck="false" pattern="[A-Za-z_][A-Za-z0-9_]*" /></td>
                <td class="min-w-56"><DvTypePicker v-model="c.type" :engine="conn.engine" compact /></td>
                <td class="text-center"><input v-model="c.nullable" type="checkbox" class="checkbox checkbox-xs" :disabled="c.primary" /></td>
                <td><input v-model="c.default" class="input input-xs w-full font-mono" placeholder="none" spellcheck="false" /></td>
                <td v-if="sql" class="text-center"><input v-model="c.primary" type="checkbox" class="checkbox checkbox-xs" @change="c.primary && (c.nullable = false)" /></td>
                <td v-if="sql" class="text-center"><input v-model="c.autoIncrement" type="checkbox" class="checkbox checkbox-xs" /></td>
                <td v-if="sql" class="text-center"><input v-model="c.unique" type="checkbox" class="checkbox checkbox-xs" :disabled="c.primary" :title="c.primary ? 'The primary key is unique already' : 'Unique'" /></td>
                <td class="text-right whitespace-nowrap"><button v-if="sql" type="button" class="btn btn-ghost btn-xs" :class="{ 'btn-active': open.has(keyOf(c)) }" title="Character set, collation, comment" @click="toggleMore(keyOf(c))">⋯</button><button type="button" class="btn btn-ghost btn-xs" title="Remove" @click="columns.splice(i, 1)">✕</button></td>
              </tr>
              <tr v-if="open.has(keyOf(c))" class="bg-base-200/40"><td :colspan="sql ? 8 : 5" class="!py-2"><DvColumnExtras :column="c" :engine="conn.engine" :sets="sets" compact /></td></tr>
              </template>
            </tbody>
          </table>
          <div class="flex gap-2 border-t border-base-300/60 p-2">
            <button type="button" class="btn btn-ghost btn-xs" @click="columns.push(col())">+ Column</button>
            <button v-if="sql" type="button" class="btn btn-ghost btn-xs" @click="addTimestamps">+ Timestamps</button>
          </div>
        </div>
        <p class="text-xs opacity-60">{{ conn.engine === 'elasticsearch' ? 'Fields become the index mapping; leave the list empty for dynamic mapping.' : 'Pick a type, then its length, precision or values; the server gets e.g. VARCHAR(255) or ENUM(…).' }}</p>
      </template>
      <p v-else-if="isDoc(conn.engine)" class="text-xs opacity-60">A collection has no fixed columns: fields come with the documents you insert.</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !name.trim()"><span v-if="busy" class="loading loading-spinner loading-xs" />Create</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
