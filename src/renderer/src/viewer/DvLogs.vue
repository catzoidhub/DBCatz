<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { DvAiPreview, DvConnection, DvLogAnswer, DvLogEntry } from '@shared/types';
import { aiOn, api, notify } from '../store';
import { activity, dispatch, fmtMs, type Activity } from './viewer';

/**
 * Log of one connection: what DBCatz did here (queries, edits, DDL — with
 * timing, rows affected and errors). A DevCatz service's own server log lives
 * in DevCatz (Database page → Logs). Ask AI (Settings → AI → Ask AI in Logs)
 * explains an error or a slow statement and writes the fixed query, which
 * opens in the Query tab and never runs by itself.
 */
const props = defineProps<{ conn: DvConnection; db: string }>();
const filter = ref('');
const onlyErrors = ref(false);
const list = computed(() => {
  const all = activity.get(props.conn.id) ?? [];
  const q = filter.value.toLowerCase();
  return all.filter((a) => (!onlyErrors.value || a.error) && (!q || a.text.toLowerCase().includes(q) || a.error?.toLowerCase().includes(q)));
});
const clear = () => activity.set(props.conn.id, []);
const when = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });

// ---- Ask AI
const on = aiOn('logs');
const open = ref(false);
const prompt = ref('');
const busy = ref(false);
const answer = ref<DvLogAnswer | null>(null);
const error = ref('');
/** The lines the answer is about (one row's Ask AI, or the list's errors / newest lines). */
const about = ref<Activity[]>([]);
const shown = ref<DvAiPreview | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
let token = '';

const entry = (a: Activity): DvLogEntry => ({ text: a.text, error: a.error, ms: a.ms, affected: a.affected });
/** Without a row: the errors in view (up to 20), else the 10 newest lines. */
function pick(): Activity[] {
  const errors = list.value.filter((a) => a.error).slice(0, 20);
  return errors.length ? errors : list.value.slice(0, 10);
}
const errorText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function openBox() {
  open.value = true;
  void nextTick(() => input.value?.focus());
}
async function ask(rows?: Activity[]) {
  if (busy.value) return;
  about.value = rows ?? pick();
  if (!about.value.length) return notify('info', 'Nothing in the log to ask about yet');
  open.value = true;
  busy.value = true;
  error.value = '';
  answer.value = null;
  token = `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    answer.value = await api.aiExplainLog(props.conn.id, { db: props.db, entries: about.value.map(entry), prompt: prompt.value }, token);
  } catch (e) {
    const msg = errorText(e);
    error.value = msg === 'Stopped' ? '' : msg;
  } finally {
    busy.value = false;
  }
}
const stop = () => void api.aiCancel(token);
async function showPreview() {
  const rows = about.value.length ? about.value : pick();
  try {
    shown.value = await api.aiPreviewLog(props.conn.id, { db: props.db, entries: rows.map(entry), prompt: prompt.value });
  } catch (e) {
    error.value = errorText(e);
  }
}
/** The fixed query into a new Query editor of this connection (not run). */
function openInQuery() {
  if (answer.value?.query) dispatch({ command: 'queryText', text: answer.value.query });
}
async function copy() {
  if (!answer.value?.query) return;
  await navigator.clipboard.writeText(answer.value.query);
  notify('success', 'Copied');
}
function keydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void ask();
  } else if (e.key === 'Escape') open.value = false;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b border-base-300/60 px-3">
      <span class="label-caps">Activity</span>
      <input v-model="filter" class="input input-xs w-48 font-mono" placeholder="Filter" spellcheck="false" />
      <label class="flex cursor-pointer items-center gap-1 text-xs"><input v-model="onlyErrors" type="checkbox" class="checkbox checkbox-xs" />Errors only</label>
      <span class="flex-1" />
      <span class="text-xs opacity-50">{{ list.length }} of {{ (activity.get(conn.id) ?? []).length }}</span>
      <button v-if="on" class="btn btn-ghost btn-xs gap-1" :class="{ 'btn-active': open }" title="Ask AI about this log: errors, slow statements" @click="open ? (open = false) : openBox()">
        <svg viewBox="0 0 20 20" class="size-3.5 text-primary" fill="currentColor"><path d="M10 2.5a.75.75 0 0 1 .7.48l1.3 3.38 3.38 1.3a.75.75 0 0 1 0 1.4L12 10.36l-1.3 3.38a.75.75 0 0 1-1.4 0L8 10.36 4.62 9.06a.75.75 0 0 1 0-1.4L8 6.36l1.3-3.38a.75.75 0 0 1 .7-.48ZM15.5 12a.5.5 0 0 1 .47.33l.5 1.2 1.2.5a.5.5 0 0 1 0 .94l-1.2.5-.5 1.2a.5.5 0 0 1-.94 0l-.5-1.2-1.2-.5a.5.5 0 0 1 0-.94l1.2-.5.5-1.2a.5.5 0 0 1 .47-.33Z" /></svg>Ask AI
      </button>
      <button class="btn btn-ghost btn-xs" :disabled="!(activity.get(conn.id) ?? []).length" @click="clear">Clear</button>
    </div>

    <!-- Ask AI about the log -->
    <div v-if="on && open" class="max-h-[55%] shrink-0 overflow-y-auto border-b border-base-300/60 bg-primary/[0.04] px-3 py-2.5">
      <div class="flex items-start gap-2">
        <textarea ref="input" v-model="prompt" rows="1" class="textarea textarea-sm min-h-0 flex-1 resize-none py-1.5 text-[13px] leading-snug" placeholder="Ask about the log: “why did the last query fail?”, “why is this slow?” — or just press Ask to explain the errors" :disabled="busy" spellcheck="false" @keydown="keydown" />
        <button v-if="busy" class="btn btn-sm" title="Stop" @click="stop"><span class="loading loading-spinner loading-xs" />Stop</button>
        <button v-else class="btn btn-primary btn-sm" title="Explain (⏎)" @click="ask()">Ask</button>
        <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" @click="open = false">✕</button>
      </div>
      <div class="mt-1.5 flex items-center gap-3 text-[11px] opacity-55">
        <span>{{ about.length ? `About ${about.length} line${about.length === 1 ? '' : 's'} of the log` : `Without a row: the errors in view, else the newest lines` }} · obvious secrets are masked</span>
        <span class="flex-1" />
        <a class="link" @click="showPreview">Preview what is sent</a>
      </div>
      <div v-if="busy" class="ask-thinking mt-2"><span /><span /><span /><em>Reading the log…</em></div>
      <div v-else-if="error" class="ask-error mt-2 text-xs">{{ error }}</div>
      <div v-else-if="answer" class="mt-2 space-y-2 text-sm">
        <p class="font-medium">{{ answer.summary }}</p>
        <p v-if="answer.cause" class="opacity-80">{{ answer.cause }}</p>
        <ol v-if="answer.steps.length" class="list-decimal space-y-0.5 pl-5 text-[13px] opacity-80">
          <li v-for="(s, i) in answer.steps" :key="i">{{ s }}</li>
        </ol>
        <div v-if="answer.query" class="rounded-lg border border-base-300/60 bg-base-100">
          <pre class="max-h-40 overflow-auto px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap">{{ answer.query }}</pre>
          <div class="flex items-center gap-2 border-t border-base-300/60 px-2 py-1">
            <span class="text-[11px] opacity-55">Not run: check it in the Query tab, then press Run</span>
            <span class="flex-1" />
            <button class="btn btn-ghost btn-xs" @click="copy">Copy</button>
            <button class="btn btn-primary btn-xs" @click="openInQuery">Open in Query</button>
          </div>
        </div>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <p v-if="!list.length" class="p-8 text-center text-sm opacity-50">{{ (activity.get(conn.id) ?? []).length ? 'Nothing matches.' : 'Queries you run and rows you change on this connection are listed here, newest first.' }}</p>
      <table v-else class="dv-grid w-full">
        <thead>
          <tr>
            <th class="w-20">Time</th>
            <th>What</th>
            <th class="w-20 text-right">Rows</th>
            <th class="w-20 text-right">Took</th>
            <th v-if="on" class="w-20" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(a, i) in list" :key="i" class="group" :class="{ 'text-error': a.error, 'bg-primary/10': about.length === 1 && about[0] === a }">
            <td class="tabular-nums opacity-60">{{ when(a.time) }}</td>
            <td class="!max-w-none !whitespace-pre-wrap" :title="a.error ?? a.text"><span>{{ a.text }}</span><span v-if="a.error" class="block text-[11px] opacity-80">✕ {{ a.error }}</span></td>
            <td class="text-right tabular-nums opacity-70">{{ a.affected ?? '' }}</td>
            <td class="text-right tabular-nums opacity-70">{{ a.ms === null ? '' : fmtMs(a.ms) }}</td>
            <td v-if="on" class="text-right">
              <button class="btn btn-ghost btn-xs gap-1" :class="a.error ? '' : 'invisible group-hover:visible'" :disabled="busy" :title="a.error ? 'Ask AI why this failed and how to fix it' : 'Ask AI about this statement (e.g. why it is slow)'" @click="ask([a])">✦ Ask AI</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <dialog v-if="shown" open class="modal modal-open" @keydown.esc="shown = null">
      <div class="modal-box flex max-h-[85vh] w-[46rem] max-w-[95vw] flex-col gap-3">
        <div>
          <h3 class="text-lg font-semibold tracking-tight">What Ask AI in Logs sends</h3>
          <p class="text-sm opacity-65">To {{ shown.provider }} · <span class="font-mono">{{ shown.model }}</span>. The log lines (obvious secrets masked) and the structure of the tables they use; no connection settings or passwords.</p>
        </div>
        <pre class="min-h-0 flex-1 overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-[11px] whitespace-pre-wrap">{{ shown.system }}

You: {{ shown.messages[shown.messages.length - 1]?.text }}</pre>
        <div class="modal-action mt-0"><button class="btn btn-sm" @click="shown = null">Close</button></div>
      </div>
      <div class="modal-backdrop" @click="shown = null" />
    </dialog>
  </div>
</template>
