<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DvConnection } from '@shared/types';
import { isProd, isSql, words } from './viewer';

/**
 * Dropping or emptying several tables at once: what goes, the Force switch
 * (integrity checks off, said per engine) and the word to type — the database
 * name, or on Production the connection's name (the main process checks it
 * again, and refuses on Read-only connections).
 */
const props = defineProps<{ kind: 'drop' | 'truncate'; conn: DvConnection; db: string; tables: string[]; busy?: boolean }>();
const emit = defineEmits<{ ok: [confirm: string, force: boolean]; cancel: [] }>();
const W = words(props.conn.engine);
const prod = isProd(props.conn);
const word = prod ? props.conn.name : props.db;
const typed = ref('');
const force = ref(false);
const input = ref<HTMLInputElement | null>(null);
onMounted(() => input.value?.focus());
const n = props.tables.length;
const noun = n === 1 ? W.table : W.tables;

const what = computed(() =>
  props.kind === 'drop'
    ? `${n} ${noun} in ${props.db} and all their ${W.rows} will be deleted. This cannot be undone.`
    : `Every ${W.row} of these ${n} ${noun} in ${props.db} will be deleted; the ${W.tables} themselves stay. This cannot be undone.`,
);
/** What Force does on this engine. */
const forceHint = computed(() => {
  const e = props.conn.engine;
  if (e === 'postgresql') return props.kind === 'drop' ? 'Uses CASCADE: foreign keys and views of other tables that depend on these are dropped too.' : 'Uses CASCADE: tables whose foreign keys point at these are emptied too.';
  if (e === 'sqlite') return 'Turns foreign_keys off for this step: rows elsewhere may be left pointing at nothing.';
  return 'Sets FOREIGN_KEY_CHECKS = 0 for this step: rows in other tables may be left pointing at nothing.';
});
const ok = () => typed.value.trim() === word;
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <form class="modal-box w-[32rem] max-w-[95vw] space-y-4" @submit.prevent="ok() && emit('ok', typed.trim(), force)">
      <div class="flex items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-error/15 text-error">
          <svg viewBox="0 0 20 20" class="size-5" fill="currentColor"><path d="M7.5 2.5h5l.6 1.5H16v1.5H4V4h2.9l.6-1.5ZM5.2 7h9.6l-.7 9.6a1 1 0 0 1-1 .9H6.9a1 1 0 0 1-1-.9L5.2 7Z" /></svg>
        </span>
        <div class="min-w-0">
          <h3 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
            {{ kind === 'drop' ? 'Drop' : 'Empty' }} {{ n }} {{ noun }}?
            <span v-if="prod" class="dv-mode-chip is-prod">PROD</span>
          </h3>
          <p class="text-sm opacity-70">{{ what }}</p>
        </div>
      </div>
      <ul class="max-h-40 overflow-y-auto rounded-lg border border-base-300/60 bg-base-200/40 px-3 py-2 font-mono text-xs">
        <li v-for="t in tables" :key="t" class="truncate py-0.5">{{ t }}</li>
      </ul>
      <label v-if="isSql(conn.engine)" class="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2" :class="force ? 'border-error/40 bg-error/5' : 'border-base-300/60'">
        <input v-model="force" type="checkbox" class="checkbox checkbox-sm checkbox-error mt-0.5" />
        <span class="text-sm">
          <b>Force</b> — disable integrity checks
          <span class="block text-xs opacity-65">Off: refused when a {{ W.table }} outside these still points at one of them. {{ forceHint }}</span>
        </span>
      </label>
      <label class="block">
        <span class="label-caps mb-1 block">Type <span class="font-mono normal-case tracking-normal opacity-100">{{ word }}</span> to confirm<template v-if="prod"> (Production: the connection name)</template></span>
        <input ref="input" v-model="typed" class="input input-sm w-full font-mono" :placeholder="word" spellcheck="false" autocomplete="off" />
      </label>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="busy || !ok()"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ kind === 'drop' ? `Drop ${n} ${noun}` : `Empty ${n} ${noun}` }}</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
