<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, attempt, mcatzpInstalling, update, updateDialogAuto, updateOpen } from '../store';
import { jobs, writeAsk } from './viewer';

/**
 * DBCatz's update opens What's New by itself (Catzoid #97, as DevCatz). Once per version and launch, at a calm moment:
 * the window in front, no other dialog open, no export / import / backup running, no MCatzP install, no write waiting
 * for an answer. Later = again on the next launch, or 24 h after it last opened in a long session; Skip this version =
 * never for that version; "Don't open this on its own" (in the dialog, and Settings → Updates) leaves only the dot,
 * Settings and the notification. A finished download opens it once more for Restart now.
 */
const DAY = 86_400_000;
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 30_000);
const wake = () => (now.value = Date.now());
window.addEventListener('focus', wake);
document.addEventListener('visibilitychange', wake);
onBeforeUnmount(() => {
  clearInterval(tick);
  window.removeEventListener('focus', wake);
  document.removeEventListener('visibilitychange', wake);
});

/** What was opened in this launch: `<version>:available` / `<version>:downloaded`. */
const shown = new Set<string>();

/** What would open now (null = nothing to ask). */
const want = computed(() => {
  const x = update.value;
  if (!x?.version || x.settings.dialog === false || x.settings.skipped === x.version) return null;
  if (x.status === 'downloaded') return `${x.version}:downloaded`;
  if (x.status === 'available') return `${x.version}:available`;
  return null;
});
/** Something is running that a dialog on top would interrupt. */
const busy = computed(() => jobs.value.some((j) => !j.finished) || !!mcatzpInstalling.value || !!writeAsk.value);

watch(
  [want, busy, now],
  () => {
    const key = want.value;
    if (!key || updateOpen.value || busy.value) return;
    const again = (update.value?.settings.promptAt ?? 0) + DAY <= now.value;
    if (shown.has(key) && !again) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (document.querySelector('dialog[open], .modal-open')) return;
    shown.add(key);
    updateDialogAuto.value = true;
    updateOpen.value = true;
    void attempt(() => api.updateConfigure({ promptAt: Date.now() }));
  },
  { immediate: true },
);
// Opened by hand (menu, Settings, About, the notification): no "Don't open this on its own".
watch(updateOpen, (open) => {
  if (!open) updateDialogAuto.value = false;
});
</script>

<template>
  <span hidden />
</template>
