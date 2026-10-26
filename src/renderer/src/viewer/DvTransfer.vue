<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DvConnection, DvExportFormat, DvTable } from '@shared/types';
import { attempt, api } from '../store';
import { isDoc, isKv, isSql, isSystemDb, showJobs, words } from './viewer';

/**
 * Export (format + table selection), Import (format + target) and Backup
 * (databases → .tar.gz). The file dialog opens on Continue; progress is in Jobs.
 */
const props = defineProps<{ mode: 'export' | 'import' | 'backup'; conn: DvConnection; db: string; databases: string[]; tables: DvTable[]; preselected: string[]; initialFormat?: string; preselectedDbs?: string[] }>();
const emit = defineEmits<{ done: []; cancel: [] }>();
const e = props.conn.engine;
const W = words(e);
const busy = ref(false);

// ---- export
const FORMATS: { id: DvExportFormat; name: string; hint: string; for: (e: DvConnection['engine']) => boolean }[] = [
  { id: 'sql', name: 'SQL', hint: 'CREATE + INSERT statements', for: isSql },
  { id: 'csv', name: 'CSV', hint: 'One header row, then the rows', for: () => true },
  { id: 'json', name: 'JSON', hint: 'NDJSON, one object per line', for: () => true },
  { id: 'xml', name: 'XML', hint: '<database><table><row>…', for: () => true },
  { id: 'dot', name: 'DOT', hint: 'Graphviz diagram of tables and foreign keys', for: isSql },
  { id: 'redis', name: 'Redis script', hint: 'SET / RPUSH … lines for redis-cli', for: isKv },
];
const formats = computed(() => FORMATS.filter((f) => f.for(e)));
const format = ref<DvExportFormat>(isSql(e) ? 'sql' : isKv(e) ? 'redis' : 'json');
// Ask DBCatz may preset the format (only one this engine offers).
if (props.mode === 'export' && props.initialFormat && formats.value.some((f) => f.id === props.initialFormat)) format.value = props.initialFormat as DvExportFormat;
const selected = ref<Set<string>>(new Set(props.preselected));
const all = computed(() => selected.value.size === 0);
const pattern = ref('*');
const structure = ref(true);
const data = ref(true);
const dropFirst = ref(false);
const tableFilter = ref('');
const visible = computed(() => props.tables.filter((t) => !tableFilter.value || t.name.toLowerCase().includes(tableFilter.value.toLowerCase())));
function toggle(name: string) {
  const s = new Set(selected.value);
  s.has(name) ? s.delete(name) : s.add(name);
  selected.value = s;
}

// ---- import
type ImportFormat = 'sql' | 'csv' | 'json' | 'redis';
const importFormat = ref<ImportFormat>(isSql(e) ? 'sql' : isKv(e) ? 'redis' : 'json');
const importTable = ref(props.preselected[0] ?? '');
const header = ref(true);
const IMPORTS: { id: ImportFormat; name: string; hint: string; for: (e: DvConnection['engine']) => boolean }[] = [
  { id: 'sql', name: 'SQL file or backup', hint: '.sql, .sql.gz or a DBCatz .tar.gz backup', for: isSql },
  { id: 'csv', name: 'CSV into a table', hint: 'The header row names the columns', for: (x) => isSql(x) || isDoc(x) },
  { id: 'json', name: 'JSON / NDJSON', hint: `Documents into one ${W.table}`, for: isDoc },
  { id: 'redis', name: 'Redis script or backup', hint: 'redis-cli lines or a DBCatz .tar.gz backup', for: isKv },
];
const imports = computed(() => IMPORTS.filter((f) => f.for(e)));
if (props.mode === 'import' && props.initialFormat && imports.value.some((f) => f.id === props.initialFormat)) importFormat.value = props.initialFormat as ImportFormat;

// ---- backup
const backupDbs = ref<Set<string>>(new Set(props.preselectedDbs?.filter((d) => props.databases.includes(d)).length ? props.preselectedDbs.filter((d) => props.databases.includes(d)) : props.databases.filter((d) => !isSystemDb(e, d))));
const dbFilter = ref('');
const shownDbs = computed(() => props.databases.filter((d) => !dbFilter.value.trim() || d.toLowerCase().includes(dbFilter.value.trim().toLowerCase())));
function toggleDb(d: string) {
  const s = new Set(backupDbs.value);
  s.has(d) ? s.delete(d) : s.add(d);
  backupDbs.value = s;
}

async function go() {
  busy.value = true;
  let path: string | null | undefined;
  if (props.mode === 'export') path = await attempt(() => api.dvExport(props.conn.id, { database: props.db, tables: isKv(e) ? (pattern.value.trim() && pattern.value.trim() !== '*' ? [pattern.value.trim()] : []) : [...selected.value], format: format.value, structure: structure.value, data: data.value, dropFirst: dropFirst.value }));
  else if (props.mode === 'import') path = await attempt(() => api.dvImport(props.conn.id, { database: props.db, format: importFormat.value, table: importTable.value.trim(), header: header.value }));
  else path = await attempt(() => api.dvBackup(props.conn.id, [...backupDbs.value]));
  busy.value = false;
  if (path === undefined) return; // could not start: the toast says why, the dialog stays
  if (path === null) return; // cancelled in the file dialog
  // It runs on in the background: progress in Jobs, a toast when it ends.
  showJobs.value = true;
  emit('done');
}
const title = computed(() => (props.mode === 'export' ? `Export from ${props.db}` : props.mode === 'import' ? `Import into ${props.db}` : 'Backup as .tar.gz'));
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <form class="modal-box w-[40rem] max-w-[95vw] space-y-4" @submit.prevent="go">
      <h3 class="text-lg font-semibold tracking-tight">{{ title }}</h3>

      <!-- Export -->
      <template v-if="mode === 'export'">
        <fieldset>
          <span class="label-caps mb-2 block">Format</span>
          <div class="grid grid-cols-3 gap-2">
            <button v-for="f in formats" :key="f.id" type="button" class="dv-choice" :class="{ 'is-active': format === f.id }" @click="format = f.id">
              <span class="font-medium">{{ f.name }}</span><span class="block text-[11px] opacity-60">{{ f.hint }}</span>
            </button>
          </div>
        </fieldset>
        <fieldset v-if="isKv(e)">
          <span class="label-caps mb-1 block">Keys matching</span>
          <input v-model="pattern" class="input input-sm w-full font-mono" placeholder="*" spellcheck="false" />
        </fieldset>
        <fieldset v-else>
          <div class="mb-1.5 flex items-center gap-2">
            <span class="label-caps">{{ W.tables }}</span>
            <span class="text-xs opacity-60">{{ all ? `all ${tables.length}` : `${selected.size} of ${tables.length}` }}</span>
            <span class="flex-1" />
            <button type="button" class="btn btn-ghost btn-xs" @click="selected = new Set()">All</button>
            <button type="button" class="btn btn-ghost btn-xs" @click="selected = new Set(tables.map((t) => t.name))">Each</button>
            <input v-model="tableFilter" class="input input-xs w-36" placeholder="Filter" spellcheck="false" />
          </div>
          <div class="max-h-48 overflow-y-auto rounded-box border border-base-300/60 p-1.5">
            <label v-for="t in visible" :key="t.name" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-xs hover:bg-base-200">
              <input type="checkbox" class="checkbox checkbox-xs" :checked="all || selected.has(t.name)" @change="toggle(t.name)" />
              <span class="flex-1 truncate">{{ t.name }}</span>
              <span class="opacity-40">{{ t.type === 'view' ? 'view' : t.rows !== null ? `${t.rows} ${W.rows}` : '' }}</span>
            </label>
            <p v-if="!tables.length" class="px-2 py-3 text-center text-xs opacity-50">No {{ W.tables }} in {{ db }}.</p>
          </div>
          <p class="mt-1 text-[11px] opacity-50">With nothing ticked, every {{ W.table }} is exported; tick some to export only those.</p>
        </fieldset>
        <fieldset v-if="format === 'sql'" class="flex flex-wrap gap-4 text-sm">
          <label class="flex cursor-pointer items-center gap-2"><input v-model="structure" type="checkbox" class="checkbox checkbox-sm" />Structure (CREATE)</label>
          <label class="flex cursor-pointer items-center gap-2"><input v-model="data" type="checkbox" class="checkbox checkbox-sm" />Data (INSERT)</label>
          <label class="flex cursor-pointer items-center gap-2"><input v-model="dropFirst" type="checkbox" class="checkbox checkbox-sm" :disabled="!structure" />DROP IF EXISTS first</label>
        </fieldset>
      </template>

      <!-- Import -->
      <template v-else-if="mode === 'import'">
        <fieldset>
          <span class="label-caps mb-2 block">What to import</span>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="f in imports" :key="f.id" type="button" class="dv-choice" :class="{ 'is-active': importFormat === f.id }" @click="importFormat = f.id">
              <span class="font-medium">{{ f.name }}</span><span class="block text-[11px] opacity-60">{{ f.hint }}</span>
            </button>
          </div>
        </fieldset>
        <fieldset v-if="importFormat === 'csv' || importFormat === 'json'" class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">Into {{ W.table }}</span>
            <input v-model="importTable" class="input input-sm w-full font-mono" list="dv-import-tables" required spellcheck="false" :placeholder="isDoc(e) ? 'made when missing' : 'an existing table'" />
            <datalist id="dv-import-tables"><option v-for="t in tables" :key="t.name" :value="t.name" /></datalist>
          </label>
          <label v-if="importFormat === 'csv'" class="flex cursor-pointer items-center gap-2 self-end pb-1.5 text-sm"><input v-model="header" type="checkbox" class="checkbox checkbox-sm" />First row has column names</label>
        </fieldset>
        <p class="text-xs opacity-60">
          <template v-if="importFormat === 'sql'">Statements run one by one in {{ db }}; a DBCatz backup restores each database it holds (made when missing). Errors stop the import at that statement.</template>
          <template v-else-if="importFormat === 'redis'">Each line runs as a command in {{ db }}; a DBCatz backup restores every database it holds.</template>
          <template v-else>Rows are inserted one by one so a bad row names itself; empty cells become NULL where the column allows it.</template>
        </p>
      </template>

      <!-- Backup -->
      <template v-else>
        <fieldset>
          <div class="mb-1.5 flex items-center gap-2">
            <span class="label-caps">{{ W.dbs }} to include</span>
            <span class="text-[11px] opacity-50">{{ backupDbs.size }} of {{ databases.length }}</span>
            <span class="flex-1" />
            <button type="button" class="btn btn-ghost btn-xs" :title="dbFilter.trim() ? 'Add the ones listed' : ''" @click="backupDbs = new Set([...backupDbs, ...shownDbs])">All</button>
            <button type="button" class="btn btn-ghost btn-xs" :title="dbFilter.trim() ? 'Remove the ones listed' : ''" @click="backupDbs = new Set([...backupDbs].filter((d) => !shownDbs.includes(d)))">None</button>
          </div>
          <input v-if="databases.length > 8" v-model="dbFilter" class="input input-sm mb-1.5 w-full text-xs" :placeholder="`Search ${databases.length} ${W.dbs}`" spellcheck="false" />
          <div class="max-h-56 overflow-y-auto rounded-box border border-base-300/60 p-1.5">
            <p v-if="!shownDbs.length" class="px-2 py-1 text-xs opacity-50">No {{ W.db }} matches “{{ dbFilter.trim() }}”.</p>
            <label v-for="d in shownDbs" :key="d" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-xs hover:bg-base-200">
              <input type="checkbox" class="checkbox checkbox-xs" :checked="backupDbs.has(d)" @change="toggleDb(d)" />{{ d }}<span v-if="isSystemDb(e, d)" class="badge badge-ghost badge-xs font-sans">system</span>
            </label>
          </div>
        </fieldset>
        <p class="text-xs opacity-60">One {{ isSql(e) ? '.sql dump' : isKv(e) ? '.redis script' : '.ndjson file' }} per {{ W.db }} plus a small manifest, gzipped into one archive. Restore it with Import.</p>
      </template>

      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || (mode === 'backup' && !backupDbs.size) || (mode === 'export' && format === 'sql' && !structure && !data)"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ mode === 'import' ? 'Choose file…' : 'Save as…' }}</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
