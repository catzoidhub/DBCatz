<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, onMounted, ref } from 'vue';
import { api } from '../store';
import CatMood from './CatMood.vue';
import { active, connections, editing } from './viewer';

/**
 * First-run welcome (the Catzoid family's Get started, as DevCatz's WelcomeDialog): what DBCatz does and three first
 * steps, each with why. Shown once, on a true first launch — never seen and no saved connection yet — so an update
 * never shows it. DBCatz needs no administrator password and installs nothing on the Mac.
 */
const KEY = 'dbcatz.welcomeSeen';
const seen = ref(true);
try {
  seen.value = localStorage.getItem(KEY) === '1';
} catch {
  /* no storage: treat as seen */
}
const devcatz = ref(false);
const site = ref('');
onMounted(async () => {
  const info = await api.appInfo().catch(() => null);
  devcatz.value = !!info?.devcatzPath;
  site.value = (await api.aboutInfo().catch(() => null))?.site ?? '';
});
const open = computed(() => !seen.value && connections.value.every((c) => c.serviceId));

function done() {
  seen.value = true;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* fine: it shows once more next time */
  }
}
function newConnection() {
  editing.value = null;
  active.value = 'home';
  done();
}
const privacy = () => site.value && api.openUrl(`${site.value}/docs/privacy-and-data`);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open" open class="modal modal-open" @keydown.esc="done">
      <div class="modal-box w-[38rem] max-w-[95vw] space-y-5">
        <div class="flex items-start gap-3">
          <CatMood mood="success" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Welcome to DBCatz</h3>
            <p class="text-sm opacity-70">
              One window for MySQL, MariaDB, PostgreSQL, SQLite, Redis, Valkey, MongoDB and Elasticsearch — browse, edit, query, and ask in
              plain words when you like.
            </p>
          </div>
        </div>

        <div class="space-y-1">
          <p class="label-caps">Three things to know first</p>
          <p class="text-xs opacity-60">No administrator password, nothing installed on {{ words.thisComputer }}. Everything here can be changed later.</p>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">1 · Connect to a database</p>
                <p class="mt-1 text-sm opacity-70">
                  By hand, over SSH, with AWS IAM or credentials from Vault — or paste a URL like <span class="font-mono">postgres://…</span>
                  (a whole <span class="font-mono">DATABASE_URL=</span> line from .env works too). Passwords stay in {{ words.os }}’s secure storage.
                </p>
              </div>
              <button class="btn btn-primary btn-sm shrink-0" @click="newConnection">New connection</button>
            </div>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <p class="font-medium">2 · Mark what is production</p>
            <p class="mt-1 text-sm opacity-70">
              Give a connection the <b>Production</b> mode and every write asks first, risky ones need its name typed, and its tab wears a red
              PROD mark. <b>Read-only</b> makes the server session read-only too.
            </p>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">3 · Your DevCatz databases, already here</p>
                <p class="mt-1 text-sm opacity-70">
                  {{
                    devcatz
                      ? 'The databases DevCatz runs are listed under DevCatz services, with live status — no host, port or password to copy.'
                      : 'With DevCatz installed, the databases it runs show up here by themselves — no host, port or password to copy.'
                  }}
                </p>
              </div>
              <span v-if="devcatz" class="badge badge-success badge-sm shrink-0">DevCatz found</span>
            </div>
          </div>
        </div>

        <p class="text-xs opacity-60">
          AI is off until you turn it on in Settings → AI, and then only structure is sent, never your rows.
          <a v-if="site" class="link" @click="privacy">What DBCatz sends</a>
        </p>

        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm" @click="done">Maybe later</button>
          <button class="btn btn-primary btn-sm" @click="done">Get started</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="done" />
    </dialog>
  </Teleport>
</template>
