<script setup lang="ts">
import { keyLabel } from '@shared/platform';
import { computed, onMounted, ref, watch } from 'vue';
import type { DvConnection, DvKey, DvKeyInput, DvKeyValue } from '@shared/types';
import { attempt, api, notify } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DvCodeEditor from './DvCodeEditor.vue';
import { prettyJson } from './highlight';
import { hasNested, phpPref, prettyHtml, setPhpPref, structured } from './pretty';
import { confirmProdWrite, fmtNum, fmtTtl, isReadOnly, logActivity } from './viewer';

/**
 * Redis / Valkey: the keys of one database (SCAN with a pattern) on the left,
 * the chosen key's value on the right (per type), with new / rename / TTL /
 * delete.
 */
const props = defineProps<{ conn: DvConnection; db: string }>();
const pattern = ref('*');
const draft = ref('*');
const keys = ref<DvKey[]>([]);
const total = ref(0);
const loading = ref(false);
const selected = ref<Set<string>>(new Set());
const open = ref<DvKeyValue | null>(null);
const openText = ref('');
const dirty = ref(false);
const busy = ref(false);
const confirm = ref<string[] | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
const creating = ref<DvKeyInput | null>(null);
const renaming = ref<string | null>(null);
const ttlEdit = ref<string | null>(null);
const LIMIT = 1000;
const readOnly = computed(() => isReadOnly(props.conn));
const guard = async (what: string, statement: string) => {
  if (readOnly.value) {
    notify('info', 'This connection is read-only');
    return false;
  }
  return confirmProdWrite(props.conn, what, statement);
};
/** JSON values: shown pretty with colours; 'raw' shows the text as stored. */
const view = ref<'pretty' | 'raw'>('pretty');
/** Formatted view: interpret PHP serialize() output (and show backslashes plainly). */
const php = ref(phpPref());
function togglePhp() {
  php.value = !php.value;
  setPhpPref(php.value);
  if (open.value) void show({ key: open.value.key } as DvKey);
}
/** A plain JSON string (no serialized strings inside): edited in the JSON editor. */
const isJsonString = computed(() => !!open.value && open.value.type === 'string' && isPlainJson(String(open.value.value)));
const isPlainJson = (text: string) => {
  const s = structured(text, php.value);
  return !!s && s.kind === 'json' && (!php.value || !hasNested(s.value));
};
/** PHP serialize() output, or JSON holding such strings: a read-only formatted view (Raw edits it). */
const stringPretty = computed(() => (open.value && open.value.type === 'string' && !isJsonString.value ? prettyHtml(String(open.value.value), php.value) : null));
/** Hash / list / set / zset elements that hold JSON, pretty-printed for the read view. */
const jsonElements = computed(() => {
  const v = open.value;
  if (!v || typeof v.value === 'string') return [];
  return (v.value as unknown[]).map((x) => {
    const [label, text] = Array.isArray(x) ? (x as [string, string]) : ['', String(x)];
    const p = prettyHtml(text, php.value);
    return { label, text, pretty: p ? p.kind : null, html: p?.html ?? null };
  });
});
/** The value is PHP serialize() output but the toggle is off: the header still shows, so it can be turned on. */
const couldBePhp = computed(() => !php.value && !!open.value && prettyHtml(toText(open.value), true)?.kind === 'php');
const hasJsonElements = computed(() => jsonElements.value.some((x) => x.pretty));
const jsonError = computed(() => {
  if (!open.value || open.value.type !== 'string' || view.value !== 'pretty' || !isJsonString.value) return null;
  try {
    JSON.parse(openText.value);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
});
/** Ask DBCatz's open-keys: list the keys matching a pattern. */
function setPattern(p: string) {
  pattern.value = p || '*';
  void load();
}
defineExpose({ startNew, deleteSelected, focusFilter, reload: load, setPattern });

async function load() {
  loading.value = true;
  const r = await attempt(() => api.dvKeys(props.conn.id, props.db, pattern.value, LIMIT));
  loading.value = false;
  if (!r) return;
  keys.value = r.keys;
  total.value = r.total;
  if (open.value && !keys.value.some((k) => k.key === open.value!.key)) open.value = null;
}
onMounted(load);
watch(pattern, load);
function focusFilter() {
  filterInput.value?.focus();
  filterInput.value?.select();
}

async function show(k: DvKey) {
  if (dirty.value && !window.confirm('Discard the unsaved value?')) return;
  const v = await attempt(() => api.dvKey(props.conn.id, props.db, k.key));
  if (!v) return;
  open.value = v;
  openText.value = toText(v);
  if (v.type === 'string') {
    const plain = isPlainJson(String(v.value));
    view.value = plain || prettyHtml(String(v.value), php.value) ? 'pretty' : 'raw';
    if (plain) openText.value = prettyJson(String(v.value)) ?? openText.value;
  } else view.value = hasJsonElementsOf(v) ? 'pretty' : 'raw';
  dirty.value = false;
  renaming.value = null;
  ttlEdit.value = null;
}
const hasJsonElementsOf = (v: DvKeyValue) => typeof v.value !== 'string' && (v.value as unknown[]).some((x) => structured(Array.isArray(x) ? String(x[1]) : String(x), php.value) !== null);
const toText = (v: DvKeyValue): string => (typeof v.value === 'string' ? v.value : (v.value as unknown[]).map((x) => (Array.isArray(x) ? `${x[0]}\t${x[1]}` : String(x))).join('\n'));
const fromText = (type: string, text: string): DvKeyInput['value'] => {
  if (type === 'string') return text;
  const lines = text.split('\n').filter((l) => l.length);
  if (type === 'hash' || type === 'zset') return lines.map((l) => { const i = l.indexOf('\t'); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; }) as [string, string][];
  return lines;
};
const editableType = (t: string) => ['string', 'list', 'set', 'hash', 'zset'].includes(t);
const hint = computed(() => {
  const t = open.value?.type ?? creating.value?.type;
  return t === 'hash' ? 'One field per line: field ⇥ value (tab between)' : t === 'zset' ? 'One member per line: member ⇥ score' : t === 'list' ? 'One element per line, in order' : t === 'set' ? 'One member per line' : '';
});

function switchView(to: 'pretty' | 'raw') {
  if (view.value === to) return;
  if (open.value?.type === 'string' && isJsonString.value) {
    if (to === 'pretty') openText.value = prettyJson(openText.value) ?? openText.value;
    else {
      try {
        openText.value = JSON.stringify(JSON.parse(openText.value));
      } catch {
        /* keep as typed */
      }
    }
  }
  view.value = to;
}
async function save() {
  const v = open.value!;
  if (!(await guard('Save key', `SET ${v.key}`))) return;
  if (v.type === 'string' && isJsonString.value && view.value === 'pretty') {
    try {
      JSON.parse(openText.value);
    } catch (e) {
      return notify('error', `Not valid JSON: ${(e as Error).message}`);
    }
  }
  busy.value = true;
  const text = v.type === 'string' && isJsonString.value && view.value === 'pretty' ? JSON.stringify(JSON.parse(openText.value)) : openText.value;
  const ok = await attempt(() => api.dvKeySet(props.conn.id, props.db, { key: v.key, type: v.type as DvKeyInput['type'], value: fromText(v.type, text), ttl: v.ttl >= 0 ? v.ttl : null }).then(() => true));
  busy.value = false;
  logActivity(props.conn.id, { text: `[${props.db}] SET ${v.key} (${v.type})`, ms: null, affected: ok ? 1 : 0, error: ok ? null : 'failed' });
  if (!ok) return;
  dirty.value = false;
  notify('success', `${v.key} saved`);
  await load();
  await show({ key: v.key } as DvKey);
}
function closePanel() {
  if (dirty.value && !window.confirm('Discard the unsaved value?')) return;
  open.value = null;
  creating.value = null;
  dirty.value = false;
}
function startNew() {
  if (readOnly.value) return notify('info', 'This connection is read-only');
  creating.value = { key: '', type: 'string', value: '', ttl: null };
  open.value = null;
}
const newText = ref('');
const newTtl = ref('');
async function create() {
  const c = creating.value!;
  if (!(await guard('Create key', `SET ${c.key}`))) return;
  if (!c.key.trim()) return notify('error', 'A key needs a name');
  busy.value = true;
  const ok = await attempt(() => api.dvKeySet(props.conn.id, props.db, { ...c, key: c.key.trim(), value: fromText(c.type, newText.value), ttl: newTtl.value ? Number(newTtl.value) : null }).then(() => true));
  busy.value = false;
  logActivity(props.conn.id, { text: `[${props.db}] NEW ${c.key.trim()} (${c.type})`, ms: null, affected: ok ? 1 : 0, error: ok ? null : 'failed' });
  if (!ok) return;
  notify('success', `${c.key} created`);
  const key = c.key.trim();
  creating.value = null;
  newText.value = '';
  newTtl.value = '';
  await load();
  await show({ key } as DvKey);
}
async function rename(to: string) {
  if (!to.trim() || to === open.value!.key) return void (renaming.value = null);
  if (!(await guard('Rename key', `RENAME ${open.value!.key} ${to.trim()}`))) return;
  busy.value = true;
  const ok = await attempt(() => api.dvKeyRename(props.conn.id, props.db, open.value!.key, to.trim()).then(() => true));
  busy.value = false;
  logActivity(props.conn.id, { text: `[${props.db}] RENAME ${open.value!.key} → ${to.trim()}`, ms: null, affected: ok ? 1 : 0, error: ok ? null : 'failed' });
  if (!ok) return;
  renaming.value = null;
  await load();
  await show({ key: to.trim() } as DvKey);
}
async function setTtl(s: string) {
  const v = open.value!;
  if (!(await guard('Change TTL', `EXPIRE ${v.key} ${s || '(none)'}`))) return;
  const ttl = s.trim() === '' || s.trim() === '-1' ? null : Number(s);
  busy.value = true;
  const ok = await attempt(() => api.dvKeySet(props.conn.id, props.db, { key: v.key, type: v.type as DvKeyInput['type'], value: fromText(v.type, openText.value), ttl }).then(() => true));
  busy.value = false;
  if (!ok) return;
  ttlEdit.value = null;
  await show({ key: v.key } as DvKey);
}
function toggle(k: string, e: MouseEvent) {
  const s = new Set(e.metaKey || e.ctrlKey ? selected.value : []);
  s.has(k) && (e.metaKey || e.ctrlKey) ? s.delete(k) : s.add(k);
  selected.value = s;
}
function deleteSelected() {
  const list = selected.value.size ? [...selected.value] : open.value ? [open.value.key] : [];
  if (!list.length) return notify('info', 'Pick a key first');
  confirm.value = list;
}
async function doDelete() {
  if (!(await guard(`Delete ${confirm.value!.length} key${confirm.value!.length === 1 ? '' : 's'}`, `DEL ${confirm.value!.join(' ')}`))) return void (confirm.value = null);
  busy.value = true;
  const n = await attempt(() => api.dvKeyDelete(props.conn.id, props.db, confirm.value!));
  busy.value = false;
  logActivity(props.conn.id, { text: `[${props.db}] DEL ${confirm.value!.join(' ')}`, ms: null, affected: n ?? 0, error: n === undefined ? 'failed' : null });
  confirm.value = null;
  if (n === undefined) return;
  notify('success', `${n} key${n === 1 ? '' : 's'} deleted`);
  selected.value = new Set();
  open.value = null;
  await load();
}
const TYPE_COLOR: Record<string, string> = { string: 'badge-info', list: 'badge-success', set: 'badge-warning', zset: 'badge-secondary', hash: 'badge-primary', stream: 'badge-accent' };
</script>

<template>
  <div class="flex h-full">
    <!-- Key list (full width; a key's value opens in a drawer on the right) -->
    <div class="flex min-w-0 flex-1 flex-col">
      <form class="flex shrink-0 items-center gap-2 border-b border-base-300/60 px-3 py-2" @submit.prevent="pattern = draft.trim() || '*'">
        <label class="input input-sm flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
          <span class="font-sans text-[11px] font-semibold tracking-wide uppercase opacity-50">Match</span>
          <input ref="filterInput" v-model="draft" class="grow" placeholder="*" spellcheck="false" />
        </label>
        <button class="btn btn-sm">Scan</button>
        <button type="button" class="btn btn-sm" :title="`New key (${keyLabel('mod+shift+I')})`" @click="startNew">+ Key</button>
        <button type="button" class="btn btn-sm" :class="{ 'btn-error btn-soft': selected.size }" :disabled="!selected.size && !open" :title="`Delete (${keyLabel('mod+⌫')})`" @click="deleteSelected">Delete{{ selected.size ? ` ${selected.size}` : '' }}</button>
      </form>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="loading && !keys.length" class="grid h-full place-items-center opacity-60"><span class="loading loading-spinner" /></div>
        <p v-else-if="!keys.length" class="p-6 text-center text-xs opacity-50">{{ pattern === '*' ? 'No keys in this database yet. Add one with + Key.' : `No keys match ${pattern}.` }}</p>
        <table v-else class="dv-grid">
          <thead><tr><th>Key</th><th class="w-16">Type</th><th class="w-20 text-right">Size</th><th class="w-24 text-right">TTL</th></tr></thead>
          <tbody>
            <tr v-for="k in keys" :key="k.key" class="cursor-default" :class="{ 'is-selected': selected.has(k.key), 'is-open': open?.key === k.key }" @click="toggle(k.key, $event); show(k)">
              <td class="truncate">{{ k.key }}</td>
              <td><span class="badge badge-soft badge-xs" :class="TYPE_COLOR[k.type] ?? 'badge-ghost'">{{ k.type }}</span></td>
              <td class="text-right tabular-nums opacity-70">{{ fmtNum(k.size) }}</td>
              <td class="text-right tabular-nums opacity-70">{{ k.ttl < 0 ? '∞' : fmtTtl(k.ttl) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex h-8 shrink-0 items-center gap-2 border-t border-base-300/60 px-3 text-[11px] opacity-70">
        <span>{{ fmtNum(keys.length) }}{{ total > keys.length ? ` of ${fmtNum(total)} (narrow the pattern to see the rest)` : '' }} keys</span>
        <span class="flex-1" /><span>click a key to open its value · {{ keyLabel('mod') }}-click selects several</span>
      </div>
    </div>

    <!-- Value: a panel sliding in from the right, like a request in Expose -->
    <Teleport to="body">
      <div v-if="creating || open" class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" @click="closePanel" />
      <aside v-if="creating || open" class="no-drag fixed top-0 right-0 bottom-0 z-50 flex w-[44rem] max-w-[92vw] flex-col border-l border-base-300/60 bg-base-100 shadow-2xl" @keydown.esc.stop="closePanel">
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-base-300/60 px-3 text-xs">
        <button class="btn btn-ghost btn-xs gap-1" title="Close (Esc)" @click="closePanel">✕ Close</button>
        <span class="opacity-50">{{ creating ? 'New key' : `Key in ${db}` }}</span>
        <span class="flex-1" />
        <span v-if="dirty" class="badge badge-warning badge-soft badge-xs">unsaved</span>
      </div>
      <!-- new key -->
      <template v-if="creating">
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-base-300/60 px-4 py-2">
          <input v-model="creating.key" class="input input-sm min-w-48 flex-1 font-mono" placeholder="key name, e.g. user:42" spellcheck="false" />
          <select v-model="creating.type" class="select select-sm w-28"><option v-for="t in ['string', 'hash', 'list', 'set', 'zset']" :key="t" :value="t">{{ t }}</option></select>
          <input v-model="newTtl" class="input input-sm w-28 font-mono" placeholder="TTL s (none)" inputmode="numeric" />
        </div>
        <textarea v-model="newText" class="dv-editor flex-1" :placeholder="hint || 'value'" spellcheck="false" />
        <div class="flex h-10 shrink-0 items-center gap-2 border-t border-base-300/60 px-4 text-xs">
          <span class="opacity-60">{{ hint }}</span><span class="flex-1" />
          <button class="btn btn-ghost btn-sm" :disabled="busy" @click="creating = null">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy" @click="create"><span v-if="busy" class="loading loading-spinner loading-xs" />Create key</button>
        </div>
      </template>
      <!-- open key -->
      <template v-else-if="open">
        <div class="flex shrink-0 items-center gap-2 border-b border-base-300/60 px-4 py-2">
          <span class="badge badge-soft badge-sm" :class="TYPE_COLOR[open.type] ?? 'badge-ghost'">{{ open.type }}</span>
          <template v-if="renaming !== null">
            <input v-model="renaming" class="input input-sm min-w-0 flex-1 font-mono" spellcheck="false" @keydown.enter="rename(renaming!)" @keydown.esc="renaming = null" />
            <button class="btn btn-sm" :disabled="busy" @click="rename(renaming!)">Rename</button>
            <button class="btn btn-ghost btn-sm" @click="renaming = null">Cancel</button>
          </template>
          <template v-else>
            <span class="min-w-0 flex-1 truncate font-mono text-sm font-semibold" :title="open.key">{{ open.key }}</span>
            <button class="btn btn-ghost btn-xs" @click="renaming = open!.key">Rename</button>
            <template v-if="ttlEdit !== null">
              <input v-model="ttlEdit" class="input input-xs w-24 font-mono" placeholder="seconds" inputmode="numeric" @keydown.enter="setTtl(ttlEdit!)" @keydown.esc="ttlEdit = null" />
              <button class="btn btn-xs" :disabled="busy" @click="setTtl(ttlEdit!)">Set</button>
              <button class="btn btn-ghost btn-xs" @click="ttlEdit = null">Cancel</button>
            </template>
            <button v-else class="btn btn-ghost btn-xs font-mono" title="Change the TTL" @click="ttlEdit = open!.ttl >= 0 ? String(open!.ttl) : ''">TTL {{ open.ttl < 0 ? '∞' : fmtTtl(open.ttl) }}</button>
            <button class="btn btn-ghost btn-xs text-error" @click="confirm = [open!.key]">Delete</button>
          </template>
        </div>
        <div v-if="isJsonString || stringPretty || hasJsonElements || couldBePhp" class="flex h-8 shrink-0 items-center gap-2 border-b border-base-300/60 px-4 text-[11px]">
          <span class="badge badge-ghost badge-xs">{{ couldBePhp || stringPretty?.kind === 'php' || (jsonElements.length && jsonElements.every((x) => x.pretty !== 'json')) ? 'PHP serialized' : 'JSON' }}</span>
          <div role="tablist" class="seg seg-xs">
            <a role="tab" class="seg-item normal-case" :class="{ 'is-active': view === 'pretty' }" @click="switchView('pretty')">Formatted</a>
            <a role="tab" class="seg-item normal-case" :class="{ 'is-active': view === 'raw' }" @click="switchView('raw')">Raw</a>
          </div>
          <label class="flex cursor-pointer items-center gap-1" title="Read PHP serialize() output (Laravel jobs, cache) and show backslashes as they are"><input type="checkbox" class="toggle toggle-xs" :checked="php" @change="togglePhp" />PHP</label>
          <span v-if="jsonError" class="truncate text-error">{{ jsonError }}</span>
          <span v-else-if="open.type === 'string' && stringPretty" class="opacity-50">{{ view === 'pretty' ? (stringPretty.kind === 'php' ? 'PHP serialize() output, read view; switch to Raw to edit' : 'JSON with serialized strings inside (expanded); switch to Raw to edit') : 'As stored' }}</span>
          <span v-else-if="open.type === 'string'" class="opacity-50">{{ view === 'pretty' ? 'Edited here; saved as compact JSON' : 'As stored' }}</span>
          <span v-else class="opacity-50">{{ view === 'pretty' ? 'Read view; switch to Raw to edit' : 'One element per line' }}</span>
        </div>
        <DvCodeEditor v-if="open.type === 'string' && isJsonString && view === 'pretty'" v-model="openText" language="json" class="flex-1" @input="dirty = true" />
        <pre v-else-if="open.type === 'string' && stringPretty && view === 'pretty'" class="dv-json min-h-0 flex-1" v-html="stringPretty.html" />
        <div v-else-if="open.type !== 'string' && hasJsonElements && view === 'pretty'" class="min-h-0 flex-1 overflow-auto">
          <div v-for="(el, i) in jsonElements" :key="i" class="border-b border-base-300/40">
            <div v-if="el.label" class="px-4 pt-2 font-mono text-[11px] font-semibold opacity-70">{{ el.label }}</div>
            <pre v-if="el.html" class="dv-json !py-1.5" v-html="el.html" />
            <pre v-else class="dv-json !py-1.5">{{ el.text }}</pre>
          </div>
        </div>
        <textarea v-else v-model="openText" class="dv-editor flex-1" :readonly="!editableType(open.type)" spellcheck="false" @input="dirty = true" />
        <div class="flex h-10 shrink-0 items-center gap-2 border-t border-base-300/60 px-4 text-xs">
          <span class="opacity-60">{{ open.shown < open.size ? `Showing ${fmtNum(open.shown)} of ${fmtNum(open.size)} elements (edit smaller values here or with commands). ` : '' }}{{ editableType(open.type) ? hint || `${fmtNum(open.size)} bytes` : 'This type is shown read-only' }}</span>
          <span class="flex-1" />
          <button v-if="dirty" class="btn btn-ghost btn-sm" @click="openText = (open!.type === 'string' && view === 'pretty' && prettyJson(String(open!.value))) || toText(open!); dirty = false">Revert</button>
          <button class="btn btn-primary btn-sm" :disabled="!dirty || busy || !editableType(open.type) || open.shown < open.size || !!jsonError" @click="save"><span v-if="busy" class="loading loading-spinner loading-xs" />Save</button>
        </div>
      </template>
      </aside>
    </Teleport>

    <ConfirmDialog v-if="confirm" :title="`Delete ${confirm.length === 1 ? confirm[0] : `${confirm.length} keys`}?`" text="There is no undo." confirm="Delete" tone="error" :busy="busy" @ok="doDelete" @cancel="confirm = null" />
  </div>
</template>
