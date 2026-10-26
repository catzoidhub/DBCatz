<script setup lang="ts">
import { onMounted, ref } from 'vue';

/** A destructive action: the user types the name to confirm (like the uninstall dialogs). */
const props = defineProps<{ title: string; text: string; name: string; confirm: string; busy?: boolean }>();
const emit = defineEmits<{ ok: [typed: string]; cancel: [] }>();
const typed = ref('');
const input = ref<HTMLInputElement | null>(null);
onMounted(() => input.value?.focus());
const ok = () => typed.value.trim() === props.name;
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <form class="modal-box w-[28rem] max-w-[95vw] space-y-4" @submit.prevent="ok() && emit('ok', typed.trim())">
      <h3 class="text-lg font-semibold tracking-tight">{{ title }}</h3>
      <p class="text-sm opacity-70">{{ text }}</p>
      <label class="block">
        <span class="label-caps mb-1 block">Type <span class="font-mono normal-case tracking-normal opacity-100">{{ name }}</span> to confirm</span>
        <input ref="input" v-model="typed" class="input input-sm w-full font-mono" :placeholder="name" spellcheck="false" autocomplete="off" />
      </label>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="busy || !ok()"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ confirm }}</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
