import { nativeTheme, safeStorage } from 'electron';
import { DV_AI_DEFAULTS, DV_AI_FEATURES, DV_AI_PROVIDERS, type DvAiFeature, type DbCatzSettings, type DbCatzSettingsPatch, type DvAiProvider, type Theme } from '@shared/types';
import { store } from './store';
import { readShared, setSharedKey, sharedKey, watchShared, writeShared } from './shared';

/**
 * The Settings page's values: appearance and Ask AI. Checked here (the window
 * is not trusted with the shape), applied at once. The theme and the AI
 * connection (provider, models, addresses, API keys) are shared with the
 * other Catzoid apps (shared.ts: Catzoid/shared.json + the "Catzoid AI"
 * Keychain item), so a key entered in DevCatz works here and the other way
 * round; Ask AI on / off stays DBCatz's own. Keys never leave the main
 * process. What DBCatz kept before (safeStorage) moves over once
 * (migrateToShared).
 */

const KEY = 'settings';
const AI_KEYS = 'aiKeys';
const THEMES: Theme[] = ['system', 'light', 'dark'];
const PROVIDERS = DV_AI_PROVIDERS.map((p) => p.id);
const FEATURES = DV_AI_FEATURES.map((f) => f.id);

type Stored = Omit<DbCatzSettings, 'ai'> & { ai: Omit<DbCatzSettings['ai'], 'keys'> };

/** DBCatz's own copy (config.json): the fallback, and the on / off switch. */
function local(): Stored {
  const s = store.extra<Partial<Stored>>(KEY) ?? {};
  const ai = { ...DV_AI_DEFAULTS, ...(s.ai ?? {}) };
  return {
    theme: THEMES.includes(s.theme as Theme) ? (s.theme as Theme) : 'system',
    ai: { enabled: ai.enabled === true, provider: PROVIDERS.includes(ai.provider) ? ai.provider : 'anthropic', models: ai.models ?? {}, baseUrls: ai.baseUrls ?? {}, samples: Array.isArray(ai.samples) ? ai.samples.map(String) : [], off: Array.isArray(ai.off) ? ai.off.filter((f): f is DvAiFeature => FEATURES.includes(f)) : [] },
  };
}

/** The shared values win where they are set. */
function stored(): Stored {
  const s = local();
  const sh = readShared();
  const provider = sh.ai?.provider ?? s.ai.provider;
  return {
    theme: sh.theme && THEMES.includes(sh.theme) ? sh.theme : s.theme,
    ai: { enabled: s.ai.enabled, provider: PROVIDERS.includes(provider) ? provider : 'anthropic', models: sh.ai?.models ?? s.ai.models, baseUrls: sh.ai?.baseUrls ?? s.ai.baseUrls, samples: s.ai.samples, off: s.ai.off },
  };
}

function encryptedKeys(): Partial<Record<DvAiProvider, string>> {
  return store.extra<Partial<Record<DvAiProvider, string>>>(AI_KEYS) ?? {};
}

export function settings(): DbCatzSettings {
  const s = stored();
  const mine = encryptedKeys();
  const shared = new Set(readShared().ai?.keys ?? []);
  return { ...s, ai: { ...s.ai, keys: PROVIDERS.filter((p) => shared.has(p) || mine[p]) } };
}

/** Only known fields, of the right type; model ids and URLs are trimmed and bounded. */
export function setSettings(patch: DbCatzSettingsPatch): DbCatzSettings {
  const s = stored();
  if (patch.theme !== undefined) {
    if (!THEMES.includes(patch.theme)) throw new Error(`Unknown theme ${patch.theme}`);
    s.theme = patch.theme;
  }
  const ai = patch.ai;
  if (ai) {
    if (ai.enabled !== undefined) s.ai.enabled = ai.enabled === true;
    if (ai.off !== undefined) s.ai.off = Array.isArray(ai.off) ? [...new Set(ai.off)].filter((f) => FEATURES.includes(f)) : [];
    if (ai.samples !== undefined) s.ai.samples = Array.isArray(ai.samples) ? [...new Set(ai.samples.map(String))].slice(0, 1000) : [];
    if (ai.provider !== undefined) {
      if (!PROVIDERS.includes(ai.provider)) throw new Error(`Unknown AI provider ${ai.provider}`);
      s.ai.provider = ai.provider;
    }
    for (const [p, m] of Object.entries(ai.models ?? {})) {
      if (!PROVIDERS.includes(p as DvAiProvider)) continue;
      const id = String(m ?? '').trim().slice(0, 200);
      if (id) s.ai.models[p as DvAiProvider] = id;
      else delete s.ai.models[p as DvAiProvider];
    }
    for (const [p, u] of Object.entries(ai.baseUrls ?? {})) {
      if (!PROVIDERS.includes(p as DvAiProvider)) continue;
      const url = String(u ?? '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('The address must start with http:// or https://');
      if (url) s.ai.baseUrls[p as DvAiProvider] = url.slice(0, 500);
      else delete s.ai.baseUrls[p as DvAiProvider];
    }
  }
  store.setExtra(KEY, s);
  // The theme and the connection are shared with DevCatz; Ask AI on / off is not.
  const conn = ai && (ai.provider !== undefined || ai.models !== undefined || ai.baseUrls !== undefined);
  if (patch.theme !== undefined || conn) writeShared({ ...(patch.theme !== undefined ? { theme: s.theme } : {}), ...(conn ? { ai: { provider: s.ai.provider, models: s.ai.models, baseUrls: s.ai.baseUrls } } : {}) });
  nativeTheme.themeSource = s.theme;
  return settings();
}

/** Saves (or with '' removes) a provider's key in the shared Keychain item; DBCatz's own old copy goes. */
export async function setAiKey(provider: DvAiProvider, key: string): Promise<DbCatzSettings> {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown AI provider ${provider}`);
  await setSharedKey(provider, key);
  const all = { ...encryptedKeys() };
  if (all[provider]) {
    delete all[provider];
    store.setExtra(AI_KEYS, all);
  }
  return settings();
}

/** The key of a provider ('' = none): the shared one, else DBCatz's own from before. Main process only. */
export async function aiKey(provider: DvAiProvider): Promise<string> {
  const shared = await sharedKey(provider);
  if (shared) return shared;
  const v = encryptedKeys()[provider];
  return v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
}

/**
 * Once, at start: the theme and AI connection DBCatz kept on its own move to
 * the shared file and Keychain item, unless another app shared its choice
 * already (that one wins).
 */
export async function migrateToShared(): Promise<void> {
  const own = store.extra<Partial<Stored>>(KEY);
  const mine = local();
  if (!readShared().theme) writeShared({ theme: mine.theme });
  if (!readShared().ai?.provider && own?.ai) writeShared({ ai: { provider: mine.ai.provider, models: mine.ai.models, baseUrls: mine.ai.baseUrls } });
  const keys = encryptedKeys();
  const shared = new Set(readShared().ai?.keys ?? []);
  let moved = false;
  for (const p of PROVIDERS) {
    const v = keys[p];
    if (!v) continue;
    try {
      if (!shared.has(p) && safeStorage.isEncryptionAvailable()) await setSharedKey(p, safeStorage.decryptString(Buffer.from(v, 'base64')));
      delete keys[p];
      moved = true;
    } catch (e) {
      console.warn(`AI key ${p} not moved to the shared Keychain item:`, (e as Error).message);
    }
  }
  if (moved) store.setExtra(AI_KEYS, keys);
}

/** Throws unless Ask AI and this feature are on (Settings → AI). */
export function needFeature(feature: DvAiFeature): void {
  const ai = settings().ai;
  const label = DV_AI_FEATURES.find((f) => f.id === feature)?.label ?? feature;
  if (!ai.enabled) throw new Error('Ask AI is off: turn it on in Settings → AI');
  if (ai.off.includes(feature)) throw new Error(`${label} is switched off in Settings → AI`);
}

/** Applies the saved appearance before the window opens, and follows the other apps' changes. */
export function applySettings(onChange: (s: DbCatzSettings) => void): void {
  nativeTheme.themeSource = stored().theme;
  watchShared(() => {
    nativeTheme.themeSource = stored().theme;
    onChange(settings());
  });
}
