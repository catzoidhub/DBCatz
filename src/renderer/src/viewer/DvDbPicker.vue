<script setup lang="ts">
import { keyLabel } from '@shared/platform';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { DvConnection, DvDbPrefs } from '@shared/types';
import { api } from '../store';
import { isSystemDb, words } from './viewer';

/**
 * The sidebar's database picker: a button with the current database that
 * opens a list with a filter box (⌘P). Starred and recently picked databases
 * (kept per connection) come first, then the connection's own, then the
 * server's built-in ones. Only the visible rows are drawn, so thousands of
 * databases stay quick.
 */
const props = defineProps<{ conn: DvConnection; databases: string[]; modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [db: string] }>();
defineExpose({ show });
const W = computed(() => words(props.conn.engine));

const open = ref(false);
const query = ref('');
const activeIndex = ref(0);
const showSystem = ref(false);
const prefs = ref<DvDbPrefs>({ recent: [], favorites: [] });
onMounted(async () => {
  prefs.value = (await api.dvDbPrefs(props.conn.id).catch(() => null)) ?? prefs.value;
});

type Row = { kind: 'head'; label: string; count?: number; toggle?: boolean } | { kind: 'db'; name: string; system: boolean };
const known = computed(() => new Set(props.databases));
const own = computed(() => props.databases.filter((d) => !isSystemDb(props.conn.engine, d)));
const system = computed(() => props.databases.filter((d) => isSystemDb(props.conn.engine, d)));
const starred = computed(() => prefs.value.favorites.filter((d) => known.value.has(d)));
const db = (name: string): Row => ({ kind: 'db', name, system: isSystemDb(props.conn.engine, name) });

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  // Names that start with the text first, then the rest, each alphabetical.
  const hit = props.databases.filter((d) => d.toLowerCase().includes(q));
  return [...hit.filter((d) => d.toLowerCase().startsWith(q)), ...hit.filter((d) => !d.toLowerCase().startsWith(q))];
});
const rows = computed<Row[]>(() => {
  if (query.value.trim()) return matches.value.map(db);
  const out: Row[] = [];
  if (starred.value.length) out.push({ kind: 'head', label: 'Starred' }, ...starred.value.map(db));
  const recent = prefs.value.recent.filter((d) => known.value.has(d) && !starred.value.includes(d)).slice(0, 5);
  // Recent only helps once there is something to scroll past.
  if (recent.length && props.databases.length > 8) out.push({ kind: 'head', label: 'Recent' }, ...recent.map(db));
  if (system.value.length) {
    out.push({ kind: 'head', label: own.value.length ? `${W.value.dbs[0].toUpperCase()}${W.value.dbs.slice(1)}` : `No ${W.value.dbs} yet`, count: own.value.length }, ...own.value.map(db));
    // Many built-in databases fold away unless the connection has nothing else.
    const unfold = showSystem.value || !own.value.length || system.value.length <= 4;
    out.push({ kind: 'head', label: 'System (built in)', count: system.value.length, toggle: !(!own.value.length || system.value.length <= 4) });
    if (unfold) out.push(...system.value.map(db));
  } else out.push(...(out.length ? [{ kind: 'head', label: `All ${W.value.dbs}`, count: props.databases.length } as Row] : []), ...props.databases.map(db));
  return out;
});
const selectable = computed(() => rows.value.map((r, i) => (r.kind === 'db' ? i : -1)).filter((i) => i >= 0));

// ---- virtual list: fixed row height, only the rows in view (plus a margin) are drawn
const ROW = 28;
const VIEW = 12;
const list = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const first = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW) - 6));
const visible = computed(() => rows.value.slice(first.value, first.value + VIEW + 12).map((r, i) => ({ r, i: first.value + i })));

function show() {
  open.value = true;
  query.value = '';
  showSystem.value = isSystemDb(props.conn.engine, props.modelValue);
  void nextTick(() => {
    const i = rows.value.findIndex((r) => r.kind === 'db' && r.name === props.modelValue);
    activeIndex.value = i >= 0 ? i : (selectable.value[0] ?? 0);
    reveal(true);
    input.value?.focus();
  });
}
function close() {
  open.value = false;
}
const input = ref<HTMLInputElement | null>(null);
watch(query, () => {
  activeIndex.value = selectable.value[0] ?? 0;
  if (list.value) list.value.scrollTop = 0;
  scrollTop.value = 0;
});
function reveal(center = false) {
  const el = list.value;
  if (!el) return;
  const top = activeIndex.value * ROW;
  if (center) el.scrollTop = Math.max(0, top - (VIEW / 2) * ROW);
  else if (top < el.scrollTop) el.scrollTop = top;
  else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  scrollTop.value = el.scrollTop;
}
function move(step: number) {
  const s = selectable.value;
  if (!s.length) return;
  const at = s.indexOf(activeIndex.value);
  activeIndex.value = s[Math.min(s.length - 1, Math.max(0, (at < 0 ? -1 : at) + step))];
  reveal();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') move(1);
  else if (e.key === 'ArrowUp') move(-1);
  else if (e.key === 'PageDown') move(VIEW);
  else if (e.key === 'PageUp') move(-VIEW);
  else if (e.key === 'Enter') {
    const r = rows.value[activeIndex.value];
    if (r?.kind === 'db') pick(r.name);
  } else if (e.key === 'Escape') close();
  else return;
  e.preventDefault();
}

async function savePrefs(p: DvDbPrefs) {
  prefs.value = p;
  prefs.value = (await api.dvSetDbPrefs(props.conn.id, p).catch(() => null)) ?? p;
}
function pick(name: string) {
  close();
  if (name !== props.modelValue) emit('update:modelValue', name);
  void savePrefs({ ...prefs.value, recent: [name, ...prefs.value.recent.filter((d) => d !== name)].slice(0, 8) });
}
function star(name: string) {
  const f = prefs.value.favorites;
  void savePrefs({ ...prefs.value, favorites: f.includes(name) ? f.filter((d) => d !== name) : [...f, name] });
}

/** The name split around the filter text, to bold the match. */
function parts(name: string): [string, string, string] {
  const q = query.value.trim();
  const at = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return at < 0 ? [name, '', ''] : [name.slice(0, at), name.slice(at, at + q.length), name.slice(at + q.length)];
}
</script>

<template>
  <div class="relative min-w-0 flex-1">
    <button type="button" class="select select-sm w-full min-w-0 text-left font-mono text-xs" :title="`Choose a ${W.db} (${keyLabel('mod+P')})`" @click="open ? close() : show()">
      <span class="min-w-0 flex-1 truncate">{{ modelValue || `No ${W.db}` }}</span>
    </button>
    <template v-if="open">
      <div class="fixed inset-0 z-40" @click="close" />
      <div class="dv-pop absolute top-full left-0 z-50 mt-1 w-[17rem]" @keydown="onKey">
        <div class="flex items-center gap-2 border-b border-base-300/60 px-2.5 py-2">
          <svg viewBox="0 0 20 20" class="size-3.5 shrink-0 opacity-50" fill="currentColor"><path d="M8.5 3a5.5 5.5 0 1 0 3.4 9.8l3.6 3.6a1 1 0 0 0 1.4-1.4l-3.6-3.6A5.5 5.5 0 0 0 8.5 3ZM5 8.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0Z" /></svg>
          <input ref="input" v-model="query" class="min-w-0 flex-1 bg-transparent text-xs outline-none" :placeholder="`Search ${databases.length} ${W.dbs}`" spellcheck="false" autocomplete="off" />
          <span class="shrink-0 text-[10px] tabular-nums opacity-45">{{ query.trim() ? `${matches.length} of ${databases.length}` : databases.length }}</span>
        </div>
        <div ref="list" class="relative overflow-y-auto p-1" :style="{ maxHeight: `${VIEW * ROW + 8}px` }" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
          <p v-if="!rows.length" class="px-2 py-3 text-xs opacity-50">{{ query.trim() ? `No ${W.db} matches “${query.trim()}”.` : `No ${W.dbs}.` }}</p>
          <div :style="{ height: `${rows.length * ROW}px` }" class="relative">
            <template v-for="{ r, i } in visible" :key="i">
              <button v-if="r.kind === 'head'" type="button" class="absolute inset-x-0 flex items-center gap-1 px-2 text-[10px] font-semibold tracking-wide uppercase opacity-45" :class="{ 'cursor-pointer hover:opacity-80': r.toggle, 'cursor-default': !r.toggle }" :style="{ top: `${i * ROW}px`, height: `${ROW}px` }" tabindex="-1" @click="r.toggle && (showSystem = !showSystem)">
                <svg v-if="r.toggle" viewBox="0 0 20 20" class="size-3 transition-transform" :class="{ 'rotate-90': showSystem }" fill="currentColor"><path fill-rule="evenodd" d="M7.2 14.8a.75.75 0 0 1 0-1.06L10.94 10 7.2 6.26a.75.75 0 1 1 1.06-1.06l4.27 4.27a.75.75 0 0 1 0 1.06L8.26 14.8a.75.75 0 0 1-1.06 0Z" clip-rule="evenodd" /></svg>
                <span>{{ r.label }}</span>
                <span v-if="r.count !== undefined" class="opacity-70">{{ r.count }}</span>
              </button>
              <div v-else class="group absolute inset-x-0 flex cursor-pointer items-center gap-1.5 rounded-md px-2 font-mono text-xs" :class="{ 'bg-primary/15': i === activeIndex, 'font-semibold': r.name === modelValue, 'opacity-70': r.system }" :style="{ top: `${i * ROW}px`, height: `${ROW}px` }" @mousemove="activeIndex = i" @click="pick(r.name)">
                <span class="w-3 shrink-0 text-primary">{{ r.name === modelValue ? '✓' : '' }}</span>
                <span class="min-w-0 flex-1 truncate">{{ parts(r.name)[0] }}<b class="text-primary">{{ parts(r.name)[1] }}</b>{{ parts(r.name)[2] }}</span>
                <span v-if="r.system && query.trim()" class="shrink-0 font-sans text-[10px] opacity-50">built in</span>
                <button type="button" class="shrink-0 px-0.5 text-sm leading-none" :class="prefs.favorites.includes(r.name) ? 'text-warning' : 'invisible opacity-40 group-hover:visible hover:opacity-100'" :title="prefs.favorites.includes(r.name) ? 'Unstar' : 'Star: keep at the top'" tabindex="-1" @click.stop="star(r.name)">★</button>
              </div>
            </template>
          </div>
        </div>
        <div class="dv-suggest-foot"><span><kbd>↑</kbd><kbd>↓</kbd>move</span><span><kbd>⏎</kbd>open</span><span><kbd>esc</kbd>close</span><span class="flex-1" /><span>★ stars</span></div>
      </div>
    </template>
  </div>
</template>
