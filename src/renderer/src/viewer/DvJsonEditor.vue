<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { currentOS, keyLabel } from '@shared/platform';
import { highlight } from './highlight';

/**
 * Editing a JSON cell in its pretty form (DvJsonViewer's Edit): the text indented 2 spaces, coloured as it is typed
 * (a transparent textarea over the highlighted text, like DvCodeEditor), line numbers, and Find & Replace —
 * ⌘F find, ⌥⌘F (Ctrl+H on Windows) replace, ⏎ / ⇧⏎ / ⌘G to step, Replace / Replace all. The JSON is checked as it
 * is typed: Save is off while it does not parse, and the error says the line and column. ⌘S saves, Format
 * re-indents, Tab inserts two spaces.
 */
const props = defineProps<{ modelValue: string; busy?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: []; cancel: [] }>();

const area = ref<HTMLTextAreaElement | null>(null);
const hl = ref<HTMLElement | null>(null);
const gutter = ref<HTMLElement | null>(null);
const text = computed({ get: () => props.modelValue, set: (v: string) => emit('update:modelValue', v) });
const lineCount = computed(() => text.value.split('\n').length);
const html = computed(() => `${highlight('json', text.value)}\n`);

/** null when the text parses, else where and why it does not. */
const error = computed<string | null>(() => {
  try {
    JSON.parse(text.value);
    return null;
  } catch (e) {
    const msg = (e as Error).message;
    const at = /position (\d+)/.exec(msg);
    if (!at) return msg;
    const before = text.value.slice(0, Number(at[1]));
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    return `Line ${line}, column ${col}: ${msg.replace(/ (in JSON )?at position \d+.*$/, '').replace(/^JSON\.parse: /, '')}`;
  }
});
function format() {
  if (error.value) return;
  text.value = JSON.stringify(JSON.parse(text.value), null, 2);
}

function onScroll() {
  const a = area.value;
  if (!a) return;
  if (hl.value) {
    hl.value.scrollTop = a.scrollTop;
    hl.value.scrollLeft = a.scrollLeft;
  }
  if (gutter.value) gutter.value.scrollTop = a.scrollTop;
}

// ---- Find & Replace
const finding = ref(false);
const replacing = ref(false);
const query = ref('');
const replacement = ref('');
const findInput = ref<HTMLInputElement | null>(null);
const replaceInput = ref<HTMLInputElement | null>(null);
const current = ref(0);
/** Every match's start (case-insensitive). */
const matches = computed(() => {
  const q = query.value.toLowerCase();
  if (!q) return [] as number[];
  const low = text.value.toLowerCase();
  const out: number[] = [];
  for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) out.push(at);
  return out;
});
const counter = computed(() => (!query.value ? '' : matches.value.length ? `${Math.min(current.value + 1, matches.value.length)} of ${matches.value.length}` : 'No matches'));

/** Marks the matches in the highlighted layer under the textarea (the current one stronger). */
function paint() {
  const root = hl.value;
  if (!root) return;
  root.innerHTML = html.value;
  const q = query.value.toLowerCase();
  if (!finding.value || !q) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = 0;
  let index = 0;
  for (const node of nodes) {
    const t = node.data;
    const frag = document.createDocumentFragment();
    let from = 0;
    let changed = false;
    // A match may cross a highlight span; marks cover the part inside each text node.
    while (index < matches.value.length && matches.value[index] < offset + t.length) {
      const start = Math.max(matches.value[index], offset) - offset;
      const end = Math.min(matches.value[index] + q.length, offset + t.length) - offset;
      if (start > from) frag.append(t.slice(from, start));
      const m = document.createElement('mark');
      m.className = index === current.value ? 'dv-find is-current' : 'dv-find';
      m.textContent = t.slice(start, end);
      frag.append(m);
      from = end;
      changed = true;
      if (matches.value[index] + q.length <= offset + t.length) index++;
      else break;
    }
    if (changed) {
      if (from < t.length) frag.append(t.slice(from));
      node.replaceWith(frag);
    }
    offset += t.length;
  }
}
watch([html, query, current, finding], () => nextTick(paint));
onMounted(paint);

/** Selects match i in the textarea and scrolls it into view. */
function go(i: number, focusText = false) {
  const n = matches.value.length;
  if (!n || !area.value) return;
  current.value = (i + n) % n;
  const at = matches.value[current.value];
  const a = area.value;
  const line = text.value.slice(0, at).split('\n').length - 1;
  const lh = parseFloat(getComputedStyle(a).lineHeight) || 19;
  const top = line * lh;
  if (top < a.scrollTop || top > a.scrollTop + a.clientHeight - lh * 2) a.scrollTop = Math.max(0, top - a.clientHeight / 2);
  if (focusText) {
    a.focus();
    a.setSelectionRange(at, at + query.value.length);
  }
  onScroll();
}
watch(query, () => {
  current.value = 0;
  go(0);
});
const next = () => go(current.value + 1);
const prev = () => go(current.value - 1);

function openFind(withReplace: boolean) {
  finding.value = true;
  replacing.value = withReplace || replacing.value;
  const a = area.value;
  const sel = a && a.selectionStart !== a.selectionEnd ? a.value.slice(a.selectionStart, a.selectionEnd) : '';
  if (sel && !sel.includes('\n')) query.value = sel;
  void nextTick(() => {
    const el = withReplace && query.value ? replaceInput.value : findInput.value;
    el?.focus();
    el?.select();
  });
}
function closeFind() {
  finding.value = false;
  replacing.value = false;
  area.value?.focus();
}
/** Replaces the current match, then moves to the next one. */
function replaceOne() {
  const n = matches.value.length;
  if (!n) return;
  const i = Math.min(current.value, n - 1);
  const at = matches.value[i];
  text.value = text.value.slice(0, at) + replacement.value + text.value.slice(at + query.value.length);
  void nextTick(() => go(i));
}
function replaceAll() {
  const n = matches.value.length;
  if (!n) return;
  let out = '';
  let from = 0;
  for (const at of matches.value) {
    out += text.value.slice(from, at) + replacement.value;
    from = at + query.value.length;
  }
  text.value = out + text.value.slice(from);
  current.value = 0;
}
function findKeys(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFind();
  }
}
function replaceKeys(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) replaceAll();
    else replaceOne();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFind();
  }
}

// ---- keys in the text: Tab = two spaces, ⏎ keeps the indentation
function onKey(e: KeyboardEvent) {
  const a = area.value!;
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    const s = a.selectionStart;
    text.value = `${a.value.slice(0, s)}  ${a.value.slice(a.selectionEnd)}`;
    void nextTick(() => a.setSelectionRange(s + 2, s + 2));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('cancel');
  } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    const s = a.selectionStart;
    const lineStart = a.value.lastIndexOf('\n', s - 1) + 1;
    const indent = /^\s*/.exec(a.value.slice(lineStart, s))![0];
    const opens = /[{[]\s*$/.test(a.value.slice(lineStart, s)) ? '  ' : '';
    const ins = `\n${indent}${opens}`;
    text.value = `${a.value.slice(0, s)}${ins}${a.value.slice(a.selectionEnd)}`;
    void nextTick(() => a.setSelectionRange(s + ins.length, s + ins.length));
  }
}

/** ⌘F / ⌥⌘F (Ctrl+H) / ⌘G / ⌘S anywhere in the dialog (capture, before the viewer's own keys). */
const onWindowKey = (e: KeyboardEvent) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && (k === 'f' || e.code === 'KeyF') && e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    openFind(true);
  } else if (mod && k === 'f') {
    e.preventDefault();
    e.stopPropagation();
    openFind(false);
  } else if (currentOS !== 'mac' && e.ctrlKey && k === 'h') {
    e.preventDefault();
    e.stopPropagation();
    openFind(true);
  } else if (mod && k === 'g') {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) prev();
    else next();
  } else if (mod && k === 's') {
    e.preventDefault();
    e.stopPropagation();
    if (!error.value && !props.busy) emit('save');
  }
};
onMounted(() => {
  window.addEventListener('keydown', onWindowKey, true);
  area.value?.focus();
  area.value?.setSelectionRange(0, 0);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKey, true));

const replaceShortcut = currentOS === 'mac' ? keyLabel('mod+alt+F') : keyLabel('ctrl+H');
defineExpose({ error, format, openFind });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="finding" class="space-y-1.5 border-b border-base-300/60 px-5 py-2">
      <div class="flex items-center gap-2">
        <label class="input input-sm min-w-0 flex-1 gap-2">
          <svg viewBox="0 0 20 20" class="size-3.5 shrink-0 opacity-50" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.38 9.84l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clip-rule="evenodd" /></svg>
          <input ref="findInput" v-model="query" class="grow font-mono text-xs" placeholder="Find" spellcheck="false" autocomplete="off" @keydown="findKeys" />
          <span v-if="counter" class="shrink-0 text-[11px]" :class="matches.length ? 'opacity-55' : 'text-warning'">{{ counter }}</span>
        </label>
        <button class="btn btn-ghost btn-sm btn-square" :disabled="!matches.length" title="Previous (⇧⏎)" @click="prev">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M14.77 12.79a.75.75 0 0 1-1.06-.02L10 8.83l-3.71 3.94a.75.75 0 1 1-1.08-1.04l4.25-4.5a.75.75 0 0 1 1.08 0l4.25 4.5a.75.75 0 0 1-.02 1.06Z" clip-rule="evenodd" /></svg>
        </button>
        <button class="btn btn-ghost btn-sm btn-square" :disabled="!matches.length" title="Next (⏎)" @click="next">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clip-rule="evenodd" /></svg>
        </button>
        <button class="btn btn-ghost btn-sm" :class="{ 'btn-active': replacing }" :title="`Replace (${replaceShortcut})`" @click="replacing = !replacing">Replace</button>
        <button class="btn btn-ghost btn-sm btn-square" title="Close (esc)" @click="closeFind">✕</button>
      </div>
      <div v-if="replacing" class="flex items-center gap-2">
        <label class="input input-sm min-w-0 flex-1 gap-2">
          <svg viewBox="0 0 20 20" class="size-3.5 shrink-0 opacity-50" fill="currentColor"><path fill-rule="evenodd" d="M15.31 5.22a.75.75 0 0 1 0 1.06l-2.5 2.5a.75.75 0 0 1-1.06-1.06l1.22-1.22H7.5a3 3 0 0 0 0 6h.75a.75.75 0 0 1 0 1.5H7.5a4.5 4.5 0 0 1 0-9h5.47l-1.22-1.22a.75.75 0 1 1 1.06-1.06l2.5 2.5Z" clip-rule="evenodd" /></svg>
          <input ref="replaceInput" v-model="replacement" class="grow font-mono text-xs" placeholder="Replace with" spellcheck="false" autocomplete="off" @keydown="replaceKeys" />
        </label>
        <button class="btn btn-ghost btn-sm" :disabled="!matches.length" title="Replace this one (⏎)" @click="replaceOne">Replace</button>
        <button class="btn btn-ghost btn-sm" :disabled="!matches.length" :title="`Replace all (${keyLabel('mod+⏎')})`" @click="replaceAll">Replace all</button>
      </div>
    </div>

    <div class="dv-jsonedit min-h-0 flex-1">
      <div ref="gutter" class="dv-jsonedit-gutter" aria-hidden="true"><div v-for="n in lineCount" :key="n">{{ n }}</div><div>&nbsp;</div></div>
      <div class="relative min-w-0 flex-1">
        <pre ref="hl" class="dv-code-hl dv-jsonedit-layer" aria-hidden="true" />
        <textarea
          ref="area"
          v-model="text"
          class="dv-code-input dv-jsonedit-layer"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          autocomplete="off"
          wrap="off"
          @scroll="onScroll"
          @keydown="onKey"
        />
      </div>
    </div>

    <p class="border-t border-base-300/60 px-5 py-1.5 text-[11.5px]" :class="error ? 'text-error' : 'opacity-55'">
      <template v-if="error">{{ error }}</template>
      <template v-else>Valid JSON · {{ lineCount }} {{ lineCount === 1 ? 'line' : 'lines' }} · {{ keyLabel('mod+F') }} find · {{ replaceShortcut }} replace · {{ keyLabel('mod+S') }} save</template>
    </p>
  </div>
</template>
