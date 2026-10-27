<script setup lang="ts">
import { words } from '@shared/platform';
import { openDevCatzDownload } from '../store';
import devcatzLogo from '../assets/logos/devcatz.png';

/**
 * The Connections list's DevCatz card: `missing` when DevCatz's services are listed but its app is gone (they cannot
 * start), `none` when DevCatz has never been here. Install opens `<shared site>/download/devcatz/<platform>`.
 */
defineProps<{ kind: 'missing' | 'none'; count?: number }>();
</script>

<template>
  <div class="dv-devcatz-card" :class="`is-${kind}`">
    <img :src="devcatzLogo" alt="" class="size-10 shrink-0 drop-shadow-sm" draggable="false" />
    <div class="min-w-0 flex-1">
      <p class="text-[12.5px] font-semibold leading-tight">{{ kind === 'missing' ? 'DevCatz is not installed' : 'Local databases with DevCatz' }}</p>
      <p class="mt-0.5 text-[11.5px] leading-snug opacity-65">
        <template v-if="kind === 'missing'">{{ count === 1 ? 'This service needs' : `These ${count ?? ''} services need` }} DevCatz to start. Its settings were left on {{ words.thisComputer }}.</template>
        <template v-else>MySQL, PostgreSQL, Redis and more, one click away. They show up here, ready to open.</template>
      </p>
      <button type="button" class="dv-devcatz-btn mt-2" @click.stop="openDevCatzDownload()">
        <img :src="devcatzLogo" alt="" class="size-4" draggable="false" />
        {{ kind === 'missing' ? 'Install DevCatz again' : 'Install DevCatz' }}
        <svg viewBox="0 0 20 20" class="size-3.5 opacity-70" fill="currentColor"><path fill-rule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.64l-3.22-3.22a.75.75 0 1 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.22-3.22H3.75A.75.75 0 0 1 3 10Z" clip-rule="evenodd" /></svg>
      </button>
    </div>
  </div>
</template>
