<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DvConnection } from '@shared/types';
import { aiOn, api, init, notify, reportOpen, reportsAsk, settingsTab, showSettings, toast, update, updateOpen } from '../store';
import { DB_LOGO } from '../db';
import { writeAsk, isKv, isProd, isReadOnly, linkWhere, progress, active, closeOtherTabs, closeTab, connections, cycleTab, dispatch, duplicateTab, editing, jobs, openTab, refreshConnections, showJobs, tabs } from './viewer';
import DvHome from './DvHome.vue';
import DvWorkspace from './DvWorkspace.vue';
import DvJobs from './DvJobs.vue';
import DvSettings from './DvSettings.vue';
import AskDbcatz from './AskDbcatz.vue';
import CatMood from './CatMood.vue';
import DvUpdateDialog from './DvUpdateDialog.vue';
import DvReportDialog from './DvReportDialog.vue';
import DvWelcome from './DvWelcome.vue';
import askMark from '../assets/logos/ask-catzoid.svg';
import { back, changed, forward, goTo } from './nav';

/**
 * DBCatz, the database viewer window: a tab strip in the title bar
 * (Connections + one tab per open connection), the home screen (connections
 * list / new connection form) and a workspace per connection.
 */
const props = defineProps<{ connId: string; db?: string; table?: string; col?: string; val?: string }>();
const ready = ref(false);

onMounted(async () => {
  await init();
  await refreshConnections();
  jobs.value = await api.dvJobs();
  const ended = new Set(jobs.value.filter((j) => j.finished).map((j) => j.id));
  api.onViewerJobs((list) => {
    jobs.value = list;
    // Jobs run in the background: say when one ends.
    for (const j of list) {
      if (!j.finished || ended.has(j.id)) continue;
      ended.add(j.id);
      if (j.cancelled) notify('info', `${j.title}: ${j.error}`);
      else if (j.error) notify('error', `${j.title} failed: ${j.error}`);
      else notify('success', j.kind === 'import' ? `${j.title}: done` : `${j.title}: saved to ${j.path?.split('/').pop() ?? ''}`);
    }
  });
  // Braces: a callback's return value crosses the context bridge, and a reactive Map cannot be cloned.
  api.onViewerChanged(() => {
    void refreshConnections();
  });
  api.onViewerProgress((p) => {
    progress.set(p.token, p);
  });
  api.onViewerOpen(({ connId, db, table, col, val }) => open(connId, db ?? undefined, { table: table ?? undefined, col: col ?? undefined, val: val ?? undefined }));
  api.onViewerCommand((c) => {
    if (c.command === 'newConnection') {
      editing.value = null;
      active.value = 'home';
    } else if (c.command === 'openConnection') active.value = 'home';
    else if (c.command === 'closeTab') closeTab(active.value);
    else if (c.command === 'nextTab') cycleTab(1);
    else if (c.command === 'prevTab') cycleTab(-1);
    else if (c.command === 'settings') showSettings.value = !showSettings.value;
    else if (c.command === 'checkUpdates') {
      updateOpen.value = true;
      if (!['available', 'downloading', 'downloaded'].includes(update.value?.status ?? '')) void api.updateCheck();
    } else if (c.command === 'reportBug') reportOpen.value = 'bug';
    else if (c.command === 'sendFeedback') reportOpen.value = 'idea';
    else if (c.command === 'about') {
      settingsTab.value = 'about';
      showSettings.value = true;
    }
    else if (c.command === 'askDbcatz') askOpen.value = askOn.value ? !askOpen.value : false;
    else if (c.command === 'navBack') back();
    else if (c.command === 'navForward') forward();
    else if (c.command === 'selectAll') selectAll(c);
    else dispatch(c);
  });
  window.addEventListener('mouseup', onMouseNav);
  ready.value = true;
  changed();
  if (props.connId) open(props.connId, props.db || undefined, { table: props.table, col: props.col, val: props.val });
});

/** Focuses the connection's tab (made when missing) and, with `db`, switches it to that database. */
/**
 * A dbcatz:// link (DevCatz, DialCatz's "Check in DBCatz"): a connection, a database, a table with a first filter
 * column = value. The filter is built here from the column and value, quoted for the engine — never SQL from the link.
 */
async function open(id: string | null, db?: string, target: { table?: string; col?: string; val?: string } = {}) {
  await refreshConnections();
  if (!id) {
    editing.value = null;
    active.value = 'home';
    return;
  }
  const c = connections.value.find((x) => x.id === id);
  if (!c) {
    active.value = 'home';
    return notify('info', 'The connection in that link is not in DBCatz (it may have been removed or renamed).');
  }
  if (target.table) return openAt(c, db, target.table, target.col, target.val);
  const existing = tabs.value.find((t) => t.connection?.id === id);
  openTab(c, { db });
  if (existing && db) dispatch({ command: 'openDb', db });
}
async function openAt(c: DvConnection, db: string | undefined, table: string, col?: string, val?: string) {
  try {
    if (isKv(c.engine)) {
      // Redis / Valkey: the "table" is a key — list the keys matching it exactly.
      await goTo({ connId: c.id, db });
      return dispatch({ command: 'keysPattern', pattern: table.replace(/[*?[\]\\]/g, '\\$&') });
    }
    const where = col !== undefined ? linkWhere(c.engine, col, val ?? '') : undefined;
    await goTo({ connId: c.id, db, table, mode: 'data', where });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    // The database is there but not the table: stay at the database and say so.
    if (/^No .* called /.test(msg) && db) await goTo({ connId: c.id, db }).catch(() => undefined);
    notify('info', msg);
  }
}

// ---- Ask DBCatz: the ✦ button bottom-right (⌘K), when AI and the Ask DBCatz feature are on
const askOpen = ref(false);
const askOn = aiOn('ask');

/** Edit → Select All (⌘A): text fields select their text; otherwise the front workspace (its table list). */
function selectAll(c: Parameters<typeof dispatch>[0]) {
  const el = document.activeElement as HTMLElement | null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.select();
  if (el?.isContentEditable) return void document.execCommand('selectAll');
  dispatch(c);
}

// ---- back / forward
watch([active, showSettings], changed);
/** Mouse buttons 4 / 5 (back / forward). */
function onMouseNav(e: MouseEvent) {
  if (e.button === 3) back();
  else if (e.button === 4) forward();
  else return;
  e.preventDefault();
}
onBeforeUnmount(() => window.removeEventListener('mouseup', onMouseNav));
function pickTab(id: string) {
  active.value = id;
  showSettings.value = false;
}

const running = computed(() => jobs.value.filter((j) => !j.finished).length);
const askTyped = ref('');
/** Right-click menu of a tab: duplicate, close, close others. */
const tabMenu = ref<{ id: string; x: number; y: number } | null>(null);
function openTabMenu(e: MouseEvent, id: string) {
  if (id === 'home') return;
  tabMenu.value = { id, x: Math.min(e.clientX, window.innerWidth - 200), y: e.clientY + 4 };
}
function menuAct(fn: (id: string) => void) {
  if (tabMenu.value) fn(tabMenu.value.id);
  tabMenu.value = null;
}
</script>

<template>
  <div class="relative flex h-full flex-col bg-base-100 text-sm">
    <!-- Title bar: window drag area with the connection tabs. -->
    <header class="drag flex h-[52px] shrink-0 items-end gap-1 border-b border-base-300/60 pr-4 pl-[88px]">
      <div class="no-drag flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pb-0 [scrollbar-width:none]">
        <button v-for="t in tabs" :key="t.id" class="dv-tab" :class="{ 'is-active': active === t.id }" :style="t.connection?.color ? { '--tab-accent': t.connection.color } : {}" :title="t.connection ? `${t.connection.name} — right-click to duplicate or close` : 'Connections'" @click="pickTab(t.id)" @auxclick.middle.prevent="closeTab(t.id)" @contextmenu.prevent="openTabMenu($event, t.id)">
          <span v-if="t.connection" class="dv-tab-accent" />
          <img v-if="t.connection" :src="DB_LOGO[t.connection.engine]" alt="" class="size-4 rounded bg-white" draggable="false" />
          <svg v-else viewBox="0 0 20 20" class="size-4 opacity-70" fill="currentColor"><path d="M10 2.5c-3.6 0-6.5 1.1-6.5 2.5v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5c0-1.4-2.9-2.5-6.5-2.5Zm0 1.5c3.2 0 5 .9 5 1s-1.8 1-5 1-5-.9-5-1 1.8-1 5-1ZM5 7.3c1.2.5 3 .7 5 .7s3.8-.2 5-.7V10c0 .1-1.8 1-5 1s-5-.9-5-1V7.3Zm0 5c1.2.5 3 .7 5 .7s3.8-.2 5-.7V15c0 .1-1.8 1-5 1s-5-.9-5-1v-2.7Z" /></svg>
          <span class="truncate">{{ t.connection?.name ?? 'Connections' }}</span>
          <span v-if="isProd(t.connection)" class="dv-mode-chip is-prod" title="Production: writes ask first">PROD</span>
          <span v-else-if="isReadOnly(t.connection)" class="dv-mode-chip is-ro" title="Read-only: writes are refused">READ-ONLY</span>
          <span v-if="t.connection" class="dv-tab-close" title="Close tab" @click.stop="closeTab(t.id)">×</span>
        </button>
        <button class="dv-tab-add" title="New connection (⌘N)" @click="editing = null; pickTab('home')">+</button>
      </div>
      <button class="no-drag btn btn-ghost btn-xs mb-1.5 gap-1" :class="{ 'text-primary': running }" title="Export / import / backup jobs" @click="showJobs = !showJobs">
        <span v-if="running" class="loading loading-spinner loading-xs" />
        <svg v-else viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M10 3a1 1 0 0 1 1 1v6.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L9 10.6V4a1 1 0 0 1 1-1ZM4 14a1 1 0 0 1 1 1v1h10v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z" /></svg>
        Jobs<span v-if="jobs.length" class="badge badge-ghost badge-xs">{{ jobs.length }}</span>
      </button>
      <button class="no-drag btn btn-ghost btn-xs btn-square relative mb-1.5" :class="{ 'btn-active': showSettings }" title="Settings (⌘,)" @click="showSettings = !showSettings">
        <span v-if="update?.status === 'available' || update?.status === 'downloaded'" class="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary ring-2 ring-base-100" title="An update is ready" />
        <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clip-rule="evenodd" /></svg>
      </button>
    </header>

    <div v-if="!ready" class="grid flex-1 place-items-center opacity-60"><span class="loading loading-spinner" /></div>
    <template v-else>
      <DvHome v-show="active === 'home'" />
      <DvWorkspace v-for="t in tabs.filter((x) => x.connection)" v-show="active === t.id" :key="t.id" :tab-id="t.id" :connection="t.connection!" :active="active === t.id" :initial-db="t.initialDb" :initial-table="t.initialTable" :initial-mode="t.initialMode" />
    </template>

    <DvSettings v-if="ready && showSettings" @close="showSettings = false" />
    <AskDbcatz v-if="askOpen" @close="askOpen = false" />
    <!-- Ask DBCatz: a floating button bottom-right, in reach from every screen. -->
    <button v-if="ready && askOn && !askOpen" class="ask-fab no-drag" title="Ask DBCatz (⌘K): say what to do in plain words" aria-label="Ask DBCatz" @click="askOpen = true"><span><img :src="askMark" alt="" /></span></button>
    <DvJobs v-if="showJobs" @close="showJobs = false" />
    <DvUpdateDialog v-if="ready && updateOpen" @close="updateOpen = false" />
    <DvReportDialog v-if="ready && reportOpen" :kind="reportOpen" @close="reportOpen = null" />
    <DvWelcome v-if="ready" />

    <!-- Asked once, after the first error: send crash reports? (Catzoid #65) -->
    <dialog v-if="reportsAsk" open class="modal modal-open">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-3">
          <CatMood mood="error" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">DBCatz ran into an error</h3>
            <p class="text-sm opacity-70">Send crash reports so it gets fixed? They carry the error message and where in DBCatz it happened — never hosts, queries or data. Change it any time in Settings → About.</p>
          </div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="api.reportConfigure(false); reportsAsk = false">Don’t send</button>
          <button class="btn btn-primary btn-sm" @click="api.reportConfigure(true); reportsAsk = false">Send crash reports</button>
        </div>
      </div>
    </dialog>

    <!-- Ask before a write (Production, destructive statements) -->
    <dialog v-if="writeAsk" open class="modal modal-open" @keydown.esc="writeAsk.resolve(false)">
      <form class="modal-box w-[32rem] max-w-[95vw] space-y-4" @submit.prevent="(!writeAsk.word || askTyped.trim() === writeAsk.word) && (writeAsk.resolve(true), (askTyped = ''))">
        <div class="flex items-start gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl" :class="writeAsk.tone === 'error' ? 'bg-error/12' : 'bg-warning/12'"><CatMood mood="warning" class="size-8" /></span>
          <div class="min-w-0">
            <h3 class="text-lg font-semibold tracking-tight">{{ writeAsk.title }}</h3>
            <p class="text-sm opacity-65">{{ writeAsk.detail }}</p>
          </div>
        </div>
        <pre v-if="writeAsk.statements.length" class="max-h-48 overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-[11.5px] whitespace-pre-wrap">{{ writeAsk.statements.join('\n\n') }}</pre>
        <label v-if="writeAsk.word" class="block">
          <span class="label-caps mb-1 block">Type <span class="font-mono normal-case tracking-normal opacity-100">{{ writeAsk.word }}</span> to go ahead</span>
          <input v-model="askTyped" class="input input-sm w-full font-mono" :placeholder="writeAsk.word" spellcheck="false" autocomplete="off" autofocus />
        </label>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="writeAsk.resolve(false); askTyped = ''">Cancel</button>
          <button class="btn btn-sm" :class="writeAsk.tone === 'error' ? 'btn-error' : 'btn-warning'" :disabled="!!writeAsk.word && askTyped.trim() !== writeAsk.word">{{ writeAsk.action }}</button>
        </div>
      </form>
      <div class="modal-backdrop" @click="writeAsk.resolve(false); askTyped = ''" />
    </dialog>

    <template v-if="tabMenu">
      <div class="fixed inset-0 z-40" @click="tabMenu = null" @contextmenu.prevent="tabMenu = null" />
      <ul role="menu" class="menu fixed z-50 w-48 rounded-box border border-base-300 bg-base-100 p-1.5 text-sm shadow-xl" :style="{ top: `${tabMenu.y}px`, left: `${tabMenu.x}px` }">
        <li><button @click="menuAct(duplicateTab)">Duplicate tab</button></li>
        <li><button @click="menuAct((id) => { const t = tabs.find((x) => x.id === id); if (t?.connection) openTab(t.connection, { fresh: true }); })">New tab, same connection</button></li>
        <li class="menu-title mt-1 px-2 text-[10px] opacity-40">Close</li>
        <li><button @click="menuAct(closeTab)">Close tab</button></li>
        <li><button @click="menuAct(closeOtherTabs)">Close other tabs</button></li>
      </ul>
    </template>

    <div v-if="toast" class="toast toast-end z-50" :class="{ 'is-beside-fab': askOn && !askOpen }">
      <div role="alert" class="alert alert-soft shadow-lg" :class="{ 'alert-error': toast.kind === 'error', 'alert-success': toast.kind === 'success', 'alert-info': toast.kind === 'info' }">
        <CatMood :mood="toast.kind" class="-my-1 size-8 shrink-0" />
        <span class="max-w-md text-sm">{{ toast.text }}</span>
        <button class="btn btn-ghost btn-xs" @click="toast = null">✕</button>
      </div>
    </div>
  </div>
</template>
