<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { highlight, type Language } from './highlight';
import type { Completion, Suggestion } from './complete';

/**
 * A code editor without a dependency: a transparent textarea over a
 * highlighted <pre> that scrolls with it. Tab inserts two spaces; ⌘⏎ emits
 * `run`. `names` (tables / collections) get their own colour.
 *
 * With `complete`, typing opens suggestions under the caret (keywords, tables,
 * columns …): ↑ ↓ to move, ⏎ / Tab / → to insert, Esc to close, a click to
 * pick; Ctrl+Space opens them with nothing typed. `completeVersion` changes
 * when more is known (columns loaded), and the open list is worked out again.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    language: Language;
    names?: string[];
    placeholder?: string;
    readonly?: boolean;
    minRows?: number;
    complete?: ((text: string, cursor: number, explicit: boolean) => Completion | null) | null;
    completeVersion?: number;
  }>(),
  { names: () => [], placeholder: '', readonly: false, minRows: 4, complete: null, completeVersion: 0 },
);
const emit = defineEmits<{ 'update:modelValue': [value: string]; run: []; input: [] }>();
const area = ref<HTMLTextAreaElement | null>(null);
const pre = ref<HTMLElement | null>(null);
const nameSet = computed(() => new Set(props.names));
const html = computed(() => `${highlight(props.language, props.modelValue, nameSet.value)}\n`);

// ---- suggestions
const comp = ref<Completion | null>(null);
const active = ref(0);
const pop = ref<{ top: number; left: number; above: boolean } | null>(null);
const list = ref<HTMLElement | null>(null);
let explicitOpen = false;
/** The last look found nothing, maybe only because columns were still loading: look again when they arrive. */
let retryAt = 0;

const typed = computed(() => (comp.value ? props.modelValue.slice(comp.value.from, area.value?.selectionStart ?? comp.value.to) : ''));

function close() {
  comp.value = null;
  pop.value = null;
  explicitOpen = false;
}

/** Where the word being completed starts on screen, from the monospace grid (line × line height, column × char width). */
function caretBox(): { x: number; y: number; lh: number } | null {
  const a = area.value;
  if (!a) return null;
  const cs = getComputedStyle(a);
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
  const cw = ctx.measureText('M').width;
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.55;
  const from = comp.value?.from ?? a.selectionStart;
  const before = a.value.slice(0, from);
  const line = before.split('\n').length - 1;
  const col = before.length - before.lastIndexOf('\n') - 1;
  const r = a.getBoundingClientRect();
  return { x: r.left + parseFloat(cs.paddingLeft) + col * cw - a.scrollLeft, y: r.top + parseFloat(cs.paddingTop) + line * lh - a.scrollTop, lh };
}

function refresh(explicit = false) {
  const a = area.value;
  if (!a || !props.complete || props.readonly || a.selectionStart !== a.selectionEnd) return close();
  const c = props.complete(a.value, a.selectionStart, explicit || explicitOpen);
  if (!c) {
    const keep = explicit || explicitOpen;
    close();
    explicitOpen = keep;
    retryAt = a.selectionStart;
    return;
  }
  retryAt = -1;
  const sameWord = comp.value && comp.value.from === c.from;
  comp.value = c;
  if (!sameWord) active.value = 0;
  active.value = Math.min(active.value, c.items.length - 1);
  const box = caretBox();
  if (!box) return;
  const height = Math.min(c.items.length, 8) * 38 + 52;
  const above = box.y + box.lh + height > window.innerHeight - 12;
  pop.value = {
    top: above ? box.y - height - 8 : box.y + box.lh + 8,
    // Labels line up with the word: the kind icon sits to its left.
    left: Math.max(12, Math.min(box.x - 44, window.innerWidth - 432)),
    above,
  };
}
watch(
  () => props.completeVersion,
  () => {
    const a = area.value;
    if (comp.value || (a && document.activeElement === a && a.selectionStart === retryAt)) refresh();
  },
);
watch(active, async () => {
  await nextTick();
  list.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
});

function accept(s: Suggestion | undefined = comp.value?.items[active.value]) {
  const a = area.value;
  const c = comp.value;
  if (!a || !c || !s) return close();
  const v = a.value;
  // `COUNT()` puts the caret between the brackets.
  const caretBack = s.insert.endsWith('()') ? 1 : 0;
  const next = `${v.slice(0, c.from)}${s.insert}${v.slice(c.to)}`;
  const at = c.from + s.insert.length - caretBack;
  close();
  emit('update:modelValue', next);
  emit('input');
  requestAnimationFrame(() => {
    a.focus();
    a.setSelectionRange(at, at);
  });
}

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
  emit('input');
  const kind = (e as InputEvent).inputType ?? '';
  // Typing opens / narrows the list; deleting keeps an open one up to date.
  if (kind.startsWith('insert') || (comp.value && kind.startsWith('delete'))) void nextTick(() => refresh());
  else close();
}
function onScroll() {
  if (pre.value && area.value) {
    pre.value.scrollTop = area.value.scrollTop;
    pre.value.scrollLeft = area.value.scrollLeft;
  }
  if (comp.value) refresh();
}
function onKey(ev: KeyboardEvent) {
  if (comp.value) {
    const n = comp.value.items.length;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      active.value = (active.value + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return;
    }
    if ((ev.key === 'Enter' && !(ev.metaKey || ev.ctrlKey)) || ev.key === 'Tab' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      accept();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'Home' || ev.key === 'End' || ev.key === 'PageUp' || ev.key === 'PageDown') close();
  }
  if (ev.ctrlKey && (ev.key === ' ' || ev.code === 'Space')) {
    ev.preventDefault();
    explicitOpen = true;
    refresh(true);
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    ev.preventDefault();
    close();
    emit('run');
  } else if (ev.key === 'Tab' && !props.readonly) {
    ev.preventDefault();
    const a = ev.target as HTMLTextAreaElement;
    const s = a.selectionStart;
    const v = `${a.value.slice(0, s)}  ${a.value.slice(a.selectionEnd)}`;
    emit('update:modelValue', v);
    requestAnimationFrame(() => a.setSelectionRange(s + 2, s + 2));
  }
}
/** The selected text (empty when nothing is selected). */
function selection(): string {
  const a = area.value;
  return a && a.selectionStart !== a.selectionEnd ? a.value.slice(a.selectionStart, a.selectionEnd) : '';
}
function insert(text: string) {
  const a = area.value;
  if (!a) return;
  const s = a.selectionStart;
  emit('update:modelValue', `${a.value.slice(0, s)}${text}${a.value.slice(a.selectionEnd)}`);
  requestAnimationFrame(() => {
    a.focus();
    a.setSelectionRange(s + text.length, s + text.length);
  });
}
const focus = () => area.value?.focus();
defineExpose({ selection, insert, focus });

const onWindowDown = (e: MouseEvent) => {
  if (comp.value && !list.value?.contains(e.target as Node)) close();
};
window.addEventListener('mousedown', onWindowDown, true);
window.addEventListener('resize', close);
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onWindowDown, true);
  window.removeEventListener('resize', close);
});

/** The label split around the part that matches what was typed (shown bold). */
function parts(label: string): [string, string, string] {
  const t = typed.value.toLowerCase();
  const i = t ? label.toLowerCase().indexOf(t) : -1;
  return i < 0 ? ['', '', label] : [label.slice(0, i), label.slice(i, i + t.length), label.slice(i + t.length)];
}
/** Long names (Redis keys) keep their start and their end, which tells them apart: `desa_database_…_63.09.01.2001_hex`. */
const LONG = 52;
function shorten(label: string): string {
  if (label.length <= LONG) return label;
  const head = Math.max(typed.value.length + 6, 22);
  return `${label.slice(0, head)}…${label.slice(-(LONG - head - 1))}`;
}
const KIND_LABEL: Record<Suggestion['kind'], string> = { keyword: 'Keyword', table: 'Table', column: 'Column', function: 'Function', key: 'Key', option: 'Option' };
</script>

<template>
  <div class="dv-code" :style="{ minHeight: `${minRows * 1.55 + 1.5}rem` }">
    <pre ref="pre" class="dv-code-hl" aria-hidden="true" v-html="html" />
    <textarea
      ref="area"
      class="dv-code-input"
      :value="modelValue"
      :placeholder="placeholder"
      :readonly="readonly"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      autocomplete="off"
      wrap="off"
      @input="onInput"
      @scroll="onScroll"
      @keydown="onKey"
      @blur="close"
    />
  </div>

  <Teleport to="body">
    <div v-if="comp && pop" ref="list" class="dv-suggest" :class="{ 'is-above': pop.above }" :style="{ top: `${pop.top}px`, left: `${pop.left}px` }" @mousedown.prevent>
      <ul class="dv-suggest-list">
        <li v-for="(s, i) in comp.items" :key="`${s.kind}:${s.label}`" class="dv-suggest-item" :class="{ 'is-active': i === active }" @mouseenter="active = i" @click="accept(s)">
          <span class="dv-suggest-kind" :class="`is-${s.kind}`" :title="KIND_LABEL[s.kind]">
            <svg v-if="s.kind === 'table'" viewBox="0 0 20 20" fill="currentColor"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11ZM4.5 7v2.5h4.75V7H4.5Zm6.25 0v2.5h4.75V7h-4.75ZM4.5 11v2.5h4.75V11H4.5Zm6.25 0v2.5h4.75V11h-4.75Z" /></svg>
            <svg v-else-if="s.kind === 'column'" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm6 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Z" /></svg>
            <svg v-else-if="s.kind === 'key'" viewBox="0 0 20 20" fill="currentColor"><path d="M12.5 2a5.5 5.5 0 0 0-5.3 7l-4.9 4.9a1 1 0 0 0-.3.7V17a1 1 0 0 0 1 1h2.4a1 1 0 0 0 .7-.3l.6-.6V15.5h1.6v-1.6h1.6l1.2-1.2A5.5 5.5 0 1 0 12.5 2Zm1.5 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" /></svg>
            <template v-else-if="s.kind === 'option'">–</template>
            <template v-else-if="s.kind === 'function'">ƒ</template>
            <template v-else>K</template>
          </span>
          <span class="dv-suggest-label" :title="s.label.length > LONG ? s.label : undefined"><span>{{ parts(shorten(s.label))[0] }}</span><b>{{ parts(shorten(s.label))[1] }}</b><span>{{ parts(shorten(s.label))[2] }}</span></span>
          <span v-if="s.detail" class="dv-suggest-detail">{{ s.detail }}</span>
        </li>
      </ul>
      <div class="dv-suggest-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>⏎</kbd><kbd>→</kbd> insert</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  </Teleport>
</template>
