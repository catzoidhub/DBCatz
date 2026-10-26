<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { aiProvider, DV_AI_FEATURES, DV_AI_PROVIDERS, type DvAiFeature, type DvAiProvider, type DvReportSettings, type Theme } from '@shared/types';
import { api, attempt, notify, saveSettings, settings, settingsTab } from '../store';
import DvNavButtons from './DvNavButtons.vue';
import DvModelPicker from './DvModelPicker.vue';
import DvAbout from './DvAbout.vue';
import DvUpdates from './DvUpdates.vue';

/**
 * Settings, inside the window (gear in the top-right corner, ⌘,):
 * General (the theme; Privacy: crash reports), AI (provider, its API key,
 * model, a switch per feature), Updates and About — the same tabs as DialCatz. Updates come here once the
 * update feed is live (TODO §1).
 */
const emit = defineEmits<{ close: [] }>();
const tab = settingsTab;
const TABS = [
  { id: 'appearance', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' },
] as const;
const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'system', label: 'Auto', hint: 'Follows macOS' },
  { value: 'light', label: 'Light', hint: 'Always light' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' },
];

const s = computed(() => settings.value!);
const ai = computed(() => s.value.ai);
const info = computed(() => aiProvider(ai.value.provider));
const hasKey = computed(() => ai.value.keys.includes(ai.value.provider));
const needsKey = computed(() => !!info.value.keyUrl);
const editableUrl = computed(() => ai.value.provider === 'zai' || ai.value.provider === 'ollama' || ai.value.provider === 'openai-compatible');

const keyInput = ref('');
const replacing = ref(false);
const modelInput = ref('');
const urlInput = ref('');
const loaded = ref<Partial<Record<DvAiProvider, string[]>>>({});
const loadingModels = ref(false);
const testing = ref(false);
const tested = ref<{ ok: boolean; text: string } | null>(null);

// The fields follow the chosen provider.
watch(
  () => ai.value.provider,
  () => {
    modelInput.value = ai.value.models[ai.value.provider] ?? info.value.models[0] ?? '';
    urlInput.value = ai.value.baseUrls[ai.value.provider] ?? info.value.baseUrl;
    keyInput.value = '';
    replacing.value = false;
    tested.value = null;
  },
  { immediate: true },
);
// The model / address changed in another Catzoid app (they share them): show the new value.
watch(
  () => ai.value.models[ai.value.provider],
  (m) => {
    if (m !== undefined && m !== modelInput.value) modelInput.value = m;
  },
);
watch(
  () => ai.value.baseUrls[ai.value.provider],
  (u) => (urlInput.value = u ?? info.value.baseUrl),
);
const modelList = computed(() => [...new Set([...(loaded.value[ai.value.provider] ?? []), ...info.value.models])]);
/** Per provider: model → null (works with the key) or why not; checks add up. */
const probed = ref<Partial<Record<DvAiProvider, Record<string, string | null>>>>({});
const probing = ref(false);
async function probe(list: string[]) {
  probing.value = true;
  const r = await attempt(() => api.aiProbe(ai.value.provider, list));
  probing.value = false;
  if (!r) return;
  probed.value = { ...probed.value, [ai.value.provider]: { ...(probed.value[ai.value.provider] ?? {}), ...r } };
  const ok = list.filter((m) => r[m] === null);
  notify(ok.length ? 'success' : 'error', ok.length ? `${ok.length} of ${list.length} models work with this key` : `None of ${list.length} models answered with this key: ${Object.values(r).find((x) => x) ?? ''}`);
  // The chosen model does not work but another does: pick the first that works.
  if (ok.length && typeof r[modelInput.value] === 'string') await chooseModel(ok[0]);
}
async function chooseModel(m: string) {
  modelInput.value = m;
  await saveModel();
}

const toggleFeature = (f: DvAiFeature, on: boolean) => saveSettings({ ai: { off: on ? ai.value.off.filter((x) => x !== f) : [...ai.value.off, f] } });

async function saveKey() {
  const k = keyInput.value.trim();
  if (!k) return;
  const r = await attempt(() => api.setAiKey(ai.value.provider, k), `${info.value.name} key saved`);
  if (r) {
    settings.value = r;
    keyInput.value = '';
    replacing.value = false;
    tested.value = null;
  }
}
async function removeKey() {
  const r = await attempt(() => api.setAiKey(ai.value.provider, ''), 'Key removed');
  if (r) settings.value = r;
}
async function saveModel() {
  const m = modelInput.value.trim();
  if (m === (ai.value.models[ai.value.provider] ?? '')) return;
  await saveSettings({ ai: { models: { [ai.value.provider]: m } } });
  tested.value = null;
}
async function saveUrl() {
  const u = urlInput.value.trim();
  await saveSettings({ ai: { baseUrls: { [ai.value.provider]: u === info.value.baseUrl ? '' : u } } });
  tested.value = null;
}
async function loadModels() {
  loadingModels.value = true;
  const list = await attempt(() => api.aiModels(ai.value.provider));
  loadingModels.value = false;
  if (!list) return;
  loaded.value = { ...loaded.value, [ai.value.provider]: list };
  notify('info', list.length ? `${list.length} models from ${info.value.name}` : `${info.value.name} listed no models`);
}
async function test() {
  testing.value = true;
  tested.value = null;
  try {
    tested.value = { ok: true, text: `${await api.aiTest()} answered` };
  } catch (e) {
    tested.value = { ok: false, text: String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  testing.value = false;
}

// General → Privacy: Send crash reports (Catzoid #65), off until the user turns it on.
const reports = ref<DvReportSettings | null>(null);
onMounted(async () => (reports.value = await api.reportSettings().catch(() => null)));
async function setCrash(on: boolean) {
  reports.value = (await attempt(() => api.reportConfigure(on))) ?? reports.value;
}
const site = ref('');
onMounted(async () => (site.value = (await api.appInfo().catch(() => null))?.site ?? ''));

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !(e.target as HTMLElement).closest('dialog')) emit('close');
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="absolute inset-x-0 top-[52px] bottom-0 z-30 flex flex-col overflow-hidden bg-base-100">
    <div class="flex items-center gap-3 border-b border-base-300/60 py-3 pr-6 pl-2">
      <DvNavButtons />
      <svg viewBox="0 0 20 20" class="size-5 opacity-70" fill="currentColor"><path fill-rule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clip-rule="evenodd" /></svg>
      <h1 class="text-base font-semibold tracking-tight">Settings</h1>
      <div role="tablist" class="seg ml-3">
        <a v-for="t in TABS" :key="t.id" role="tab" class="seg-item" :class="{ 'is-active': tab === t.id }" @click="tab = t.id">{{ t.label }}</a>
      </div>
      <span class="flex-1" />
      <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" @click="emit('close')">✕</button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-2xl space-y-4 px-6 py-6">
        <!-- Appearance -->
        <div v-if="tab === 'appearance'" class="card">
          <div class="card-body">
            <div class="flex items-center gap-2"><h2>Appearance</h2><span class="badge badge-ghost badge-sm" title="Change it here and every Catzoid app follows">Shared with Catzoid apps</span></div>
            <div class="flex items-center gap-3">
              <span class="w-28">Theme</span>
              <div class="join">
                <button v-for="m in THEMES" :key="m.value" class="btn btn-sm join-item" :class="{ 'btn-active btn-primary': s.theme === m.value }" :title="m.hint" @click="saveSettings({ theme: m.value })">{{ m.label }}</button>
              </div>
            </div>
            <p class="text-xs opacity-60">Auto follows macOS (System Settings → Appearance). All Catzoid apps use the same theme.</p>
          </div>
        </div>
        <div v-if="tab === 'appearance'" class="card">
          <div class="card-body">
            <h2>Privacy</h2>
            <div class="opt-row">
              <span class="flex flex-col">
                <span class="label-caps">Send crash reports</span>
                <span class="text-xs opacity-50">When DBCatz crashes or hits an error, send the error to Catzoid so it gets fixed. Never your hosts, queries, data or passwords.<template v-if="reports?.queued"> {{ reports.queued }} waiting to be sent.</template> <a v-if="site" class="link" @click="api.openUrl(`${site}/docs/privacy-and-data`)">What is sent</a></span>
              </span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="reports?.crash === true" @change="setCrash(($event.target as HTMLInputElement).checked)" />
            </div>
          </div>
        </div>

        <!-- AI -->
        <template v-if="tab === 'ai'">
          <div class="card">
            <div class="card-body">
              <h2>AI</h2>
              <label class="flex cursor-pointer items-start gap-3">
                <input type="checkbox" class="toggle toggle-primary toggle-sm mt-0.5" :checked="ai.enabled" @change="saveSettings({ ai: { enabled: ($event.target as HTMLInputElement).checked } })" />
                <span>
                  Use AI in DBCatz
                  <span class="block text-xs opacity-60">Writes queries from plain words, explains errors and slow statements in Logs, and takes plain-word commands (⌘K). Nothing is sent until you press an AI button; every one has <b>Preview what is sent</b>, and nothing it suggests runs without your click. This switch is for DBCatz only; the provider below is shared with all Catzoid apps.</span>
                </span>
              </label>
            </div>
          </div>

          <div class="card" :class="{ 'opacity-60': !ai.enabled }">
            <div class="card-body">
              <div class="flex items-center gap-2"><h2>Provider</h2><span class="badge badge-ghost badge-sm" title="Change the provider, model or key in any Catzoid app and the others follow">Shared with Catzoid apps</span></div>
              <div class="flex items-center gap-3">
                <span class="w-28 shrink-0">Provider</span>
                <select class="select select-sm min-w-0 flex-1" :value="ai.provider" @change="saveSettings({ ai: { provider: ($event.target as HTMLSelectElement).value as DvAiProvider } })">
                  <option v-for="p in DV_AI_PROVIDERS" :key="p.id" :value="p.id">{{ p.name }}{{ ai.keys.includes(p.id) ? ' · key saved' : '' }}</option>
                </select>
              </div>

              <!-- API key -->
              <div v-if="needsKey || ai.provider === 'openai-compatible'" class="flex items-start gap-3">
                <span class="w-28 shrink-0 pt-1.5">API key</span>
                <div class="min-w-0 flex-1 space-y-1.5">
                  <div v-if="hasKey && !replacing" class="flex items-center gap-2">
                    <span class="input input-sm flex min-w-0 flex-1 items-center gap-2 text-xs opacity-80"><span class="status status-success status-xs shrink-0" /><span class="truncate">Saved in the macOS Keychain (Catzoid AI)</span></span>
                    <button class="btn btn-sm" @click="replacing = true">Replace</button>
                    <button class="btn btn-ghost btn-sm text-error" @click="removeKey">Remove</button>
                  </div>
                  <form v-else class="flex items-center gap-2" @submit.prevent="saveKey">
                    <input v-model="keyInput" type="password" class="input input-sm min-w-0 flex-1 font-mono text-xs" :placeholder="ai.provider === 'openai-compatible' ? 'Optional: the server’s token' : `Paste your ${info.name} API key`" autocomplete="off" spellcheck="false" />
                    <button class="btn btn-primary btn-sm" :disabled="!keyInput.trim()">Save</button>
                    <button v-if="replacing" type="button" class="btn btn-ghost btn-sm" @click="replacing = false; keyInput = ''">Cancel</button>
                  </form>
                  <p class="text-xs opacity-60">
                    Kept only on this Mac in the Keychain, shared with Catzoid apps, never shown again or sent anywhere but {{ info.name }}.
                    <a v-if="info.keyUrl" class="link" @click="api.openUrl(info.keyUrl)">Get a key</a>
                  </p>
                </div>
              </div>

              <!-- Server address -->
              <div class="flex items-start gap-3">
                <span class="w-28 shrink-0 pt-1.5">Address</span>
                <div class="min-w-0 flex-1 space-y-1.5">
                  <input v-if="editableUrl" v-model="urlInput" class="input input-sm w-full font-mono text-xs" :placeholder="info.baseUrl" spellcheck="false" @change="saveUrl" @keydown.enter="saveUrl" />
                  <span v-else class="input input-sm flex w-full items-center font-mono text-xs opacity-60">{{ info.baseUrl }}</span>
                  <p v-if="ai.provider === 'zai'" class="text-xs opacity-60">Use a <b>Standard API key</b> (pay-as-you-go balance). GLM Coding Plan keys (ZCode and other coding tools) are only for Z.ai’s supported tools and answer “insufficient balance” here. Keys from bigmodel.cn (mainland China) use <code>https://open.bigmodel.cn/api/paas/v4</code>.</p>
                  <p v-else-if="ai.provider === 'ollama'" class="text-xs opacity-60">Runs on this Mac, nothing leaves it. Install from ollama.com, then e.g. <code>ollama pull qwen2.5-coder</code>.</p>
                  <p v-else-if="ai.provider === 'openai-compatible'" class="text-xs opacity-60">Any server with an OpenAI-style <code>/chat/completions</code>: LM Studio, vLLM, LiteLLM, a company gateway.</p>
                </div>
              </div>

              <!-- Model -->
              <div class="flex items-start gap-3">
                <span class="w-28 shrink-0 pt-1.5">Model</span>
                <div class="min-w-0 flex-1 space-y-1.5">
                  <div class="flex items-center gap-2">
                    <DvModelPicker :model-value="modelInput" :models="modelList" :status="probed[ai.provider]" :checking="probing" :can-check="!needsKey || hasKey" :placeholder="info.models[0] ?? 'model id'" @update:model-value="chooseModel" @check="probe" />
                    <button class="btn btn-sm" :disabled="loadingModels || (needsKey && !hasKey)" :title="needsKey && !hasKey ? 'Save the API key first' : `Ask ${info.name} for its models`" @click="loadModels"><span v-if="loadingModels" class="loading loading-spinner loading-xs" />Load models</button>
                  </div>
                  <p class="text-xs opacity-60">Click the field to search the list ({{ modelList.length }} models), or type any id the provider knows. Some providers and routers list every model, not only the ones your key or plan may use: search, then <b>Check … with the key</b> marks them ✓ / ✗.</p>
                </div>
              </div>

              <div class="flex items-center gap-3 pt-1">
                <span class="w-28 shrink-0" />
                <button class="btn btn-sm" :disabled="testing || !ai.enabled" :title="ai.enabled ? 'Sends one tiny request' : 'Turn Ask AI on first'" @click="test"><span v-if="testing" class="loading loading-spinner loading-xs" />Test</button>
                <span v-if="tested" class="min-w-0 text-xs" :class="tested.ok ? 'text-success' : 'text-error'">{{ tested.text }}</span>
              </div>
            </div>
          </div>
          <div class="card" :class="{ 'opacity-60': !ai.enabled }">
            <div class="card-body">
              <h2>Features</h2>
              <p class="text-xs opacity-60">Each one sends only what it needs: never hosts, users, passwords or connection settings; rows or values only with <b>Send samples</b> on for a connection (in its Ask AI box). The AI buttons hide for a feature that is off.</p>
              <label v-for="f in DV_AI_FEATURES" :key="f.id" class="flex cursor-pointer items-start gap-3 border-t border-base-300/50 pt-3">
                <input type="checkbox" class="toggle toggle-sm mt-0.5" :checked="!ai.off.includes(f.id)" :disabled="!ai.enabled" @change="toggleFeature(f.id, ($event.target as HTMLInputElement).checked)" />
                <span class="min-w-0">
                  <span class="font-medium">{{ f.label }}</span>
                  <span class="block text-xs opacity-70">{{ f.hint }}</span>
                  <span class="block text-xs opacity-50">Sends: {{ f.sends }}.</span>
                </span>
              </label>
            </div>
          </div>
        </template>

        <!-- Updates -->
        <DvUpdates v-if="tab === 'updates'" />

        <!-- About -->
        <DvAbout v-if="tab === 'about'" />
      </div>
    </div>
  </div>
</template>
