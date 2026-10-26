<script setup lang="ts">
import { computed } from 'vue';
import type { DvUpdateChannel } from '@shared/types';
import { api, update, updateOpen } from '../store';

/** Settings → Updates (Catzoid family #54), laid out like DialCatz's: version and Check now, then the switches. */
const u = computed(() => update.value);
const lastChecked = computed(() => (u.value?.lastChecked ? new Date(u.value.lastChecked).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never'));
const CHANNELS: { id: DvUpdateChannel; label: string }[] = [
  { id: 'stable', label: 'Stable' },
  { id: 'beta', label: 'Beta' },
];
const waiting = computed(() => ['available', 'downloading', 'downloaded'].includes(u.value?.status ?? ''));
const line = computed(() => {
  const s = u.value?.status;
  if (s === 'available') return `DBCatz ${u.value!.version} is available`;
  if (s === 'downloading') return `Downloading ${u.value!.version}… ${Math.round(u.value!.progress?.percent ?? 0)}%`;
  if (s === 'downloaded') return `${u.value!.version} is ready: it installs when DBCatz restarts`;
  if (s === 'error') return u.value!.error ?? 'The last check failed';
  return '';
});
function checkNow() {
  updateOpen.value = true;
  if (!waiting.value) void api.updateCheck();
}
</script>

<template>
  <div v-if="u" class="card">
    <div class="card-body">
      <h2>Updates</h2>
      <div class="opt-row">
        <span class="flex flex-col">
          <span class="label-caps">DBCatz {{ u.current }}</span>
          <span class="text-xs opacity-50">Last checked: {{ lastChecked }}</span>
          <span v-if="line" class="text-xs" :class="u.status === 'error' ? 'text-error' : 'text-primary'">{{ line }}</span>
        </span>
        <button class="btn btn-sm" :class="{ 'btn-primary': waiting }" :disabled="u.status === 'checking'" @click="checkNow"><span v-if="u.status === 'checking'" class="loading loading-spinner loading-xs" />{{ waiting ? 'Show the update' : 'Check now' }}</button>
      </div>
      <div class="opt-row">
        <span class="flex flex-col"><span class="label-caps">Check automatically</span><span class="text-xs opacity-50">30 seconds after DBCatz opens, then every 6 hours. Nothing downloads without you.</span></span>
        <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="u.settings.auto" @change="api.updateConfigure({ auto: ($event.target as HTMLInputElement).checked })" />
      </div>
      <div class="opt-row">
        <span class="flex flex-col"><span class="label-caps">Channel</span><span class="text-xs opacity-50">Beta gets new versions earlier, before they are fully tested.</span></span>
        <div class="seg">
          <button v-for="c in CHANNELS" :key="c.id" class="seg-item" :class="{ 'is-active': u.settings.channel === c.id }" @click="api.updateConfigure({ channel: c.id })">{{ c.label }}</button>
        </div>
      </div>
      <div class="opt-row">
        <span class="flex flex-col"><span class="label-caps">Notify me</span><span class="text-xs opacity-50">A notification once when a new version is out.</span></span>
        <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="u.settings.notify" @change="api.updateConfigure({ notify: ($event.target as HTMLInputElement).checked })" />
      </div>
    </div>
  </div>
</template>
