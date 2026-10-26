<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../store';
import { jobs } from './viewer';

/** The export / import / backup jobs of this window, newest first. */
const emit = defineEmits<{ close: [] }>();
const pct = (j: { done: number; total: number }) => (j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0);
const finished = computed(() => jobs.value.filter((j) => j.finished).length);
/** Finished jobs leave the list (one, or all); running ones cannot be removed. */
async function clear(ids?: string[]) {
  jobs.value = await api.dvClearJobs(ids);
}
</script>

<template>
  <div class="fixed inset-0 z-40" @click="emit('close')">
    <div class="absolute top-14 right-4 w-[380px] rounded-box border border-base-300 bg-base-100 p-3 shadow-xl" @click.stop>
      <div class="mb-2 flex items-center gap-2 px-1">
        <h3 class="font-semibold">Jobs</h3>
        <span class="flex-1" />
        <button v-if="finished" class="btn btn-ghost btn-xs" :title="`Remove the ${finished} finished job${finished === 1 ? '' : 's'} from the list (files stay where they are)`" @click="clear()">Clear finished</button>
        <button class="btn btn-ghost btn-xs" @click="emit('close')">✕</button>
      </div>
      <p v-if="!jobs.length" class="px-1 py-4 text-center text-xs opacity-50">Exports, imports and backups show their progress here.</p>
      <ul class="max-h-[60vh] space-y-2 overflow-y-auto">
        <li v-for="j in jobs" :key="j.id" class="rounded-lg border border-base-300/60 p-2.5">
          <div class="flex items-center gap-2">
            <span class="loading loading-spinner loading-xs" v-if="!j.finished" />
            <span v-else-if="j.cancelled" class="opacity-60">⏹</span>
            <span v-else-if="j.error" class="text-error">✕</span>
            <span v-else class="text-success">✓</span>
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ j.title }}</span>
            <button v-if="j.path && !j.error" class="btn btn-ghost btn-xs" @click="api.dvReveal(j.path)">Reveal</button>
            <button v-if="!j.finished" class="btn btn-ghost btn-xs text-error" :disabled="j.detail === 'Stopping…'" :title="j.kind === 'import' ? 'Stop the import (rows already imported stay)' : 'Stop and remove the partial file'" @click="api.dvCancelJob(j.id)">Cancel</button>
            <button v-if="j.finished" class="btn btn-ghost btn-xs btn-square opacity-60 hover:opacity-100" title="Remove from the list (the file stays)" @click="clear([j.id])">✕</button>
          </div>
          <div class="mt-1 truncate font-mono text-[11px] opacity-60" :class="{ 'text-error opacity-100': j.error && !j.cancelled }">{{ j.error ?? j.detail }}</div>
          <progress v-if="!j.finished" class="progress progress-primary mt-1.5 h-1 w-full" :value="j.total ? pct(j) : undefined" max="100" />
        </li>
      </ul>
    </div>
  </div>
</template>
