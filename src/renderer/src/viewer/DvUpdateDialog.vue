<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api, attempt, settings, update, updateDialogAuto } from '../store';
import { openCommunity, openDonate } from '../support';
import { connections, jobs } from './viewer';
import CatMood from './CatMood.vue';
import dbcatzLogo from '../assets/logos/dbcatz.png';

/**
 * DBCatz's update (Catzoid #54), the same dialog as DevCatz's UpdateDialog.vue (the four apps alike, user 2026-11-18):
 * What's New (the notes of every version since the installed one), then the download (percent, MB of MB, speed, time
 * left, Cancel), then Restart now / Install when I quit. Errors in plain words with Retry and the site's download page.
 * Before the restart it says what stops: running jobs and open connections.
 */
const emit = defineEmits<{ close: [] }>();
const u = computed(() => update.value);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
const left = computed(() => {
  const p = u.value?.progress;
  if (!p || !p.bytesPerSecond) return '';
  const s = Math.max(0, Math.round((p.total - p.transferred) / p.bytesPerSecond));
  return s < 60 ? `${s} s left` : `${Math.ceil(s / 60)} min left`;
});
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/** A small, safe Markdown: headings, lists, bold, code, links (text only); everything else as text. */
function md(src: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t: string) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const out: string[] = [];
  let list = false;
  // The GitHub fallback feed sends HTML: its tags go, the text stays.
  for (const line of src.replace(/<\/(p|li|h\d)>/g, '\n').replace(/<li>/g, '- ').replace(/<[^>]+>/g, '').split('\n')) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) out.push('</ul>');
    list = false;
    // "> note" (a quote in the release notes): shown as a plain paragraph, without the ">".
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      if (q[1].trim()) out.push(`<p class="opacity-80">${inline(q[1])}</p>`);
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

/** What a restart stops: running jobs and open connections. */
const running = computed(() => jobs.value.filter((j) => !j.finished).length);
const open = computed(() => connections.value.filter((c) => c.connected).length);
const stops = computed(() => {
  const parts: string[] = [];
  if (running.value) parts.push(`stops ${running.value} running job${running.value === 1 ? '' : 's'} (export, import or backup)`);
  if (open.value) parts.push(`closes ${open.value} open connection${open.value === 1 ? '' : 's'}`);
  return parts.length ? `Restarting ${parts.join(' and ')}; it takes a few seconds.` : '';
});

const check = () => attempt(() => api.updateCheck());
const download = () => attempt(() => api.updateDownload());
const restart = () => attempt(() => api.updateInstall(true));
async function later() {
  if (u.value?.status === 'downloaded') await attempt(() => api.updateInstall(false));
  emit('close');
}
async function skip() {
  if (u.value?.version) await attempt(() => api.updateSkip(u.value!.version!));
  emit('close');
}
const close = () => emit('close');

/** What's New starts at the newest version's first line, not wherever focus scrolled it. */
const notesBox = ref<HTMLElement | null>(null);
watch(
  () => u.value?.version,
  () => void nextTick(() => notesBox.value && (notesBox.value.scrollTop = 0)),
  { immediate: true },
);
/** The newest version's notes did not come (a failed request, the site not caught up yet): ask again on open. */
const notesMissing = computed(() => !!u.value?.version && !u.value.notes?.find((n) => n.version === u.value?.version)?.notes.trim());
onMounted(() => {
  if (notesMissing.value) void attempt(() => api.updateNotes());
});
/** What's New lists the notes; with none at all it still shows the newest version and the site link. */
const notes = computed(() => (u.value?.notes?.length ? u.value.notes : u.value?.version ? [{ version: u.value.version, date: u.value.releaseDate ?? null, notes: '' }] : []));
/** "Don't open this on its own" (Catzoid #97), shown when the dialog opened by itself; Settings → Updates has it too. */
/**
 * Support Catzoid at the end of What's New (Catzoid #94, as DevCatz 058fc2e): one quiet line, the same links as
 * Settings → About. Gone once the corner card is done with (joined, donated, rated or "Don't show again": supportOff).
 */
const supportLine = computed(() => !settings.value?.supportOff);
const quiet = (off: boolean) => attempt(() => api.updateConfigure({ dialog: !off }));
</script>

<template>
  <dialog v-if="u" open class="modal modal-open" @keydown.esc="u.status !== 'downloading' && close()">
    <div class="modal-box w-[36rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-4">
        <img :src="dbcatzLogo" alt="" class="size-14 shrink-0 drop-shadow-md" draggable="false" />
        <div class="min-w-0 flex-1 space-y-0.5">
          <h3 class="text-lg font-semibold tracking-tight">
            <template v-if="u.status === 'checking'">Looking for updates…</template>
            <template v-else-if="u.status === 'none'">You're up to date</template>
            <template v-else-if="u.status === 'downloaded'">DBCatz {{ u.version }} is ready to install</template>
            <template v-else-if="u.status === 'error'">The update did not work</template>
            <template v-else-if="u.version">DBCatz {{ u.version }} is available</template>
            <template v-else>Updates</template>
          </h3>
          <p class="text-sm opacity-60">
            You have {{ u.current }}<template v-if="u.version && u.status !== 'none'"> · new: {{ u.version }}<template v-if="u.size"> · {{ mb(u.size) }}</template></template>
          </p>
        </div>
      </div>

      <!-- What's New -->
      <div v-if="notes.length && (u.status === 'available' || u.status === 'downloading' || u.status === 'downloaded')" ref="notesBox" class="update-notes max-h-72 space-y-4 overflow-y-auto rounded-box bg-base-200/60 px-4 py-3 text-sm">
        <section v-for="n in notes" :key="n.version">
          <div class="mb-1 flex items-baseline gap-2">
            <span class="font-semibold">{{ n.version }}</span>
            <span class="text-xs opacity-50">{{ date(n.date) }}</span>
          </div>
          <div v-if="n.notes.trim()" class="selectable" v-html="md(n.notes)" />
          <p v-else class="opacity-60">
            The notes did not load yet.
            <button type="button" class="link link-hover" @click="u.notesUrl && api.openUrl(u.notesUrl)">Read them on the site</button>
          </p>
        </section>
        <p v-if="supportLine" class="border-t border-base-300/60 pt-3 text-xs opacity-60">
          Catzoid is free and open source.
          <button type="button" class="link" @click="openCommunity">Joining the community</button> already helps a lot — or
          <button type="button" class="link" @click="openDonate">support us</button> if you like.
        </p>
      </div>

      <!-- Download -->
      <div v-if="u.status === 'downloading' && u.progress" class="space-y-1.5">
        <progress class="progress progress-primary w-full" :value="u.progress.percent" max="100" />
        <div class="flex justify-between text-xs opacity-60">
          <span>{{ Math.floor(u.progress.percent) }}% · {{ mb(u.progress.transferred) }} of {{ mb(u.progress.total || u.size || 0) }}</span>
          <span>{{ u.progress.bytesPerSecond ? `${mb(u.progress.bytesPerSecond)}/s · ${left}` : 'Starting…' }}</span>
        </div>
        <p v-if="u.progress.percent >= 100" class="text-xs opacity-60">Verifying…</p>
      </div>

      <!-- Before the restart: what stops -->
      <div v-if="u.status === 'downloaded'" role="alert" class="alert alert-info alert-soft text-sm">
        <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
        <span v-if="stops">{{ stops }}</span>
        <span v-else>Nothing is running: the restart takes a few seconds.</span>
      </div>

      <div v-if="u.status === 'none'" class="flex items-center gap-3 text-sm">
        <CatMood mood="success" class="size-8 shrink-0" />
        <span>DBCatz {{ u.current }} is the newest version{{ u.settings.channel === 'beta' ? ' (Beta channel)' : '' }}.</span>
      </div>
      <div v-if="u.status === 'error'" role="alert" class="alert alert-error alert-soft text-sm">
        <CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
        <span>{{ u.error }}</span>
      </div>

      <div class="modal-action flex-wrap items-center">
        <label v-if="updateDialogAuto && (u.status === 'available' || u.status === 'downloaded')" class="mr-auto flex cursor-pointer items-center gap-2 text-xs opacity-70">
          <input type="checkbox" class="checkbox checkbox-xs" :checked="u.settings.dialog === false" @change="quiet(($event.target as HTMLInputElement).checked)" />
          Don't open this on its own
        </label>
        <template v-if="u.status === 'available'">
          <button type="button" class="btn btn-ghost btn-sm" @click="skip">Skip this version</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Later</button>
          <button type="button" class="btn btn-primary btn-sm" @click="download">Update now</button>
        </template>
        <template v-else-if="u.status === 'downloading'">
          <button type="button" class="btn btn-ghost btn-sm" @click="api.updateCancel()">Cancel</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Hide</button>
        </template>
        <template v-else-if="u.status === 'downloaded'">
          <button type="button" class="btn btn-ghost btn-sm" @click="later">Install when I quit</button>
          <button type="button" class="btn btn-primary btn-sm" @click="restart">Restart now</button>
        </template>
        <template v-else-if="u.status === 'error'">
          <button type="button" class="btn btn-ghost btn-sm" @click="api.openUrl(u.downloadUrl)">Download from the site</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Close</button>
          <button type="button" class="btn btn-primary btn-sm" @click="u.version ? download() : check()">Retry</button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="u.status === 'checking'" @click="check"><span v-if="u.status === 'checking'" class="loading loading-spinner loading-xs" />Check again</button>
          <button type="button" class="btn btn-primary btn-sm" @click="close">OK</button>
        </template>
      </div>
    </div>
    <div class="modal-backdrop" @click="u.status !== 'downloading' && close()" />
  </dialog>
</template>

<style scoped>
.update-notes :deep(h4) {
  margin: 0.5rem 0 0.25rem;
  font-weight: 600;
}
.update-notes :deep(ul) {
  list-style: disc;
  padding-left: 1.25rem;
}
.update-notes :deep(p),
.update-notes :deep(li) {
  margin: 0.15rem 0;
  line-height: 1.5;
}
.update-notes :deep(code) {
  font-size: 0.85em;
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  background: oklch(from var(--color-base-content) l c h / 0.08);
}
</style>
