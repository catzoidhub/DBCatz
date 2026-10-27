<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, onMounted, ref } from 'vue';
import type { DvUninstallPlan } from '@shared/types';
import { api, notify } from '../store';
import CatMood from './CatMood.vue';

/**
 * Uninstall DBCatz (Catzoid family #55), the same dialog as DialCatz's: what goes, the shared Catzoid settings and AI
 * keys only when the switch is on (on by default only when no other Catzoid app is installed), DBCatz typed (with a
 * Copy button) to confirm, then DBCatz quits and a script removes the rest.
 */
const emit = defineEmits<{ close: [] }>();
const NAME = 'DBCatz';

const plan = ref<DvUninstallPlan | null>(null);
const removeShared = ref(false);
const typed = ref('');
const busy = ref(false);
const error = ref('');
onMounted(async () => {
  try {
    plan.value = await api.uninstallPlan();
    removeShared.value = plan.value.otherApps.length === 0;
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  }
});
const blocked = computed(() => busy.value || typed.value.trim() !== NAME);

async function copyName() {
  await navigator.clipboard.writeText(NAME);
  notify('success', 'Name copied');
}
async function go() {
  if (blocked.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await api.uninstallRun(typed.value, removeShared.value);
    if (r.dryRun) {
      notify('info', `Test run: nothing was removed (${r.items.length + r.shared.length} items would go)`);
      emit('close');
    }
  } catch (e) {
    error.value = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  busy.value = false;
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-3">
        <CatMood mood="warning" class="size-10 shrink-0" />
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Uninstall DBCatz?</h3>
          <p class="text-sm opacity-70">This removes DBCatz and what it keeps on this computer. It cannot be undone.</p>
        </div>
      </div>
      <template v-if="plan">
        <ul class="space-y-1.5 rounded-xl border border-base-300/70 bg-base-200/40 p-3 text-sm">
          <li v-for="i in plan.items" :key="i.path">
            <span class="font-medium">{{ i.label }}</span>
            <span class="block truncate font-mono text-xs opacity-55" :title="i.path">{{ i.path }}</span>
          </li>
        </ul>
        <p class="text-xs opacity-60">Your own files stay: exports, backups, SQLite databases and anything else you saved elsewhere. Your databases on their servers are not touched.</p>
        <label v-if="plan.shared.length" class="opt-row cursor-pointer">
          <span class="flex flex-col">
            <span class="label-caps">Also remove the shared Catzoid settings</span>
            <span class="text-xs opacity-50">{{ plan.otherApps.length ? `Theme, AI connection and AI keys are shared with ${plan.otherApps.join(', ')}: keep them for those apps.` : `Theme, AI connection and the AI keys in ${words.secretStore}. No other Catzoid app is installed.` }}</span>
          </span>
          <input v-model="removeShared" type="checkbox" class="toggle toggle-sm toggle-warning" />
        </label>
        <div v-if="plan.homebrew" class="alert alert-info alert-soft text-sm"><CatMood mood="info" class="-my-0.5 size-7 shrink-0" /><span>Installed with Homebrew: <code class="selectable font-mono">brew uninstall --cask dbcatz</code> runs as well.</span></div>
        <p v-if="plan.dryRun" class="text-xs text-warning">Test run (a development build): only lists what would go; nothing is removed.</p>
        <div class="space-y-1.5">
          <p class="flex flex-wrap items-center gap-1 text-sm">
            Type <b class="font-mono">{{ NAME }}</b>
            <button class="btn btn-ghost btn-xs btn-square" title="Copy the name" aria-label="Copy the name" @click="copyName">
              <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h7A1.5 1.5 0 0 1 17 3.5v7a1.5 1.5 0 0 1-1.5 1.5H14V8.5A2.5 2.5 0 0 0 11.5 6H7V3.5Z" /><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h7A1.5 1.5 0 0 1 13 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 15.5v-7Z" /></svg>
            </button>
            to confirm:
          </p>
          <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="NAME" spellcheck="false" autocomplete="off" @keydown.enter="go" />
        </div>
      </template>
      <div v-else-if="!error" class="py-4 text-center"><span class="loading loading-dots" /></div>
      <p v-if="error" class="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] text-error">{{ error }}</p>
      <div class="modal-action mt-0">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="blocked" @click="go"><span v-if="busy" class="loading loading-spinner loading-xs" />Uninstall DBCatz</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
