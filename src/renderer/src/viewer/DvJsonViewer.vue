<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { keyLabel } from '@shared/platform';
import { notify } from '../store';
import { renderPretty } from './pretty';
import DvJsonEditor from './DvJsonEditor.vue';

/**
 * A JSON cell, easy to read: indented 2 spaces and coloured like a code editor (keys, strings, numbers,
 * true / false / null), the same look as DialCatz's Pretty view, in light and dark, with line numbers and Find
 * (⌘F: matches highlighted, n of m, ⏎ / ⇧⏎ to step through). Copy takes the formatted JSON. Edit (when the cell can
 * be edited) edits it in the same pretty form (DvJsonEditor: colours, line numbers, Find & Replace, checked as typed);
 * Save hands the text to the grid, which writes it like any cell edit (Production asks first).
 */
const props = defineProps<{ value: unknown; column: string; type?: string; row: number; editable?: boolean; busy?: boolean }>();
const emit = defineEmits<{ close: []; save: [text: string] }>();

// ---- editing in the pretty form
const editingJson = ref(false);
const draft = ref('');
const confirmDiscard = ref(false);
const editor = ref<InstanceType<typeof DvJsonEditor> | null>(null);
const dirty = computed(() => editingJson.value && draft.value !== pretty.value);
function startEditing() {
  draft.value = pretty.value;
  confirmDiscard.value = false;
  editingJson.value = true;
}
function stopEditing() {
  if (dirty.value && !confirmDiscard.value) {
    confirmDiscard.value = true;
    return;
  }
  editingJson.value = false;
  confirmDiscard.value = false;
}
const draftError = computed(() => {
  try {
    JSON.parse(draft.value);
    return false;
  } catch {
    return true;
  }
});
function save() {
  if (draftError.value || props.busy) return;
  emit('save', draft.value);
}

/** The value as JSON: objects / arrays as they are (MongoDB), text parsed (json / jsonb / JSON columns, JSON in text). */
const parsed = computed<{ ok: true; value: unknown } | { ok: false; error: string }>(() => {
  if (props.value !== null && typeof props.value === 'object') return { ok: true, value: props.value };
  try {
    return { ok: true, value: JSON.parse(String(props.value)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
const pretty = computed(() => (parsed.value.ok ? JSON.stringify(parsed.value.value, null, 2) : String(props.value)));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** One HTML string per line (renderPretty keeps every token on one line; strings are JSON-escaped). */
const lines = computed(() => (parsed.value.ok ? renderPretty(parsed.value.value, 0, 0, false) : esc(pretty.value)).split('\n'));
const size = computed(() => {
  const v = parsed.value.ok ? parsed.value.value : null;
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  if (v && typeof v === 'object') return `${Object.keys(v).length} ${Object.keys(v).length === 1 ? 'key' : 'keys'}`;
  return '';
});

// ---- Find: the lines are drawn again for every query, then the matches are wrapped in <mark> in the text nodes.
const query = ref('');
const findInput = ref<HTMLInputElement | null>(null);
const body = ref<HTMLElement | null>(null);
const marks = ref<HTMLElement[]>([]);
const current = ref(0);
/** Redraws the lines for a new query (a fresh copy of the coloured HTML to mark up). */
const drawKey = ref(0);

function mark() {
  marks.value = [];
  const q = query.value.toLowerCase();
  if (!q || !body.value) return;
  const walker = document.createTreeWalker(body.value, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest('.dv-jl-n') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    const low = text.toLowerCase();
    let at = low.indexOf(q);
    if (at < 0) continue;
    const frag = document.createDocumentFragment();
    let from = 0;
    while (at >= 0) {
      if (at > from) frag.append(text.slice(from, at));
      const m = document.createElement('mark');
      m.className = 'dv-find';
      m.textContent = text.slice(at, at + q.length);
      frag.append(m);
      marks.value.push(m);
      from = at + q.length;
      at = low.indexOf(q, from);
    }
    if (from < text.length) frag.append(text.slice(from));
    node.replaceWith(frag);
  }
}
function show(i: number) {
  if (!marks.value.length) return;
  current.value = (i + marks.value.length) % marks.value.length;
  marks.value.forEach((m, j) => m.classList.toggle('is-current', j === current.value));
  marks.value[current.value].scrollIntoView({ block: 'center', inline: 'nearest' });
}
watch(query, async () => {
  drawKey.value++;
  await nextTick();
  mark();
  show(0);
});
const next = () => show(current.value + 1);
const prev = () => show(current.value - 1);
const counter = computed(() => (!query.value ? '' : marks.value.length ? `${current.value + 1} of ${marks.value.length}` : 'No matches'));
function findKeys(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
  } else if (e.key === 'Escape' && query.value) {
    e.stopPropagation();
    query.value = '';
  }
}

async function copy() {
  await navigator.clipboard.writeText(pretty.value);
  notify('success', 'JSON copied');
}
const onKey = (e: KeyboardEvent) => {
  // While editing, DvJsonEditor owns the keys (Find & Replace, ⌘S, Esc to cancel).
  if (editingJson.value) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findInput.value?.focus();
    findInput.value?.select();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
  } else if (e.key === 'Escape' && !(e.target === findInput.value && query.value)) {
    e.stopPropagation();
    emit('close');
  }
};
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <dialog open class="modal modal-open">
    <div class="modal-box flex max-h-[82vh] w-[48rem] max-w-[95vw] flex-col gap-0 p-0">
      <div class="flex items-center gap-2 border-b border-base-300/60 px-5 pt-4 pb-3">
        <span class="badge badge-ghost badge-sm font-mono">{ }</span>
        <span class="truncate font-mono text-sm font-semibold">{{ column }}</span>
        <span v-if="type" class="badge badge-ghost badge-xs shrink-0 font-mono">{{ type }}</span>
        <span v-if="size" class="shrink-0 text-[11px] opacity-50">{{ size }}</span>
        <span class="flex-1" />
        <span v-if="editingJson" class="badge badge-primary badge-sm shrink-0">Editing</span>
        <span class="shrink-0 text-[11px] opacity-50">row {{ row }}</span>
      </div>
      <DvJsonEditor v-if="editingJson" ref="editor" v-model="draft" :busy="busy" @save="save" @cancel="stopEditing" />
      <template v-else>
      <div class="flex items-center gap-2 border-b border-base-300/60 px-5 py-2">
        <label class="input input-sm min-w-0 flex-1 gap-2">
          <svg viewBox="0 0 20 20" class="size-3.5 shrink-0 opacity-50" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.38 9.84l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clip-rule="evenodd" /></svg>
          <input ref="findInput" v-model="query" class="grow font-mono text-xs" :placeholder="`Find in this JSON (${keyLabel('mod+F')})`" spellcheck="false" autocomplete="off" @keydown="findKeys" />
          <span v-if="counter" class="shrink-0 text-[11px]" :class="marks.length ? 'opacity-55' : 'text-warning'">{{ counter }}</span>
        </label>
        <button class="btn btn-ghost btn-sm btn-square" :disabled="!marks.length" :title="`Previous (⇧⏎)`" @click="prev">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M14.77 12.79a.75.75 0 0 1-1.06-.02L10 8.83l-3.71 3.94a.75.75 0 1 1-1.08-1.04l4.25-4.5a.75.75 0 0 1 1.08 0l4.25 4.5a.75.75 0 0 1-.02 1.06Z" clip-rule="evenodd" /></svg>
        </button>
        <button class="btn btn-ghost btn-sm btn-square" :disabled="!marks.length" :title="`Next (⏎)`" @click="next">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clip-rule="evenodd" /></svg>
        </button>
      </div>
      <p v-if="!parsed.ok" class="px-5 pt-3 text-sm text-warning">This value is not valid JSON ({{ parsed.error }}); shown as it is.</p>
      <div ref="body" :key="drawKey" class="dv-json dv-json-lines min-h-0 flex-1">
        <div v-for="(l, i) in lines" :key="i" class="dv-jl"><span class="dv-jl-n">{{ i + 1 }}</span><span class="dv-jl-c" v-html="l || ' '" /></div>
      </div>
      </template>
      <div v-if="editingJson" class="flex items-center gap-2 border-t border-base-300/60 px-5 pt-3 pb-4">
        <button class="btn btn-sm" :disabled="draftError" title="Indent 2 spaces again" @click="editor?.format()">Format</button>
        <button class="btn btn-ghost btn-sm" :title="`Find & Replace (${keyLabel('mod+F')})`" @click="editor?.openFind(true)">Find &amp; Replace</button>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-sm" :class="{ 'text-error': confirmDiscard }" :disabled="busy" @click="stopEditing">{{ confirmDiscard ? 'Discard changes' : 'Cancel' }}</button>
        <button class="btn btn-primary btn-sm" :disabled="draftError || busy || !dirty" :title="`Save (${keyLabel('mod+S')})`" @click="save"><span v-if="busy" class="loading loading-spinner loading-xs" />Save</button>
      </div>
      <div v-else class="flex items-center gap-2 border-t border-base-300/60 px-5 pt-3 pb-4">
        <button class="btn btn-sm" @click="copy">Copy</button>
        <span class="text-[11px] opacity-50">{{ lines.length }} {{ lines.length === 1 ? 'line' : 'lines' }}</span>
        <span class="flex-1" />
        <button v-if="editable && parsed.ok" class="btn btn-ghost btn-sm" @click="startEditing">Edit</button>
        <button class="btn btn-primary btn-sm" @click="emit('close')">Close</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!editingJson && emit('close')" />
  </dialog>
</template>
