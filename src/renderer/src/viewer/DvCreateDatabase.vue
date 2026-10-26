<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DvCharsets, DvConnection } from '@shared/types';
import { attempt, api } from '../store';
import { words } from './viewer';

/**
 * Create a database: its name plus, for MySQL / MariaDB, the character set
 * and collation (utf8mb4 / utf8mb4_unicode_ci by default) and, for
 * PostgreSQL, the encoding and LC_COLLATE (the server's defaults when left).
 */
const props = defineProps<{ conn: DvConnection; busy?: boolean; initialName?: string }>();
const emit = defineEmits<{ ok: [name: string, options: { charset: string; collation: string }]; cancel: [] }>();
const W = words(props.conn.engine);
const mysql = props.conn.engine === 'mysql' || props.conn.engine === 'mariadb';
const pg = props.conn.engine === 'postgresql';
const name = ref(props.initialName ?? '');
const charset = ref(mysql ? 'utf8mb4' : pg ? 'UTF8' : '');
const collation = ref(mysql ? 'utf8mb4_unicode_ci' : '');
const sets = ref<DvCharsets>({ charsets: [], collations: [] });
const loading = ref(mysql || pg);
const input = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  input.value?.focus();
  if (mysql || pg) {
    sets.value = (await attempt(() => api.dvCharsets(props.conn.id))) ?? { charsets: [], collations: [] };
    loading.value = false;
    if (mysql && !sets.value.collations.some((c) => c.name === collation.value)) collation.value = sets.value.charsets.find((c) => c.name === charset.value)?.collation ?? '';
  }
});
const collations = computed(() => (mysql ? sets.value.collations.filter((c) => c.charset === charset.value) : sets.value.collations));
function onCharset() {
  if (mysql) collation.value = charset.value === 'utf8mb4' && sets.value.collations.some((c) => c.name === 'utf8mb4_unicode_ci') ? 'utf8mb4_unicode_ci' : (sets.value.charsets.find((c) => c.name === charset.value)?.collation ?? '');
}
const describe = (n: string) => sets.value.charsets.find((c) => c.name === n)?.description ?? '';
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <form class="modal-box w-[30rem] max-w-[95vw] space-y-4" @submit.prevent="name.trim() && emit('ok', name.trim(), { charset, collation })">
      <h3 class="text-lg font-semibold tracking-tight">Create {{ W.db }}</h3>
      <label class="block">
        <span class="label-caps mb-1 block">Name</span>
        <input ref="input" v-model="name" class="input input-sm w-full font-mono" placeholder="my_app" spellcheck="false" autocomplete="off" required pattern="[A-Za-z_][A-Za-z0-9_]*" />
      </label>
      <fieldset v-if="mysql || pg" class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="label-caps mb-1 block">{{ mysql ? 'Character set' : 'Encoding' }}</span>
          <select v-model="charset" class="select select-sm w-full font-mono" :disabled="loading" @change="onCharset">
            <option v-for="c in sets.charsets" :key="c.name" :value="c.name">{{ c.name }}</option>
            <option v-if="!sets.charsets.length" :value="charset">{{ charset }}</option>
          </select>
          <span class="mt-1 block truncate text-[11px] opacity-50" :title="describe(charset)">{{ describe(charset) }}</span>
        </label>
        <label class="block">
          <span class="label-caps mb-1 block">Collation</span>
          <select v-model="collation" class="select select-sm w-full font-mono" :disabled="loading">
            <option v-if="pg" value="">server default</option>
            <option v-for="c in collations" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
          <span class="mt-1 block text-[11px] opacity-50">{{ mysql ? (collation.endsWith('_ci') ? 'case-insensitive' : collation.endsWith('_bin') ? 'binary (exact bytes)' : collation.endsWith('_cs') ? 'case-sensitive' : '') : 'LC_COLLATE / LC_CTYPE; non-default values use template0' }}</span>
        </label>
      </fieldset>
      <p v-if="loading" class="text-xs opacity-60"><span class="loading loading-spinner loading-xs" /> Reading the server’s character sets…</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || loading || !name.trim()"><span v-if="busy" class="loading loading-spinner loading-xs" />Create</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
