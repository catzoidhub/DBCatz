<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { DvReport, DvReportKind } from '@shared/types';
import { api, notify } from '../store';
import CatMood from './CatMood.vue';
import { fromFile, prepare, SHOTS_MAX, type Shot } from '../shots';

/**
 * Report a Bug / Send Feedback (Catzoid family #65): the kind, a message, an optional email for a reply, and
 * Preview what is sent (version, macOS, chip, channel — never hosts, queries or data: the main process scrubs it).
 * Send → "Thanks — sent", or kept and sent later when the Catzoid site cannot be reached.
 */
const props = defineProps<{ kind: DvReportKind }>();
const emit = defineEmits<{ close: [] }>();
const KINDS: { id: DvReportKind; label: string; hint: string }[] = [
  { id: 'bug', label: 'Bug', hint: 'What did you do, what happened, what did you expect?' },
  { id: 'idea', label: 'Idea', hint: 'What would make DBCatz better for you?' },
  { id: 'question', label: 'Question', hint: 'Ask anything about DBCatz.' },
];
const kind = ref<DvReportKind>(props.kind);
const message = ref('');
const email = ref('');
const preview = ref<DvReport | null>(null);
const showPreview = ref(false);
const sending = ref(false);
const error = ref('');
const input = ref<HTMLTextAreaElement | null>(null);
onMounted(() => input.value?.focus());

// screenshots on a bug report (Catzoid #67): optional, cleaned in shots.ts, shown before they go
const shots = ref<Shot[]>([]);
const shotError = ref('');
const capturing = ref(false);
const picker = ref<HTMLInputElement | null>(null);
const sendShots = computed(() => (kind.value === 'bug' ? shots.value : []));

async function add(src: string) {
  shotError.value = '';
  try {
    shots.value = [...shots.value, await prepare(src)];
  } catch (e) {
    shotError.value = (e as Error).message;
  }
}
async function pick(e: Event) {
  const el = e.target as HTMLInputElement;
  for (const f of [...(el.files ?? [])].slice(0, SHOTS_MAX - shots.value.length)) {
    try {
      await add(await fromFile(f));
    } catch (err) {
      shotError.value = (err as Error).message;
    }
  }
  el.value = '';
}
/** The window without this dialog: hide it, let a frame paint, capture, show it again. */
async function capture() {
  capturing.value = true;
  await nextTick();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
  try {
    const png = await api.captureWindow();
    capturing.value = false;
    if (png) await add(`data:image/png;base64,${png}`);
  } finally {
    capturing.value = false;
  }
}
const remove = (i: number) => (shots.value = shots.value.filter((_, j) => j !== i));

async function refreshPreview() {
  if (showPreview.value) preview.value = await api.reportPreview(kind.value, message.value, email.value, sendShots.value.length).catch(() => null);
}
watch([kind, message, email, showPreview, () => shots.value.length], () => void refreshPreview());

async function send() {
  if (!message.value.trim() || sending.value) return;
  sending.value = true;
  error.value = '';
  try {
    const r = await api.reportSend(kind.value, message.value, email.value, sendShots.value.map(({ type, data }) => ({ type, data })));
    notify('success', r === 'sent' ? 'Thanks — sent' : 'Saved: it is sent as soon as the Catzoid site can be reached');
    emit('close');
  } catch (e) {
    error.value = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  sending.value = false;
}
</script>

<template>
  <dialog open class="modal modal-open" :class="{ invisible: capturing }" @keydown.esc="!sending && emit('close')">
    <form class="modal-box w-[34rem] max-w-[95vw] space-y-4" @submit.prevent="send">
      <div class="flex items-center gap-3">
        <CatMood :mood="kind === 'bug' ? 'warning' : kind === 'question' ? 'question' : 'info'" class="size-11 shrink-0" />
        <div>
          <h3 class="text-lg font-semibold tracking-tight">{{ kind === 'bug' ? 'Report a bug' : 'Send feedback' }}</h3>
          <p class="text-sm opacity-65">It goes to the DBCatz team through the Catzoid site.</p>
        </div>
      </div>
      <div class="seg">
        <a v-for="k in KINDS" :key="k.id" class="seg-item" :class="{ 'is-active': kind === k.id }" @click="kind = k.id">{{ k.label }}</a>
      </div>
      <textarea ref="input" v-model="message" class="textarea h-36 w-full text-sm" :placeholder="KINDS.find((k) => k.id === kind)?.hint" maxlength="10000" />
      <div v-if="kind === 'bug'" class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="label-caps">Screenshots <span class="normal-case tracking-normal opacity-60">(optional, up to {{ SHOTS_MAX }})</span></span>
          <span class="flex-1" />
          <button type="button" class="btn btn-ghost btn-xs" :disabled="shots.length >= SHOTS_MAX || capturing" @click="capture">Capture this window</button>
          <button type="button" class="btn btn-ghost btn-xs" :disabled="shots.length >= SHOTS_MAX" @click="picker?.click()">Attach a screenshot…</button>
          <input ref="picker" type="file" accept="image/png,image/jpeg" multiple class="hidden" @change="pick" />
        </div>
        <div v-if="shots.length" class="grid grid-cols-3 gap-2">
          <figure v-for="(sh, i) in shots" :key="i + sh.data.length" class="relative overflow-hidden rounded-lg border border-base-300 bg-base-200/50">
            <img :src="sh.url" alt="Screenshot to send" class="aspect-[16/10] w-full object-cover object-top" />
            <figcaption class="flex justify-between px-1.5 py-0.5 font-mono text-[10px] opacity-60">
              <span>{{ sh.width }}×{{ sh.height }}</span><span>{{ Math.max(1, Math.round(sh.bytes / 1024)) }} KB</span>
            </figcaption>
            <button type="button" class="btn btn-circle btn-xs absolute right-1 top-1 opacity-90" title="Remove" aria-label="Remove this screenshot" @click="remove(i)">✕</button>
          </figure>
        </div>
        <p v-if="shots.length" class="text-[12px] text-warning">
          Look at each screenshot before you send it: no table rows, hosts, queries, passwords or customer data. Pictures cannot be
          cleaned like text — what you see is what goes.
        </p>
        <p v-if="shotError" class="text-[12px] text-error">{{ shotError }}</p>
      </div>
      <label class="block">
        <span class="label-caps mb-1 block">Email for a reply <span class="normal-case tracking-normal opacity-60">(optional)</span></span>
        <input v-model="email" type="email" class="input input-sm w-full" placeholder="you@example.com" autocomplete="email" />
      </label>
      <div>
        <button type="button" class="link link-hover text-xs opacity-70" @click="showPreview = !showPreview">{{ showPreview ? 'Hide' : 'Preview' }} what is sent</button>
        <pre v-if="showPreview && preview" class="selectable mt-2 max-h-48 overflow-auto rounded-lg border border-base-300/60 bg-base-200/50 p-3 font-mono text-[11px] leading-relaxed">{{ JSON.stringify(preview, null, 2) }}</pre>
        <p v-if="showPreview" class="mt-1 text-[11px] opacity-55">Hosts, addresses, quoted values and paths in your home folder are replaced before sending. Nothing about your connections or data is added.</p>
      </div>
      <p v-if="error" class="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] text-error">{{ error }}</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="sending" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="sending || !message.trim()"><span v-if="sending" class="loading loading-spinner loading-xs" />{{ error ? 'Retry' : 'Send' }}</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!sending && emit('close')" />
  </dialog>
</template>
