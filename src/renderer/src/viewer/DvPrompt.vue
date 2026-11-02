<script setup lang="ts">
import { onMounted, ref } from 'vue';

/** One text field with OK / Cancel (create database, rename a table), and an optional checkbox (duplicate a table). */
const props = defineProps<{ title: string; label: string; initial?: string; placeholder?: string; confirm: string; busy?: boolean; hint?: string; check?: string }>();
const emit = defineEmits<{ ok: [value: string, checked: boolean]; cancel: [] }>();
const value = ref(props.initial ?? '');
const checked = ref(true);
const input = ref<HTMLInputElement | null>(null);
onMounted(() => {
  input.value?.focus();
  input.value?.select();
});
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <form class="modal-box w-[26rem] max-w-[95vw] space-y-4" @submit.prevent="value.trim() && emit('ok', value.trim(), checked)">
      <h3 class="text-lg font-semibold tracking-tight">{{ title }}</h3>
      <label class="block">
        <span class="label-caps mb-1 block">{{ label }}</span>
        <input ref="input" v-model="value" class="input input-sm w-full font-mono" :placeholder="placeholder" spellcheck="false" autocomplete="off" required />
      </label>
      <label v-if="check" class="flex cursor-pointer items-center gap-2 text-sm">
        <input v-model="checked" type="checkbox" class="checkbox checkbox-sm" :disabled="busy" />
        {{ check }}
      </label>
      <p v-if="hint" class="text-xs opacity-60">{{ hint }}</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !value.trim()"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ confirm }}</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
