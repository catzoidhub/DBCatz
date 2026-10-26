<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DvResult } from '@shared/types';
import { notify } from '../store';
import { phpPref, prettyHtml, renderPretty, setPhpPref } from './pretty';

/**
 * A row of a Redis / Valkey command's reply, opened in a drawer like a key's
 * value in the Keys view: JSON or PHP serialize() output Formatted (or Raw),
 * ↑ ↓ to the next row, and the Whole reply as JSON (HGETALL / CONFIG GET
 * pairs as an object).
 */
const props = defineProps<{ result: DvResult; index: number }>();
const emit = defineEmits<{ close: []; move: [index: number] }>();

const php = ref(phpPref());
const tab = ref<'value' | 'all'>('value');
const view = ref<'pretty' | 'raw'>('pretty');

const cellText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** One column: the cell as it came; several: the row as an object. */
const text = computed(() => {
  const row = props.result.rows[props.index] ?? [];
  return props.result.columns.length === 1 ? cellText(row[0]) : JSON.stringify(Object.fromEntries(props.result.columns.map((c, i) => [c, row[i] ?? null])));
});
const pretty = computed(() => prettyHtml(text.value, php.value));
watch(
  () => props.index,
  () => (view.value = 'pretty'),
);

/** The whole reply: field / value pairs as an object, else a list (multi-column rows as objects). */
const whole = computed(() => {
  const r = props.result;
  const cells = r.rows.map((row) => (r.columns.length === 1 ? row[0] : Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? null]))));
  const pairs = /^\s*(HGETALL|CONFIG\s+GET|XINFO|HRANDFIELD\s+\S+\s+-?\d+\s+WITHVALUES)\b/i.test(r.statement) && r.columns.length === 1 && cells.length % 2 === 0;
  if (!pairs) return cells.map((c) => (typeof c === 'string' ? (prettyHtml(c, false) ? JSON.parse(c) : c) : c));
  const o: Record<string, unknown> = {};
  for (let i = 0; i < cells.length; i += 2) {
    const v = cells[i + 1];
    o[cellText(cells[i])] = typeof v === 'string' && prettyHtml(v, false) ? JSON.parse(v) : v;
  }
  return o;
});
const wholeHtml = computed(() => renderPretty(whole.value, 0, 0, php.value));

function togglePhp() {
  php.value = !php.value;
  setPhpPref(php.value);
}
async function copy() {
  await navigator.clipboard.writeText(tab.value === 'all' ? JSON.stringify(whole.value, null, 2) : view.value === 'pretty' && pretty.value?.kind === 'json' ? JSON.stringify(JSON.parse(text.value), null, 2) : text.value);
  notify('success', 'Copied');
}
function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement).closest('input, textarea')) return;
  if (e.key === 'Escape') emit('close');
  else if (e.key === 'ArrowDown' && props.index < props.result.rows.length - 1) emit('move', props.index + 1);
  else if (e.key === 'ArrowUp' && props.index > 0) emit('move', props.index - 1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <Teleport to="body">
    <aside class="no-drag fixed top-0 right-0 bottom-0 z-50 flex w-[44rem] max-w-[92vw] flex-col border-l border-base-300/60 bg-base-100 shadow-2xl">
      <div class="flex shrink-0 items-center gap-2 border-b border-base-300/60 px-4 py-2">
        <span class="badge badge-ghost badge-sm">reply</span>
        <span class="min-w-0 flex-1 truncate font-mono text-sm font-semibold" :title="result.statement">{{ result.statement }}</span>
        <button class="btn btn-ghost btn-xs btn-square" :disabled="index === 0" title="Previous row (↑)" @click="emit('move', index - 1)">↑</button>
        <span class="font-mono text-[11px] tabular-nums opacity-60">{{ index + 1 }} / {{ result.rows.length }}</span>
        <button class="btn btn-ghost btn-xs btn-square" :disabled="index >= result.rows.length - 1" title="Next row (↓)" @click="emit('move', index + 1)">↓</button>
        <button class="btn btn-ghost btn-xs btn-square" title="Close (Esc)" @click="emit('close')">✕</button>
      </div>
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-base-300/60 px-4 text-[11px]">
        <div role="tablist" class="seg seg-xs">
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': tab === 'value' }" @click="tab = 'value'">Row {{ index + 1 }}</a>
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': tab === 'all' }" @click="tab = 'all'">Whole reply</a>
        </div>
        <template v-if="tab === 'value' && pretty">
          <span class="badge badge-ghost badge-xs">{{ pretty.kind === 'php' ? 'PHP serialized' : 'JSON' }}</span>
          <div role="tablist" class="seg seg-xs">
            <a role="tab" class="seg-item normal-case" :class="{ 'is-active': view === 'pretty' }" @click="view = 'pretty'">Formatted</a>
            <a role="tab" class="seg-item normal-case" :class="{ 'is-active': view === 'raw' }" @click="view = 'raw'">Raw</a>
          </div>
        </template>
        <span v-else-if="tab === 'value'" class="opacity-50">Plain text</span>
        <span v-else class="opacity-50">{{ Array.isArray(whole) ? `${whole.length} items` : 'Field / value pairs as an object' }}</span>
        <label class="flex cursor-pointer items-center gap-1" title="Read PHP serialize() output (Laravel jobs, cache) and show backslashes as they are"><input type="checkbox" class="toggle toggle-xs" :checked="php" @change="togglePhp" />PHP</label>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs" @click="copy">Copy</button>
      </div>
      <pre v-if="tab === 'all'" class="dv-json min-h-0 flex-1" v-html="wholeHtml" />
      <pre v-else-if="pretty && view === 'pretty'" class="dv-json min-h-0 flex-1" v-html="pretty.html" />
      <textarea v-else :value="text" class="dv-editor flex-1" readonly spellcheck="false" />
      <div class="flex h-9 shrink-0 items-center gap-2 border-t border-base-300/60 px-4 text-[11px] opacity-60">
        <span>{{ text.length.toLocaleString('en-US') }} characters · read only · ↑ ↓ move between rows · Esc closes</span>
      </div>
    </aside>
  </Teleport>
</template>
