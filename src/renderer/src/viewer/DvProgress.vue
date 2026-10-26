<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { DvConnectProgress } from '@shared/types';

/**
 * Steps of a connection attempt (Vault, AWS IAM, SSH tunnel, reaching the
 * server, signing in): done ✓, running (spinner, elapsed time), failed ✕
 * with the message; Cancel while it runs.
 */
const props = defineProps<{ progress: DvConnectProgress | null; title?: string; compact?: boolean; error?: string | null }>();
const emit = defineEmits<{ cancel: [] }>();
const started = Date.now();
const now = ref(Date.now());
// No steps arrived but the attempt already failed (or was cancelled): show it as failed, not as a spinner.
const p = computed<DvConnectProgress | null>(() => props.progress ?? (props.error ? { token: '', steps: ['Connect'], step: 0, detail: '', done: true, error: props.error } : null));
// The clock stops when the attempt ends.
const timer = setInterval(() => {
  if (!p.value?.done) now.value = Date.now();
}, 100);
onBeforeUnmount(() => clearInterval(timer));
const elapsed = computed(() => ((now.value - started) / 1000).toFixed(1));
const state = (i: number) => (!p.value ? (i === 0 ? 'run' : 'wait') : p.value.error && i === p.value.step ? 'fail' : i < p.value.step || (p.value.done && !p.value.error) ? 'ok' : i === p.value.step ? 'run' : 'wait');
</script>

<template>
  <div class="dv-progress" :class="{ 'is-compact': compact }">
    <div class="mb-2 flex items-center gap-2">
      <span v-if="!p?.done" class="loading loading-spinner loading-xs text-primary" />
      <span v-else-if="p.error" class="text-error">✕</span>
      <span v-else class="text-success">✓</span>
      <span class="text-sm font-medium">{{ p?.done ? (p.error ? (p.error === 'Cancelled' ? 'Cancelled' : 'Could not connect') : 'Connected') : (title ?? 'Connecting…') }}</span>
      <span class="flex-1" />
      <span class="font-mono text-[11px] tabular-nums opacity-50">{{ elapsed }} s</span>
      <button v-if="!p?.done" type="button" class="btn btn-ghost btn-xs" @click="emit('cancel')">Cancel</button>
    </div>
    <ol class="space-y-1.5">
      <li v-for="(s, i) in p?.steps ?? ['Connecting']" :key="i" class="flex items-start gap-2.5 text-[13px]" :class="{ 'opacity-40': state(i) === 'wait' }">
        <span class="dv-step-dot" :class="`is-${state(i)}`">
          <span v-if="state(i) === 'run'" class="loading loading-spinner size-2.5" />
          <template v-else-if="state(i) === 'ok'">✓</template>
          <template v-else-if="state(i) === 'fail'">✕</template>
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block">{{ s }}</span>
          <span v-if="p && i === p.step && p.detail && !p.error" class="block truncate font-mono text-[11px] opacity-55">{{ p.detail }}</span>
        </span>
      </li>
    </ol>
    <div v-if="p?.error && p.error !== 'Cancelled'" role="alert" class="mt-3 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] leading-relaxed text-error">{{ p.error }}</div>
  </div>
</template>
