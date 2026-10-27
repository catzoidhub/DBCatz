import { computed, ref, watch } from 'vue';
import type { DbCatzSettings, DbCatzSettingsPatch, DvAiFeature, DvReportKind, DvUpdateState, Theme } from '@shared/types';

/** The preload bridge (see src/preload/index.ts). */
export const api = window.dbcatz;

export const toast = ref<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(kind: 'error' | 'success' | 'info', text: string): void {
  toast.value = { kind, text };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), kind === 'error' ? 7000 : 3500);
}

/** Runs an IPC call and turns failures into a toast. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (success) notify('success', success);
    return r;
  } catch (e) {
    notify('error', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

/** The Settings page's values (config.json, through the main process). */
export const settings = ref<DbCatzSettings | null>(null);
export const showSettings = ref(false);
/**
 * DevCatz's download for this computer from the Catzoid site: `<shared site address>/download/devcatz/<platform>`
 * (mac-arm64, mac-x64, win-x64). No build for this computer → say so and open DevCatz's page, never another
 * platform's file (Catzoid family rule).
 */
export async function openDevCatzDownload(): Promise<void> {
  const info = await api.appInfo().catch(() => null);
  const site = info?.site ?? 'https://catzoid.com';
  if (!info?.platform) {
    notify('info', 'There is no DevCatz build for this computer yet.');
    return void api.openUrl(`${site}/devcatz`);
  }
  await api.openUrl(`${site}/download/devcatz/${info.platform}`);
}
/** The Settings tab to show (Ask DBCatz's open-settings sets it). */
export const settingsTab = ref<'appearance' | 'ai' | 'updates' | 'about'>('appearance');

/** In-app updates (Catzoid #54): the main process's state, and whether the update dialog is open. */
export const update = ref<DvUpdateState | null>(null);
export const updateOpen = ref(false);
/** Report a Bug / Send Feedback (Catzoid #65): the dialog's kind when open. */
export const reportOpen = ref<DvReportKind | null>(null);
/** Ask once, after the first error, whether to send crash reports. */
export const reportsAsk = ref(false);

/** True when AI is on and this feature is not switched off (Settings → AI): its buttons show only then. */
export const aiOn = (feature: DvAiFeature) => computed(() => Boolean(settings.value?.ai.enabled && !settings.value.ai.off.includes(feature)));

export async function saveSettings(patch: DbCatzSettingsPatch): Promise<void> {
  const s = await attempt(() => api.setSettings(patch));
  if (s) settings.value = s;
}

/** Light / dark / follow the system: Settings → Appearance. The main process sets nativeTheme; data-theme forces DaisyUI's colours. */
export const theme = computed<Theme>(() => settings.value?.theme ?? 'system');
watch(theme, (mode) => {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}, { immediate: true });

/** The top bar's old toggle kept the theme in localStorage: moved into the settings once. */
const OLD_THEME_KEY = 'dbcatz.theme';

export async function init(): Promise<void> {
  let old: string | null = null;
  try {
    old = localStorage.getItem(OLD_THEME_KEY);
  } catch {
    /* private mode */
  }
  settings.value = await api.settings();
  // DevCatz changed the shared theme or AI connection.
  api.onSettings((s) => {
    settings.value = s;
  });
  update.value = await api.updateState();
  api.onUpdate((u) => {
    update.value = u;
    // An answer to Check now: the dialog shows it (up to date, an error, or the new version).
    if (u.manual && ['none', 'available', 'error'].includes(u.status)) updateOpen.value = true;
  });
  api.onUpdateOpen(() => (updateOpen.value = true));
  api.onReportsAsk(() => (reportsAsk.value = true));
  // Uncaught errors in the window: reported only with Send crash reports on (the main process decides).
  window.addEventListener('error', (e) => void api.reportError(e.message, e.error?.stack ?? '').catch(() => undefined));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined;
    void api.reportError(r?.message ?? String(e.reason), r?.stack ?? '').catch(() => undefined);
  });
  if (old === 'light' || old === 'dark' || old === 'system') {
    if (old !== settings.value.theme) settings.value = await api.setSettings({ theme: old });
    try {
      localStorage.removeItem(OLD_THEME_KEY);
    } catch {
      /* private mode */
    }
  }
}
