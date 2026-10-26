<script lang="ts">
import { ref } from 'vue';
import type { DvAskAnswer, DvAiTurn } from '@shared/types';

/** One exchange as shown: what you asked, then the answer (or the error); step results by index. */
interface Exchange {
  prompt: string;
  answer: DvAskAnswer | null;
  error: string;
  results: Record<number, { ok: boolean; text: string }>;
}
// The conversation outlives the box: a step that opens a screen closes it, and the ✦ button brings it back as it was.
const thread = ref<Exchange[]>([]);
const history = ref<DvAiTurn[]>([]);
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted } from 'vue';
import { aiProvider, type DvAiPreview, type DvAskAction, type DvAskRequest } from '@shared/types';
import { api, settings } from '../store';
import CatMood from './CatMood.vue';
import askMark from '../assets/logos/ask-catzoid.svg';
import { active, tabState, tabs } from './viewer';
import { askConsequence, askDetail, askRisk, runAsk } from './ask';
import devcatzLogo from '../assets/logos/devcatz.png';

/**
 * Ask DBCatz (the ✦ button, ⌘K; TODO §10, after DevCatz's Ask DevCatz): say in
 * plain words what DBCatz should do ("open the orders of shop on production",
 * "back up shop and blog"); the model answers with DBCatz steps you run one by
 * one, or just answers. Connection names, engines and modes and the open
 * database's tables go out; never hosts, users, passwords or rows.
 */
const emit = defineEmits<{ close: [] }>();
const prompt = ref('');
const busy = ref(false);
const running = ref<{ ex: number; step: number } | null>(null);
const shown = ref<DvAiPreview | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
let token = '';

const model = computed(() => {
  const ai = settings.value?.ai;
  if (!ai) return '';
  const info = aiProvider(ai.provider);
  return `${info.name} · ${ai.models[ai.provider] || info.models[0] || '?'}`;
});
const SUGGESTIONS = ['Which table has an email column?', 'Show the newest orders', 'Back up this database', 'Switch to the dark theme', 'Which connections are on production?'];

/** Where the user is: the front tab's connection, database, table. */
function where(): DvAskRequest['where'] {
  const t = tabs.value.find((x) => x.id === active.value);
  if (!t?.connection) return {};
  const s = tabState.get(t.id)?.();
  return { connId: t.connection.id, db: s?.db || undefined, table: s?.table || undefined };
}
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const req = (p: string): DvAskRequest => ({ prompt: p, history: plain(history.value), where: where() });
const errorText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const scrollDown = () => nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' }));

async function send(text = prompt.value) {
  const p = text.trim();
  if (!p || busy.value) return;
  prompt.value = '';
  const ex: Exchange = { prompt: p, answer: null, error: '', results: {} };
  thread.value = [...thread.value, ex];
  busy.value = true;
  token = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  scrollDown();
  try {
    const a = await api.aiAskDbcatz(req(p), token);
    ex.answer = a;
    history.value = [...history.value, { role: 'user', text: p }, { role: 'assistant', text: JSON.stringify(a) }];
  } catch (e) {
    const msg = errorText(e);
    ex.error = msg === 'Stopped' ? 'Stopped.' : msg;
  } finally {
    busy.value = false;
    thread.value = [...thread.value];
    scrollDown();
    void nextTick(() => input.value?.focus());
  }
}
const stop = () => void api.aiCancel(token);
async function showPreview() {
  try {
    shown.value = await api.aiPreviewAskDbcatz(req(prompt.value || '…'));
  } catch (e) {
    thread.value = [...thread.value, { prompt: prompt.value || 'Preview', answer: null, error: errorText(e), results: {} }];
  }
}
function reset() {
  thread.value = [];
  history.value = [];
  input.value?.focus();
}

/** A step that removes data, or a query that changes it, is explained first (Review), then continues. */
const reviewing = ref<{ ex: number; step: number; a: DvAskAction } | null>(null);
const needsReview = (a: DvAskAction) => askRisk(a) === 'danger' || (a.kind === 'run-query' && askRisk(a) === 'write');
function click(ex: number, i: number, a: DvAskAction) {
  if (needsReview(a)) reviewing.value = { ex, step: i, a };
  else void run(ex, i, a);
}

/** Steps that change the screen or open a dialog close the box, so that screen is in front (✦ brings it back). */
async function run(ex: number, i: number, a: DvAskAction) {
  reviewing.value = null;
  running.value = { ex, step: i };
  const e = thread.value[ex];
  try {
    const text = await runAsk(plain(a));
    e.results = { ...e.results, [i]: { ok: true, text } };
    emit('close');
  } catch (err) {
    e.results = { ...e.results, [i]: { ok: false, text: errorText(err) } };
  } finally {
    running.value = null;
    thread.value = [...thread.value];
  }
}

const ICON: Record<string, string> = {
  plug: 'M7 2.5h1.6v3.2h2.8V2.5H13v3.2h1.5v3.4a4.5 4.5 0 0 1-3.7 4.4v4h-1.6v-4a4.5 4.5 0 0 1-3.7-4.4V5.7H7V2.5Z',
  db: 'M10 2.5c3.6 0 6 1.2 6 2.8v9.4c0 1.6-2.4 2.8-6 2.8s-6-1.2-6-2.8V5.3c0-1.6 2.4-2.8 6-2.8Zm0 1.5c-2.9 0-4.4.9-4.4 1.3S7.1 6.6 10 6.6s4.4-.9 4.4-1.3S12.9 4 10 4Zm4.4 3.2c-1 .6-2.6.9-4.4.9s-3.4-.3-4.4-.9V10c0 .4 1.5 1.3 4.4 1.3s4.4-.9 4.4-1.3V7.2Z',
  table: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11ZM4.5 7v2.5h4.75V7H4.5Zm6.25 0v2.5h4.75V7h-4.75ZM4.5 11v2.5h4.75V11H4.5Zm6.25 0v2.5h4.75V11h-4.75Z',
  filter: 'M3 4h14l-5.5 6.5V16l-3 1.5v-7L3 4Z',
  code: 'M7.3 5.3 2.6 10l4.7 4.7 1.1-1.1L4.8 10l3.6-3.6-1.1-1.1Zm5.4 0-1.1 1.1 3.6 3.6-3.6 3.6 1.1 1.1 4.7-4.7-4.7-4.7Z',
  download: 'M9.2 3h1.6v7.7l2.7-2.7 1.1 1.1-4.6 4.6-4.6-4.6 1.1-1.1 2.7 2.7V3ZM4 15h12v1.6H4V15Z',
  upload: 'M10 3 14.6 7.6l-1.1 1.1-2.7-2.7V13.7H9.2V6L6.5 8.7 5.4 7.6 10 3ZM4 15h12v1.6H4V15Z',
  plus: 'M9.2 4h1.6v5.2H16v1.6h-5.2V16H9.2v-5.2H4V9.2h5.2V4Z',
  trash: 'M7.5 2.5h5l.6 1.5H16v1.5H4V4h2.9l.6-1.5ZM5.2 7h9.6l-.7 9.6a1 1 0 0 1-1 .9H6.9a1 1 0 0 1-1-.9L5.2 7Z',
  play: 'M6.3 3.9A1 1 0 0 0 4.8 4.8v10.4a1 1 0 0 0 1.5.9l8.6-5.2a1 1 0 0 0 0-1.8L6.3 3.9Z',
  key: 'M12.5 2.5a5 5 0 0 0-4.8 6.4L2.5 14.1V17.5h3.4v-1.7h1.7v-1.7h1.7l1.4-1.4a5 5 0 1 0 1.8-10.2Zm1.3 2.6a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z',
  list: 'M4 5h12v1.6H4V5Zm0 4.2h12v1.6H4V9.2Zm0 4.2h8v1.6H4v-1.6Z',
  restart: 'M15.3 7.5A6 6 0 1 0 16 11h-1.6a4.4 4.4 0 1 1-.9-3.5L11.5 9.5H17V4l-1.7 3.5Z',
  moon: 'M8.6 2.3a1 1 0 0 1 .2 1.1A6 6 0 0 0 16.6 11a1 1 0 0 1 1.3 1.3A8 8 0 1 1 7.5 2.1a1 1 0 0 1 1.1.2Z',
  pen: 'M13.6 2.9a1.5 1.5 0 0 1 2.1 0l1.4 1.4a1.5 1.5 0 0 1 0 2.1L7.3 16.2 3 17l.8-4.3 9.8-9.8Z',
  gear: 'M8.6 2.5h2.8l.4 2a5.7 5.7 0 0 1 1.4.8l1.9-.7 1.4 2.4-1.5 1.3a5.6 5.6 0 0 1 0 1.6l1.5 1.3-1.4 2.4-1.9-.7a5.7 5.7 0 0 1-1.4.8l-.4 2H8.6l-.4-2a5.7 5.7 0 0 1-1.4-.8l-1.9.7-1.4-2.4L5 10.8a5.6 5.6 0 0 1 0-1.6L3.5 7.9 4.9 5.5l1.9.7a5.7 5.7 0 0 1 1.4-.8l.4-2ZM10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
};
const iconOf = (k: DvAskAction['kind']) =>
  ({
    'open-connection': 'plug', 'new-connection': 'plus', 'edit-connection': 'pen', disconnect: 'plug', 'open-database': 'db', 'open-table': 'table', 'filter-rows': 'filter', 'open-keys': 'key',
    'open-logs': 'list', refresh: 'restart', 'write-query': 'code', 'run-query': 'play', export: 'download', backup: 'download', import: 'upload', 'open-jobs': 'list',
    'create-database': 'plus', 'create-table': 'plus', 'rename-table': 'pen', 'truncate-table': 'trash', 'drop-table': 'trash', 'drop-database': 'trash', 'flush-keys': 'trash',
    'set-theme': 'moon', 'open-settings': 'gear',
  } as Record<string, string>)[k] ?? 'table';

function keydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}
onMounted(() => {
  input.value?.focus();
  scrollDown();
});
</script>

<template>
  <dialog open class="modal modal-open items-start pt-[10vh]" @keydown.esc="shown ? (shown = null) : emit('close')">
    <div class="ask-panel modal-box flex max-h-[76vh] w-[42rem] max-w-[94vw] flex-col p-0">
      <header class="flex items-center gap-3 px-5 pt-4 pb-3">
        <span class="ask-mark" aria-hidden="true"><span><img :src="askMark" alt="" /></span></span>
        <div class="min-w-0 flex-1">
          <h3 class="text-[15px] leading-tight font-semibold tracking-tight">Ask DBCatz</h3>
          <p class="truncate text-xs opacity-55">{{ model }}</p>
        </div>
        <button v-if="thread.length" class="btn btn-ghost btn-xs" title="Start a new conversation" :disabled="busy" @click="reset">New chat</button>
        <button class="btn btn-ghost btn-xs" title="See exactly what is sent; nothing is sent" :disabled="busy" @click="showPreview">Preview</button>
        <button class="btn btn-ghost btn-xs btn-square" title="Close (Esc)" aria-label="Close" @click="emit('close')">✕</button>
      </header>

      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-5">
        <div v-if="!thread.length" class="pt-2 pb-5">
          <p class="text-sm opacity-70">Say what you want in plain words: DBCatz works out the steps, and nothing runs until you press <b>Run</b>. Anything that removes data is explained first and then needs its name typed; Read-only connections refuse every change.</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button v-for="s in SUGGESTIONS" :key="s" class="ask-chip" @click="send(s)">{{ s }}</button>
          </div>
        </div>

        <div v-for="(ex, xi) in thread" :key="xi" class="space-y-3 pb-5">
          <div class="flex justify-end">
            <div class="ask-bubble selectable">{{ ex.prompt }}</div>
          </div>
          <div class="flex gap-3">
            <span class="ask-avatar" aria-hidden="true"><img :src="askMark" alt="" /></span>
            <div class="min-w-0 flex-1 space-y-3 pt-0.5">
              <div v-if="!ex.answer && !ex.error" class="ask-thinking"><span /><span /><span /><em>Working out the steps…</em></div>
              <div v-else-if="ex.error" class="ask-error selectable flex items-start gap-2"><CatMood mood="error" class="size-6 shrink-0" /><span class="min-w-0">{{ ex.error }}</span></div>
              <template v-else-if="ex.answer">
                <p class="selectable text-sm leading-relaxed">{{ ex.answer.explanation }}</p>
                <ol v-if="ex.answer.actions.length" class="ai-steps">
                  <li v-for="(a, i) in ex.answer.actions" :key="i" class="ai-step" :class="{ 'is-done': ex.results[i]?.ok, 'is-failed': ex.results[i] && !ex.results[i].ok, 'is-danger': askRisk(a) === 'danger' }">
                    <span class="ai-step-icon" aria-hidden="true">
                      <span v-if="running?.ex === xi && running.step === i" class="loading loading-spinner loading-xs" />
                      <svg v-else-if="ex.results[i]?.ok" viewBox="0 0 20 20" fill="currentColor"><path d="M8.2 13.3 4.9 10l-1.1 1.1 4.4 4.4 8-8-1.1-1.1-6.9 6.9Z" /></svg>
                      <img v-else-if="a.kind === 'open-devcatz'" :src="devcatzLogo" alt="" class="size-6 rounded-md" draggable="false" />
                      <svg v-else viewBox="0 0 20 20" fill="currentColor"><path :d="ICON[iconOf(a.kind)]" /></svg>
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span v-if="ex.answer.actions.length > 1" class="ai-step-num">{{ i + 1 }}</span>
                        <span class="truncate text-sm font-medium">{{ a.label }}</span>
                      </div>
                      <div v-if="ex.results[i]" class="mt-0.5 text-xs" :class="ex.results[i].ok ? 'text-success' : 'text-error'">{{ ex.results[i].text }}</div>
                       <div v-else-if="(a.kind === 'write-query' || a.kind === 'run-query') && a.args.query" class="mt-1 max-h-24 overflow-auto rounded bg-base-200/60 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap opacity-80">{{ a.args.query }}</div>
                      <div v-else-if="askDetail(a)" class="mt-0.5 truncate font-mono text-[11px] opacity-55">{{ askDetail(a) }}</div>
                    </div>
                    <button class="btn btn-sm shrink-0 gap-1.5" :class="ex.results[i] ? 'btn-ghost' : askRisk(a) === 'danger' ? 'btn-error btn-outline' : 'btn-primary'" :disabled="running !== null" @click="click(xi, i, a)">
                      <img v-if="a.kind === 'open-devcatz' && !ex.results[i]" :src="devcatzLogo" alt="" class="size-4 rounded" draggable="false" />{{ ex.results[i]?.ok ? 'Again' : ex.results[i] ? 'Retry' : needsReview(a) ? 'Review…' : a.kind === 'open-devcatz' ? 'Open DevCatz' : 'Run' }}
                    </button>
                  </li>
                </ol>
              </template>
            </div>
          </div>
        </div>
      </div>

      <footer class="px-4 pt-1 pb-4">
        <div class="ask-composer">
          <textarea ref="input" v-model="prompt" rows="1" class="ask-input" :placeholder="thread.length ? 'Ask a follow-up…' : 'What should DBCatz do? e.g. “open the newest orders on shop”'" :disabled="busy" spellcheck="false" @keydown="keydown" />
          <button v-if="busy" class="ask-send is-stop" title="Stop" aria-label="Stop" @click="stop">
            <svg viewBox="0 0 20 20" fill="currentColor"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" /></svg>
          </button>
          <button v-else class="ask-send" :disabled="!prompt.trim()" title="Send (⏎)" aria-label="Send" @click="send()">
            <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 3.5 4.6 8.9l1.1 1.1 3.5-3.5V16.5h1.6V6.5l3.5 3.5 1.1-1.1L10 3.5Z" /></svg>
          </button>
        </div>
        <p class="mt-2 px-1 text-[11px] opacity-45">⏎ send · ⇧⏎ new line · Esc close · names and structure only: no hosts, passwords or rows</p>
      </footer>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />

    <!-- Review: what a destructive step (or a query that changes data) does, before it continues -->
    <dialog v-if="reviewing" open class="modal modal-open" @keydown.esc.stop="reviewing = null">
      <div class="modal-box w-[32rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-xl" :class="askRisk(reviewing.a) === 'danger' ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'">
            <svg viewBox="0 0 20 20" class="size-5" fill="currentColor"><path d="M8.3 3.1a2 2 0 0 1 3.4 0l6 10.4A2 2 0 0 1 16 16.5H4a2 2 0 0 1-1.7-3l6-10.4ZM10 7a1 1 0 0 0-1 1v3a1 1 0 1 0 2 0V8a1 1 0 0 0-1-1Zm0 6.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z" /></svg>
          </span>
          <div class="min-w-0">
            <h3 class="text-lg font-semibold tracking-tight">{{ reviewing.a.label }}</h3>
            <p class="mt-1 text-sm whitespace-pre-wrap opacity-75">{{ askConsequence(reviewing.a) }}</p>
          </div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="reviewing = null">Cancel</button>
          <button class="btn btn-sm" :class="askRisk(reviewing.a) === 'danger' ? 'btn-error' : 'btn-warning'" @click="run(reviewing.ex, reviewing.step, reviewing.a)">Continue</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="reviewing = null" />
    </dialog>

    <dialog v-if="shown" open class="modal modal-open" @keydown.esc.stop="shown = null">
      <div class="modal-box flex max-h-[85vh] w-[46rem] max-w-[95vw] flex-col gap-3">
        <div>
          <h3 class="text-lg font-semibold tracking-tight">What Ask DBCatz sends</h3>
          <p class="text-sm opacity-65">To {{ shown.provider }} · <span class="font-mono">{{ shown.model }}</span>. Connection names, engines and modes, where you are, and the open database's tables: no hosts, users, passwords or rows.</p>
        </div>
        <pre class="min-h-0 flex-1 overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-[11px] whitespace-pre-wrap">{{ shown.system }}</pre>
        <div class="modal-action mt-0"><button class="btn btn-sm" @click="shown = null">Close</button></div>
      </div>
      <div class="modal-backdrop" @click="shown = null" />
    </dialog>
  </dialog>
</template>
