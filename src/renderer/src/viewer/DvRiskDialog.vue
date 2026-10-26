<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DvRisk } from '@shared/types';

/**
 * What DBCatz found before a structure change: blocked items (cannot be done
 * from here, with what to do instead), dangers (go ahead only after typing
 * the name) and warnings (go ahead with one click).
 */
const props = defineProps<{ risk: DvRisk; title: string; action: string; busy?: boolean }>();
const emit = defineEmits<{ ok: [confirm: string]; cancel: [] }>();
const typed = ref('');
const input = ref<HTMLInputElement | null>(null);
onMounted(() => input.value?.focus());
const blocked = computed(() => props.risk.level === 'block');
const needsWord = computed(() => props.risk.level === 'danger');
const ready = computed(() => !blocked.value && (!needsWord.value || typed.value.trim() === props.risk.confirmWord));
const order = { block: 0, danger: 1, warn: 2 } as const;
const items = computed(() => [...props.risk.items].sort((a, b) => order[a.level] - order[b.level]));
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <form class="modal-box w-[34rem] max-w-[95vw] space-y-4" @submit.prevent="ready && emit('ok', typed.trim())">
      <div class="flex items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-xl" :class="blocked ? 'bg-error/15 text-error' : needsWord ? 'bg-warning/15 text-warning' : 'bg-info/15 text-info'">
          <svg viewBox="0 0 20 20" class="size-5" fill="currentColor"><path d="M8.3 3.1a2 2 0 0 1 3.4 0l6 10.4A2 2 0 0 1 16 16.5H4a2 2 0 0 1-1.7-3l6-10.4ZM10 7a1 1 0 0 0-1 1v3a1 1 0 1 0 2 0V8a1 1 0 0 0-1-1Zm0 6.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z" /></svg>
        </span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">{{ blocked ? `Can’t ${action.toLowerCase()} from here` : title }}</h3>
          <p class="text-sm opacity-60">{{ blocked ? 'DBCatz stopped this to keep the database consistent.' : needsWord ? 'This can break the database or lose data. Read it through first.' : 'Worth knowing before you go ahead.' }}</p>
        </div>
      </div>

      <ul class="space-y-2">
        <li v-for="(it, i) in items" :key="i" class="dv-risk" :class="`is-${it.level}`">
          <span class="dv-risk-tag">{{ it.level === 'block' ? 'Blocked' : it.level === 'danger' ? 'Risk' : 'Note' }}</span>
          <span class="min-w-0">
            <span class="block text-[13px] font-medium">{{ it.title }}</span>
            <span class="block text-[12px] leading-snug opacity-75">{{ it.detail }}</span>
          </span>
        </li>
      </ul>

      <label v-if="needsWord && !blocked" class="block">
        <span class="label-caps mb-1 block">Type <span class="font-mono normal-case tracking-normal opacity-100">{{ risk.confirmWord }}</span> to go ahead</span>
        <input ref="input" v-model="typed" class="input input-sm w-full font-mono" :placeholder="risk.confirmWord" spellcheck="false" autocomplete="off" />
      </label>

      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">{{ blocked ? 'Close' : 'Cancel' }}</button>
        <button v-if="!blocked" class="btn btn-sm" :class="needsWord ? 'btn-error' : 'btn-primary'" :disabled="busy || !ready"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ action }}</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
