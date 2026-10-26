<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { back, backList, canBack, canForward, forward, forwardList, go } from './nav';

/**
 * ‹ › back / forward through the screens seen (nav.ts), for the bar at the
 * top of each screen (workspace breadcrumb, Connections, Settings).
 * Right-click lists the screens that way, nearest first.
 */
const menu = ref<{ dir: -1 | 1; x: number; y: number } | null>(null);
function openMenu(e: MouseEvent, dir: -1 | 1) {
  if (!(dir < 0 ? canBack.value : canForward.value)) return;
  menu.value = { dir, x: Math.max(8, Math.min(e.clientX, window.innerWidth - 460)), y: e.clientY + 8 };
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && menu.value) {
    e.stopPropagation();
    menu.value = null;
  }
};
window.addEventListener('keydown', onKey, true);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="flex shrink-0 items-center">
    <button class="btn btn-ghost btn-xs btn-square" :disabled="!canBack" title="Back (⌘[) · right-click for recent screens" @click="back" @contextmenu.prevent="openMenu($event, -1)">
      <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M12.8 4.2a.75.75 0 0 1 0 1.06L8.06 10l4.74 4.74a.75.75 0 1 1-1.06 1.06l-5.27-5.27a.75.75 0 0 1 0-1.06l5.27-5.27a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
    </button>
    <button class="btn btn-ghost btn-xs btn-square" :disabled="!canForward" title="Forward (⌘]) · right-click for recent screens" @click="forward" @contextmenu.prevent="openMenu($event, 1)">
      <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M7.2 15.8a.75.75 0 0 1 0-1.06L11.94 10 7.2 5.26a.75.75 0 1 1 1.06-1.06l5.27 5.27a.75.75 0 0 1 0 1.06L8.26 15.8a.75.75 0 0 1-1.06 0Z" clip-rule="evenodd" /></svg>
    </button>
    <Teleport v-if="menu" to="body">
      <div class="fixed inset-0 z-[60]" @click="menu = null" @contextmenu.prevent="menu = null" />
      <ul role="menu" class="menu fixed z-[61] max-h-[60vh] w-[28rem] max-w-[90vw] flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1.5 text-sm shadow-xl" :style="{ top: `${menu.y}px`, left: `${menu.x}px` }">
        <li class="menu-title px-2 text-[10px] opacity-50">{{ menu.dir < 0 ? 'Back to' : 'Forward to' }}</li>
        <li v-for="(e, i) in menu.dir < 0 ? backList : forwardList" :key="i">
          <button class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2" :title="e.label" @click="go(menu!.dir * (i + 1)); menu = null">
            <span class="min-w-0 truncate">{{ e.label }}</span>
            <span class="text-[10px] opacity-40">{{ new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
          </button>
        </li>
      </ul>
    </Teleport>
  </div>
</template>
