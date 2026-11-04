<script setup lang="ts">
import { computed } from 'vue';
import { words } from '@shared/platform';
import { openAppDownload } from '../store';
import devcatzLogo from '../assets/logos/devcatz.png';
import docatzLogo from '../assets/logos/docatz.png';

/**
 * The Connections list's card for the app behind a service group: `missing` when its services are listed but the app is
 * gone (they cannot start), `none` when it has never been here. Install opens `<shared site>/download/<app>/<platform>`.
 */
const props = defineProps<{ app: 'DevCatz' | 'DoCatz'; kind: 'missing' | 'none'; count?: number }>();
const logo = computed(() => (props.app === 'DoCatz' ? docatzLogo : devcatzLogo));
const pitch = computed(() =>
  props.app === 'DoCatz'
    ? { title: 'Container databases with DoCatz', text: 'Run your Docker projects, and the PostgreSQL, MySQL, Redis and more in them show up here, ready to open.' }
    : { title: 'Local databases with DevCatz', text: 'MySQL, PostgreSQL, Redis and more, one click away. They show up here, ready to open.' },
);
</script>

<template>
  <div class="dv-devcatz-card" :class="[`is-${kind}`, { 'is-docatz': app === 'DoCatz' }]">
    <img :src="logo" alt="" class="size-10 shrink-0 drop-shadow-sm" draggable="false" />
    <div class="min-w-0 flex-1">
      <p class="text-[12.5px] font-semibold leading-tight">{{ kind === 'missing' ? `${app} is not installed` : pitch.title }}</p>
      <p class="mt-0.5 text-[11.5px] leading-snug opacity-65">
        <template v-if="kind === 'missing'">{{ count === 1 ? 'This service needs' : `These ${count ?? ''} services need` }} {{ app }} to start. Its settings were left on {{ words.thisComputer }}.</template>
        <template v-else>{{ pitch.text }}</template>
      </p>
      <button type="button" class="dv-devcatz-btn mt-2" @click.stop="openAppDownload(app)">
        <img :src="logo" alt="" class="size-4" draggable="false" />
        {{ kind === 'missing' ? `Install ${app} again` : `Install ${app}` }}
        <svg viewBox="0 0 20 20" class="size-3.5 opacity-70" fill="currentColor"><path fill-rule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.64l-3.22-3.22a.75.75 0 1 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.22-3.22H3.75A.75.75 0 0 1 3 10Z" clip-rule="evenodd" /></svg>
      </button>
    </div>
  </div>
</template>
