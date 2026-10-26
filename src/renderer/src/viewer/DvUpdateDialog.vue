<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, attempt, update } from '../store';
import { connections, jobs } from './viewer';
import icon from '../assets/logos/dbcatz.png';

/**
 * In-app updates (Catzoid family #54): What's New for the version found (Update now / Later / Skip this version),
 * the download's progress (Cancel), then Restart now / Install when I quit — after saying what a restart closes.
 * Also "You're up to date" and errors, with a link to the download on the Catzoid site.
 */
const emit = defineEmits<{ close: [] }>();
const u = computed(() => update.value);
const confirming = ref(false);

const mb = (b?: number) => (b ? `${(b / 1048576).toFixed(b > 104857600 ? 0 : 1)} MB` : '');
const speed = computed(() => (u.value?.progress?.bytesPerSecond ? `${mb(u.value.progress.bytesPerSecond)}/s` : ''));
const left = computed(() => {
  const p = u.value?.progress;
  if (!p?.bytesPerSecond || !p.total) return '';
  const s = Math.max(0, Math.round((p.total - p.transferred) / p.bytesPerSecond));
  return s > 90 ? `${Math.round(s / 60)} min left` : `${s} s left`;
});
const when = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

/** Release notes as light Markdown: headings, bullets, bold, inline code; everything else as text. */
const notes = computed(() => {
  const text = (u.value?.notes ?? '').replace(/<[^>]+>/g, '').trim();
  return text.split('\n').map((line) => {
    const h = line.match(/^#{1,4}\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    return { kind: h ? 'h' : li ? 'li' : line.trim() ? 'p' : 'gap', parts: inline(h?.[1] ?? li?.[1] ?? line) };
  });
});
function inline(s: string): { text: string; b?: boolean; code?: boolean }[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((t) => (t.startsWith('**') ? { text: t.slice(2, -2), b: true } : t.startsWith('`') ? { text: t.slice(1, -1), code: true } : { text: t }));
}

/** What a restart closes: running jobs and open connections. */
const busy = computed(() => {
  const out: string[] = [];
  const running = jobs.value.filter((j) => !j.finished).length;
  if (running) out.push(`${running} running ${running === 1 ? 'job' : 'jobs'} (export, import or backup) will stop`);
  const open = connections.value.filter((c) => c.connected).length;
  if (open) out.push(`${open} open ${open === 1 ? 'connection closes' : 'connections close'}`);
  return out;
});
async function restart() {
  if (busy.value.length && !confirming.value) {
    confirming.value = true;
    return;
  }
  await attempt(() => api.updateInstall(true));
}
async function later() {
  if (u.value?.status === 'downloaded') await attempt(() => api.updateInstall(false));
  emit('close');
}
async function skip() {
  if (u.value?.version) await attempt(() => api.updateSkip(u.value!.version!));
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="u?.status !== 'downloading' && emit('close')">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <div class="flex items-center gap-3">
        <img :src="icon" alt="" class="size-12 shrink-0 drop-shadow-sm" draggable="false" />
        <div class="min-w-0 flex-1">
          <h3 class="text-lg font-semibold tracking-tight">
            <template v-if="u?.status === 'available'">DBCatz {{ u.version }} is available</template>
            <template v-else-if="u?.status === 'downloading'">Downloading DBCatz {{ u.version }}…</template>
            <template v-else-if="u?.status === 'downloaded'">Ready to install DBCatz {{ u.version }}</template>
            <template v-else-if="u?.status === 'checking'">Checking for updates…</template>
            <template v-else-if="u?.status === 'error'">Could not update</template>
            <template v-else>You’re up to date</template>
          </h3>
          <p class="text-sm opacity-65">
            <template v-if="u?.status === 'available'">You have {{ u.current }}<template v-if="u.size"> · download {{ mb(u.size) }}</template></template>
            <template v-else-if="u?.status === 'none' || u?.status === 'idle'">DBCatz {{ u?.current }} is the newest version. Last checked {{ when(u?.lastChecked) }}.</template>
            <template v-else-if="u?.status === 'downloaded'">It installs when DBCatz restarts.</template>
            <template v-else-if="u?.status === 'error'">{{ u.error }}</template>
          </p>
        </div>
      </div>

      <div v-if="u?.status === 'available' && notes.length" class="max-h-72 overflow-y-auto rounded-xl border border-base-300/60 bg-base-200/40 px-4 py-3 text-sm leading-relaxed">
        <p class="label-caps mb-2">What’s new</p>
        <template v-for="(n, i) in notes" :key="i">
          <p v-if="n.kind === 'h'" class="mt-2 font-semibold first:mt-0"><span v-for="(p, j) in n.parts" :key="j" :class="{ 'font-mono text-xs': p.code }">{{ p.text }}</span></p>
          <p v-else-if="n.kind === 'li'" class="flex gap-2 pl-1"><span class="opacity-50">•</span><span><span v-for="(p, j) in n.parts" :key="j" :class="{ 'font-semibold': p.b, 'font-mono text-xs': p.code }">{{ p.text }}</span></span></p>
          <p v-else-if="n.kind === 'p'"><span v-for="(p, j) in n.parts" :key="j" :class="{ 'font-semibold': p.b, 'font-mono text-xs': p.code }">{{ p.text }}</span></p>
          <div v-else class="h-1.5" />
        </template>
      </div>

      <div v-if="u?.status === 'downloading'" class="space-y-1.5">
        <progress class="progress progress-primary w-full" :value="u.progress?.percent ?? 0" max="100" />
        <p class="flex justify-between text-xs opacity-65">
          <span>{{ mb(u.progress?.transferred) || '0 MB' }} of {{ mb(u.progress?.total || u.size) }}<template v-if="speed"> · {{ speed }}</template></span>
          <span>{{ (u.progress?.percent ?? 0) >= 99.5 ? 'Verifying…' : left }}</span>
        </p>
      </div>

      <div v-if="confirming" class="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]">
        <p class="font-medium">Restarting now:</p>
        <ul class="mt-1 list-disc pl-5"><li v-for="b in busy" :key="b">{{ b }}</li></ul>
      </div>

      <div class="modal-action mt-2 flex-wrap">
        <template v-if="u?.status === 'available'">
          <button class="btn btn-ghost btn-sm mr-auto" @click="skip">Skip this version</button>
          <button class="btn btn-ghost btn-sm" @click="emit('close')">Later</button>
          <button class="btn btn-primary btn-sm" @click="api.updateDownload()">Update now</button>
        </template>
        <template v-else-if="u?.status === 'downloading'">
          <button class="btn btn-ghost btn-sm" @click="api.updateCancel()">Cancel</button>
          <button class="btn btn-sm" @click="emit('close')">Hide</button>
        </template>
        <template v-else-if="u?.status === 'downloaded'">
          <button class="btn btn-ghost btn-sm" @click="later">Install when I quit</button>
          <button class="btn btn-primary btn-sm" @click="restart">{{ confirming ? 'Restart anyway' : 'Restart now' }}</button>
        </template>
        <template v-else-if="u?.status === 'error'">
          <button class="btn btn-ghost btn-sm mr-auto" @click="api.openUrl(u.downloadUrl)">Download from the site</button>
          <button class="btn btn-ghost btn-sm" @click="emit('close')">Close</button>
          <button class="btn btn-primary btn-sm" @click="api.updateCheck()">Retry</button>
        </template>
        <button v-else class="btn btn-primary btn-sm" @click="emit('close')">OK</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="u?.status !== 'downloading' && emit('close')" />
  </dialog>
</template>
