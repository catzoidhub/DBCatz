<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DbEngine, DvConnection, DvConnectionInput, DvLayout, DvMethod, DvMode, DvOptionKey } from '@shared/types';
import { DV_DEFAULT_OPTIONS, DV_METHOD_NAME, dvMethods, dvOptionSupport } from '@shared/types';
import { parseDbUrl } from '@shared/dburl';
import { attempt, api, notify } from '../store';
import { DB_LOGO } from '../db';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PopMenu from '../components/PopMenu.vue';
import DvPrompt from './DvPrompt.vue';
import { groupByType, sortList, useListView } from '../listview';
import DvProgress from './DvProgress.vue';
import { COLORS, connections, DEFAULT_PORT, DV_HINT, editing, ENGINE_NAME, newToken, openTab, progress, refreshConnections } from './viewer';
import DvNavButtons from './DvNavButtons.vue';
import DvDevCatzInstall from './DvDevCatzInstall.vue';

/**
 * The Connections tab: DevCatz services, saved and session connections on
 * the left (click to open), and the connection form on the right — from a
 * URL, or by engine and method (TCP/IP, Socket, SSH, AWS IAM, Vault) with
 * the security options each allows; Test and Connect show their steps and
 * can be cancelled.
 */
const ENGINES: DbEngine[] = ['mysql', 'mariadb', 'postgresql', 'sqlite', 'redis', 'valkey', 'mongodb', 'elasticsearch'];
const session = computed(() => connections.value.filter((c) => c.temporary));
const filter = ref('');
const match = (c: DvConnection) => !filter.value || `${c.name} ${c.engine} ${c.host} ${c.ssh?.host ?? ''}`.toLowerCase().includes(filter.value.toLowerCase());

// ---- list layout: drag-and-drop order, favorites and groups (kept in DBCatz settings), sort / group-by (this window)
const layout = ref<DvLayout>({ order: [], favorites: [], groups: [] });
/** The DevCatz app itself is here: without it, a left-behind services file lists services nobody can start. */
const devcatzApp = ref(true);
async function checkDevCatz() {
  const info = await api.appInfo().catch(() => null);
  devcatzApp.value = !!info?.devcatzPath;
}
// Installed or removed while DBCatz runs: look again when the window comes back.
const onFocus = () => void checkDevCatz();
onMounted(() => window.addEventListener('focus', onFocus));
onBeforeUnmount(() => window.removeEventListener('focus', onFocus));
const listView = useListView('dbcatz.connections.view', 'engine');
const view = listView.view;
async function saveLayout(next: DvLayout) {
  layout.value = next;
  layout.value = (await attempt(() => api.dvSetLayout(JSON.parse(JSON.stringify(next))))) ?? next;
}
/** Services and saved connections in the drag-and-drop order (new ones last), or sorted by the ⇅ menu. */
const listed = computed(() => {
  const idx = new Map(layout.value.order.map((id, i) => [id, i]));
  const all = connections.value.filter((c) => !c.temporary);
  const base = all.map((c, i) => ({ c, i })).sort((a, b) => (idx.get(a.c.id) ?? 1e6 + a.i) - (idx.get(b.c.id) ?? 1e6 + b.i)).map((x) => x.c);
  return sortList(base, view.value.sort, (c) => c.name, (c) => ENGINE_NAME[c.engine]);
});
const favs = computed(() => new Set(layout.value.favorites));
const groupOf = (id: string) => layout.value.groups.find((g) => g.members.includes(id))?.name ?? null;
interface Section {
  key: string;
  title: string;
  group?: string;
  collapsed: boolean;
  items: DvConnection[];
  /** Hint in an empty group. */
  empty?: string;
}
const sections = computed<Section[]>(() => {
  const all = listed.value.filter(match);
  const c = (key: string) => listView.isCollapsed(key);
  const out: Section[] = [];
  const favItems = all.filter((x) => favs.value.has(x.id));
  if (favItems.length) out.push({ key: 'fav', title: 'Favorites', items: favItems, collapsed: c('fav') });
  if (view.value.group === 'type') {
    for (const [label, items] of groupByType(all, (x) => ENGINE_NAME[x.engine])) out.push({ key: `t:${label}`, title: label, items, collapsed: c(`t:${label}`) });
    return out;
  }
  if (view.value.group === 'none') {
    out.push({ key: 'all', title: 'All connections', items: all, collapsed: c('all') });
    return out;
  }
  const grouped = new Set<string>();
  for (const g of layout.value.groups) {
    const items = all.filter((x) => g.members.includes(x.id));
    items.forEach((x) => grouped.add(x.id));
    out.push({ key: `g:${g.name}`, title: g.name, group: g.name, collapsed: g.collapsed, items, empty: 'Drop connections here' });
  }
  const rest = all.filter((x) => !grouped.has(x.id));
  if (devcatzApp.value || rest.some((x) => x.serviceId)) out.push({ key: 'svc', title: 'DevCatz services', items: rest.filter((x) => x.serviceId), collapsed: c('svc'), empty: filter.value ? 'Nothing matches' : 'No database service yet. Create one on DevCatz’s Database page.' });
  out.push({ key: 'saved', title: 'Saved connections', items: rest.filter((x) => !x.serviceId), collapsed: c('saved'), empty: filter.value ? 'Nothing matches' : 'Connections you set up are kept here; secrets are encrypted with the macOS Keychain.' });
  return out;
});
function toggleSection(sec: Section) {
  if (!sec.group) return listView.toggle(sec.key);
  void saveLayout({ ...layout.value, groups: layout.value.groups.map((g) => (g.name === sec.group ? { ...g, collapsed: !g.collapsed } : g)) });
}
function setFavorite(id: string, on: boolean) {
  const f = layout.value.favorites.filter((x) => x !== id);
  void saveLayout({ ...layout.value, favorites: on ? [...f, id] : f });
}
function setGroup(id: string, name: string | null) {
  const groups = layout.value.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== id) }));
  if (name) {
    const g = groups.find((x) => x.name === name);
    if (g) g.members.push(id);
    else groups.push({ name, members: [id], collapsed: false });
  }
  void saveLayout({ ...layout.value, groups });
}
function groupAction(name: string, action: 'up' | 'down' | 'delete') {
  const groups = [...layout.value.groups];
  const i = groups.findIndex((g) => g.name === name);
  if (i < 0) return;
  if (action === 'delete') groups.splice(i, 1);
  else {
    const j = action === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= groups.length) return;
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  void saveLayout({ ...layout.value, groups });
}
// Drag and drop: onto a row = put before it (and into its section); onto a section head = into that group / favorites.
const dragId = ref<string | null>(null);
const dropRow = ref<string | null>(null);
const dropSection = ref<string | null>(null);
function endDrag() {
  dragId.value = null;
  dropRow.value = null;
  dropSection.value = null;
}
function moveInto(id: string, sec: Section) {
  if (sec.key === 'fav') return setFavorite(id, true);
  if (view.value.group !== 'default') return;
  if (sec.group) setGroup(id, sec.group);
  else if ((sec.key === 'svc' || sec.key === 'saved') && groupOf(id)) setGroup(id, null);
}
function onDropSection(sec: Section) {
  const id = dragId.value;
  endDrag();
  if (id) moveInto(id, sec);
}
function onDropRow(target: DvConnection, sec: Section) {
  const id = dragId.value;
  endDrag();
  if (!id || id === target.id) return;
  if (view.value.sort !== 'default') notify('info', 'Sorted by name / engine: choose “Sort by default” (⇅) to reorder by hand');
  else {
    const order = listed.value.map((x) => x.id).filter((x) => x !== id);
    order.splice(order.indexOf(target.id), 0, id);
    layout.value = { ...layout.value, order };
  }
  if (sec.key === 'fav') {
    if (!favs.value.has(id)) layout.value = { ...layout.value, favorites: [...layout.value.favorites, id] };
  } else if (view.value.group === 'default') {
    const want = sec.group ?? null;
    if (groupOf(id) !== want && (want || sec.key === 'svc' || sec.key === 'saved')) {
      const groups = layout.value.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== id) }));
      if (want) groups.find((g) => g.name === want)?.members.push(id);
      layout.value = { ...layout.value, groups };
    }
  }
  void saveLayout(layout.value);
}
// Group name dialog (new group for a connection, or rename).
const groupDialog = ref<{ mode: 'new' | 'rename'; id?: string; from?: string } | null>(null);
function saveGroupName(name: string) {
  const d = groupDialog.value!;
  if (layout.value.groups.some((g) => g.name === name) && name !== d.from) {
    if (d.mode === 'new') setGroup(d.id!, name);
    else notify('error', `A group named ${name} exists`);
    groupDialog.value = null;
    return;
  }
  if (d.mode === 'new') setGroup(d.id!, name);
  else void saveLayout({ ...layout.value, groups: layout.value.groups.map((g) => (g.name === d.from ? { ...g, name } : g)) });
  groupDialog.value = null;
}
// Row and group menus (⋯ button or right-click).
interface MenuEntry {
  label: string;
  action?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  heading?: boolean;
}
const menu = ref<{ x: number; y: number; items: MenuEntry[] } | null>(null);
function showMenu(e: MouseEvent, items: MenuEntry[]) {
  const h = items.length * 30 + 16;
  menu.value = { x: Math.min(e.clientX, window.innerWidth - 236), y: Math.min(e.clientY + 2, window.innerHeight - h - 8), items };
}
function run(item: MenuEntry) {
  menu.value = null;
  item.action?.();
}
function connMenu(e: MouseEvent, c: DvConnection) {
  const fav = favs.value.has(c.id);
  const current = groupOf(c.id);
  showMenu(e, [
    { label: 'Open', action: () => openTab(c) },
    { label: 'Open in a new tab', action: () => openTab(c, { fresh: true }) },
    ...(c.connected ? [{ label: 'Disconnect', action: () => void disconnectConn(c) }] : []),
    { label: fav ? 'Remove from Favorites' : 'Add to Favorites', action: () => setFavorite(c.id, !fav), separator: true },
    { label: 'Move to group', heading: true },
    ...layout.value.groups.map((g) => ({ label: g.name, checked: g.name === current, action: () => setGroup(c.id, g.name) })),
    { label: 'New group…', action: () => (groupDialog.value = { mode: 'new', id: c.id }) },
    ...(current ? [{ label: `Remove from “${current}”`, action: () => setGroup(c.id, null) }] : []),
    ...(!c.serviceId ? [{ label: 'Edit…', action: () => edit(c), separator: true }, { label: 'Delete…', danger: true, action: () => (removing.value = c) }] : []),
  ]);
}
function groupMenu(e: MouseEvent, name: string) {
  const i = layout.value.groups.findIndex((g) => g.name === name);
  showMenu(e, [
    { label: 'Rename group…', action: () => (groupDialog.value = { mode: 'rename', from: name }) },
    { label: 'Move up', disabled: i <= 0, action: () => groupAction(name, 'up') },
    { label: 'Move down', disabled: i >= layout.value.groups.length - 1, action: () => groupAction(name, 'down') },
    { label: 'Delete group (keeps the connections)', danger: true, separator: true, action: () => groupAction(name, 'delete') },
  ]);
}
async function disconnectConn(c: DvConnection) {
  await attempt(() => api.dvDisconnect(c.id));
  await refreshConnections();
}
const MODE_LABEL = { normal: 'Normal', production: 'Production', readonly: 'Read-only' } as const;
const modeOf = (c: DvConnection) => c.options?.mode ?? 'normal';
/** Second line of a row: engine and where it is. */
const rowHint = (c: DvConnection) =>
  c.engine === 'sqlite' ? `${ENGINE_NAME[c.engine]} · ${c.file.split('/').pop()}` : c.serviceId ? `${ENGINE_NAME[c.engine]} · 127.0.0.1:${c.port}` : `${ENGINE_NAME[c.engine]} · ${DV_HINT(c)}`;
const STAR = 'M10 1.8l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8L10 1.8Z';

type Form = Required<Pick<DvConnectionInput, 'name' | 'engine' | 'host' | 'port' | 'user' | 'database' | 'file' | 'color' | 'method' | 'socket'>> &
  Pick<DvConnectionInput, 'id' | 'password' | 'sshSecret' | 'awsSecret' | 'vaultToken' | 'temporary'> & {
    ssh: NonNullable<DvConnectionInput['ssh']>;
    aws: NonNullable<DvConnectionInput['aws']>;
    vault: NonNullable<DvConnectionInput['vault']>;
    options: NonNullable<DvConnectionInput['options']>;
  };
const blank = (): Form => ({
  name: '',
  engine: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: '',
  file: '',
  color: COLORS[3],
  method: 'tcp',
  socket: '',
  ssh: { host: '', port: 22, user: '', auth: 'key', keyPath: '' },
  aws: { region: '', profile: '', accessKeyId: '' },
  vault: { addr: '', path: '', namespace: '' },
  options: { ...DV_DEFAULT_OPTIONS },
  sshSecret: '',
  awsSecret: '',
  vaultToken: '',
});
const form = ref<Form>(blank());
const show = ref(false);
const busy = ref<'test' | 'save' | 'connect' | null>(null);
const testToken = ref('');
const removing = ref<DvConnection | null>(null);
const sshKeys = ref<string[]>([]);
const awsProfiles = ref<string[]>([]);
onMounted(async () => {
  layout.value = (await api.dvLayout().catch(() => null)) ?? layout.value;
  await checkDevCatz();
  [sshKeys.value, awsProfiles.value] = await Promise.all([api.dvSshKeys().catch(() => []), api.dvAwsProfiles().catch(() => [])]);
  if (!form.value.ssh.keyPath) form.value.ssh.keyPath = sshKeys.value.find((k) => /ed25519/.test(k)) ?? sshKeys.value[0] ?? '';
});

/** Secrets of a stored connection come back as null ("keep"), shown as •••. */
watch(
  editing,
  (c) => {
    testToken.value = '';
    if (!c) return void (form.value = { ...blank(), ssh: { ...blank().ssh, keyPath: sshKeys.value[0] ?? '' } });
    form.value = {
      id: c.id,
      name: c.name,
      engine: c.engine,
      host: c.host,
      port: c.port,
      user: c.user,
      password: null,
      database: c.database,
      file: c.file,
      color: c.color ?? COLORS[3],
      method: c.method,
      socket: c.socket,
      ssh: c.ssh ?? blank().ssh,
      aws: c.aws ?? blank().aws,
      vault: c.vault ?? blank().vault,
      options: { ...DV_DEFAULT_OPTIONS, ...c.options },
      sshSecret: null,
      awsSecret: null,
      vaultToken: null,
      temporary: c.temporary,
    };
  },
  { immediate: true },
);
watch(
  () => form.value.engine,
  (e, old) => {
    if (form.value.port === DEFAULT_PORT[old] || !form.value.port) form.value.port = DEFAULT_PORT[e];
    if (e === 'postgresql' && !form.value.database) form.value.database = 'postgres';
    if ((e === 'mysql' || e === 'mariadb' || e === 'postgresql') && !form.value.user) form.value.user = 'root';
    if (e === 'redis' || e === 'valkey' || e === 'mongodb' || e === 'elasticsearch') form.value.user = form.value.user === 'root' ? '' : form.value.user;
    if (!methods.value.includes(form.value.method)) form.value.method = 'tcp';
    testToken.value = '';
  },
);
const methods = computed(() => dvMethods(form.value.engine));
const support = computed(() => dvOptionSupport(form.value.engine, form.value.method));
const sqlTz = computed(() => form.value.engine === 'mysql' || form.value.engine === 'mariadb' || form.value.engine === 'postgresql');
const m = computed(() => form.value.method);
watch(m, (v) => {
  if (v === 'socket' && !form.value.socket) form.value.socket = form.value.engine === 'postgresql' ? '/tmp' : form.value.engine === 'mysql' || form.value.engine === 'mariadb' ? '/tmp/mysql.sock' : form.value.engine === 'mongodb' ? `/tmp/mongodb-${form.value.port}.sock` : '/tmp/redis.sock';
  if (v === 'ssh' && (!form.value.host || form.value.host === 'localhost')) form.value.host = '127.0.0.1';
  if (v === 'aws-iam') form.value.options.requireSsl = true;
  testToken.value = '';
});
const regionHint = computed(() => /\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.rds\.amazonaws\.com/i.exec(form.value.host)?.[1] ?? '');

const MODES: { id: DvMode; name: string; hint: string; dot: string }[] = [
  { id: 'normal', name: 'Normal', hint: 'Edit freely; risky changes still ask.', dot: 'oklch(70% 0.02 250)' },
  { id: 'production', name: 'Production', hint: 'Asks before every write; marked PROD.', dot: 'oklch(65% 0.2 25)' },
  { id: 'readonly', name: 'Read-only', hint: 'Only reads; the server session is read-only too.', dot: 'oklch(70% 0.13 235)' },
];
const OPTION_INFO: { key: DvOptionKey; label: string; insecure?: boolean; hint: string }[] = [
  { key: 'localInfile', label: 'Allow LOCAL_DATA_INFILE', insecure: true, hint: 'LOAD DATA LOCAL INFILE: the server may read files from this Mac.' },
  { key: 'cleartext', label: 'Enable Cleartext plugin', insecure: true, hint: 'mysql_clear_password (LDAP / PAM users): the password travels as is, so use it with SSL.' },
  { key: 'requireSsl', label: 'Require SSL', hint: 'Encrypt the connection (MySQL ssl, PostgreSQL sslmode=require, rediss, Mongo tls, https).' },
  { key: 'getPublicKey', label: 'Get Public Key', hint: 'MySQL 8 caching_sha2_password without SSL: let the server send its RSA key.' },
];
function toggle(k: DvOptionKey) {
  if (support.value[k] !== true) return;
  form.value.options[k] = !form.value.options[k];
}
/** Options the engine + method take (the rest are hidden, with one note for AWS IAM). */
const optionsShown = computed(() => OPTION_INFO.filter((o) => support.value[o.key] === true));
const advanced = ref(false);
/** How the connection is set up: a pasted URL, or the fields. */
const setup = ref<'url' | 'manual'>('manual');
/** One line about the advanced options while they are folded. */
const summary = computed(() => {
  const o = form.value.options;
  const parts: string[] = [];
  if (m.value === 'aws-iam') parts.push('SSL (RDS certificates)');
  else parts.push(o.requireSsl ? (o.verifyCert ? 'SSL, certificate verified' : 'SSL, any certificate') : 'no SSL');
  if (o.localInfile && support.value.localInfile === true) parts.push('LOCAL INFILE on');
  if (o.cleartext && support.value.cleartext === true) parts.push('cleartext plugin');
  if (sqlTz.value) parts.push(o.timeZone ? `time zone ${o.timeZone}` : 'server time zone');
  parts.push(`${o.connectTimeout || 15} s timeout`);
  return parts.join(' · ');
});
watch(editing, (c) => (advanced.value = !!c && (c.options.requireSsl || c.options.localInfile || c.options.cleartext || !!c.options.timeZone)));

const plain = (): DvConnectionInput => {
  const f = JSON.parse(JSON.stringify(form.value)) as Form;
  return { ...f, port: Number(f.port), ssh: { ...f.ssh, port: Number(f.ssh.port) || 22 }, options: { ...f.options, connectTimeout: Number(f.options.connectTimeout) || 15 } };
};

async function test() {
  busy.value = 'test';
  testToken.value = newToken('test');
  const t = testToken.value;
  const failed = await api.dvTestConnection(plain(), t).then(
    () => null,
    (e: Error) => String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
  );
  busy.value = null;
  // The outcome shows in the progress panel; a check that failed before connecting (missing host …) has no panel.
  if (failed && !progress.get(t)) {
    testToken.value = '';
    notify('error', failed);
  }
}
async function save(andConnect: boolean) {
  busy.value = andConnect ? 'connect' : 'save';
  const c = await attempt(() => api.dvSaveConnection({ ...plain(), temporary: false }));
  busy.value = null;
  if (!c) return;
  await refreshConnections();
  notify('success', `${c.name} saved`);
  editing.value = null;
  if (andConnect) openTab(c);
}
function edit(c: DvConnection) {
  editing.value = c;
}
async function remove() {
  const c = removing.value!;
  if (await attempt(() => api.dvDeleteConnection(c.id).then(() => true))) {
    removing.value = null;
    if (editing.value?.id === c.id) editing.value = null;
    await refreshConnections();
  }
}
async function pickFile() {
  const f = await api.dvPickSqlite();
  if (f) {
    form.value.file = f;
    if (!form.value.name) form.value.name = f.split('/').pop() ?? 'SQLite';
  }
}
async function pickKey() {
  const f = await api.pickFile('SSH private key');
  if (f) form.value.ssh.keyPath = f;
}

// ---- connection URL
const url = ref('');
const urlError = ref('');
function fromUrl(): DvConnectionInput | null {
  urlError.value = '';
  try {
    const p = parseDbUrl(url.value);
    return { ...p, color: COLORS[3] };
  } catch (e) {
    urlError.value = (e as Error).message;
    return null;
  }
}
function fillFromUrl() {
  const p = fromUrl();
  if (!p) return;
  editing.value = null;
  setup.value = 'manual';
  form.value = { ...blank(), ...p, ssh: blank().ssh, aws: blank().aws, vault: blank().vault, options: { ...DV_DEFAULT_OPTIONS, ...p.options }, method: p.method ?? 'tcp', socket: p.socket ?? '', password: p.password ?? '' } as Form;
  notify('info', 'Filled in from the URL: check it, then Test or Connect');
}
async function connectUrl() {
  const p = fromUrl();
  if (!p) return;
  const c = await attempt(() => api.dvSaveConnection({ ...p, temporary: true }));
  if (!c) return;
  await refreshConnections();
  url.value = '';
  openTab(c);
}
async function keep(c: DvConnection) {
  editing.value = c;
  notify('info', 'Give it a name, then Save to keep it');
}
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <!-- Connections list -->
    <aside class="flex w-[340px] shrink-0 flex-col border-r border-base-300/60 bg-base-200/40" @dragend="endDrag">
      <div class="flex items-center gap-1.5 pt-4 pr-4 pb-2 pl-2">
        <DvNavButtons />
        <label class="input input-sm flex min-w-0 flex-1 items-center gap-2">
          <svg viewBox="0 0 20 20" class="size-4 opacity-50" fill="currentColor"><path d="M8.5 3a5.5 5.5 0 1 0 3.4 9.8l3.6 3.6a1 1 0 0 0 1.4-1.4l-3.6-3.6A5.5 5.5 0 0 0 8.5 3ZM5 8.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0Z" /></svg>
          <input v-model="filter" class="grow" placeholder="Find a connection" spellcheck="false" />
        </label>
        <PopMenu :items="listView.items.value" align="end" :width="260">
          <button type="button" class="btn btn-ghost btn-sm btn-square" :class="{ 'text-primary': listView.custom.value }" title="Sort and group">
            <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path d="M2.5 5.25A.75.75 0 0 1 3.25 4.5h13.5a.75.75 0 0 1 0 1.5H3.25a.75.75 0 0 1-.75-.75Zm2 4A.75.75 0 0 1 5.25 8.5h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Zm2 4a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" /></svg>
          </button>
        </PopMenu>
      </div>
      <div class="flex-1 overflow-y-auto px-3 pb-4">
        <section v-for="sec in sections" :key="sec.key" class="mt-2">
          <div
            class="dv-sec-head"
            :class="{ 'is-drop': dropSection === sec.key }"
            @dragover.prevent="dropSection = sec.key"
            @dragleave="dropSection = dropSection === sec.key ? null : dropSection"
            @drop.prevent="onDropSection(sec)"
            @contextmenu.prevent="sec.group && groupMenu($event, sec.group)"
          >
            <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left" @click="toggleSection(sec)">
              <svg class="size-3 shrink-0 transition-transform" :class="{ '-rotate-90': sec.collapsed }" viewBox="0 0 20 20" fill="currentColor"><path d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" /></svg>
              <svg v-if="sec.key === 'fav'" class="size-3 shrink-0 text-warning" viewBox="0 0 20 20" fill="currentColor"><path :d="STAR" /></svg>
              <svg v-else-if="sec.group" class="size-3 shrink-0 opacity-70" viewBox="0 0 20 20" fill="currentColor"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4l2 2h7A1.5 1.5 0 0 1 18 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5v-9Z" /></svg>
              <span class="truncate">{{ sec.title }}</span>
            </button>
            <span class="opacity-60">{{ sec.items.length }}</span>
            <button v-if="sec.group" type="button" class="dv-row-more" title="Group menu" @click.stop="groupMenu($event, sec.group)">⋯</button>
          </div>
          <template v-if="!sec.collapsed">
            <DvDevCatzInstall v-if="sec.key === 'svc' && !devcatzApp && sec.items.length" kind="missing" :count="sec.items.length" />
            <div
              v-for="c in sec.items"
              :key="sec.key + c.id"
              class="dv-conn dv-row group"
              :class="{ 'is-editing': editing?.id === c.id, 'drop-before': dropRow === c.id && dragId !== c.id, 'opacity-50': dragId === c.id || (c.serviceId && !devcatzApp && !c.connected) }"
              draggable="true"
              @dragstart="dragId = c.id"
              @dragover.prevent.stop="dropRow = c.id"
              @dragleave="dropRow = dropRow === c.id ? null : dropRow"
              @drop.prevent.stop="onDropRow(c, sec)"
              @click="openTab(c)"
              @contextmenu.prevent="connMenu($event, c)"
            >
              <span v-if="c.color" class="dv-row-accent" :style="{ background: c.color }" />
              <span class="dv-row-logo">
                <img :src="DB_LOGO[c.engine]" alt="" draggable="false" />
                <span class="dv-presence" :class="c.connected ? 'is-on' : c.serviceId && !c.running ? 'is-off' : ''" :title="c.connected ? 'Connected' : c.serviceId && !c.running ? 'Service stopped' : 'Not connected'" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="truncate text-[13.5px] font-semibold">{{ c.name }}</span>
                  <svg v-if="favs.has(c.id) && sec.key !== 'fav'" class="size-3 shrink-0 text-warning" viewBox="0 0 20 20" fill="currentColor"><path :d="STAR" /></svg>
                </span>
                <span class="mt-0.5 block truncate font-mono text-[11px] opacity-55">{{ rowHint(c) }}</span>
                <span class="mt-1.5 flex flex-wrap items-center gap-1">
                  <span class="dv-chip" :class="`is-${modeOf(c)}`"><i />{{ MODE_LABEL[modeOf(c)] }}</span>
                  <span v-if="c.method !== 'tcp'" class="dv-chip">{{ DV_METHOD_NAME[c.method] }}</span>
                  <span v-if="c.connected" class="dv-chip is-on">Connected</span>
                  <span v-else-if="c.serviceId && !devcatzApp" class="dv-chip is-muted" title="DevCatz is not installed, so this service cannot start">DevCatz not installed</span>
                  <span v-else-if="c.serviceId && !c.running && c.engine !== 'sqlite'" class="dv-chip is-muted">Stopped</span>
                </span>
              </span>
              <span class="dv-row-actions">
                <button v-if="c.connected" type="button" class="dv-row-act" title="Disconnect" @click.stop="disconnectConn(c)">
                  <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M10 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm-4.2 3.3a1 1 0 0 1 0 1.4 5 5 0 1 0 8.4 0 1 1 0 1 1 1.4-1.4 7 7 0 1 1-11.2 0 1 1 0 0 1 1.4 0Z" /></svg>
                </button>
                <button type="button" class="dv-row-act" title="Open in a new tab" @click.stop="openTab(c, { fresh: true })">
                  <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
                </button>
                <button type="button" class="dv-row-act" title="More" @click.stop="connMenu($event, c)">⋯</button>
              </span>
            </div>
            <p v-if="!sec.items.length && sec.empty" class="px-3 py-1.5 text-[11px] opacity-50">{{ sec.empty }}</p>
          </template>
        </section>
        <section v-if="!devcatzApp && !sections.some((x) => x.key === 'svc')" class="mt-3">
          <div class="dv-sec-head"><span class="flex-1">DevCatz services</span></div>
          <DvDevCatzInstall kind="none" />
        </section>
        <section v-if="session.length" class="mt-3">
          <div class="dv-sec-head"><span class="flex-1">Opened from a URL</span><span class="opacity-60">{{ session.length }}</span></div>
          <div v-for="c in session.filter(match)" :key="c.id" class="dv-conn dv-row group" @click="openTab(c)" @contextmenu.prevent="showMenu($event, [{ label: 'Open', action: () => openTab(c) }, ...(c.connected ? [{ label: 'Disconnect', action: () => void disconnectConn(c) }] : []), { label: 'Save…', action: () => keep(c), separator: true }, { label: 'Forget', danger: true, action: () => (removing = c) }])">
            <span class="dv-row-logo">
              <img :src="DB_LOGO[c.engine]" alt="" draggable="false" />
              <span class="dv-presence" :class="{ 'is-on': c.connected }" :title="c.connected ? 'Connected' : 'Not connected'" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13.5px] font-semibold">{{ c.name }}</span>
              <span class="mt-0.5 block truncate font-mono text-[11px] opacity-55">{{ rowHint(c) }}</span>
              <span class="mt-1.5 flex flex-wrap items-center gap-1">
                <span class="dv-chip" :class="`is-${modeOf(c)}`"><i />{{ MODE_LABEL[modeOf(c)] }}</span>
                <span class="dv-chip is-muted">This session</span>
                <span v-if="c.connected" class="dv-chip is-on">Connected</span>
              </span>
            </span>
            <span class="dv-row-actions">
              <button v-if="c.connected" type="button" class="dv-row-act" title="Disconnect" @click.stop="disconnectConn(c)">
                <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M10 2a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm-4.2 3.3a1 1 0 0 1 0 1.4 5 5 0 1 0 8.4 0 1 1 0 1 1 1.4-1.4 7 7 0 1 1-11.2 0 1 1 0 0 1 1.4 0Z" /></svg>
              </button>
              <button type="button" class="dv-row-act !w-auto px-1.5 text-[11px]" title="Keep it as a saved connection" @click.stop="keep(c)">Save…</button>
            </span>
          </div>
        </section>
      </div>
    </aside>

    <!-- Row / group menu -->
    <template v-if="menu">
      <div class="fixed inset-0 z-40" @click="menu = null" @contextmenu.prevent="menu = null" />
      <ul role="menu" class="menu fixed z-50 w-56 rounded-box border border-base-300 bg-base-100 p-1.5 text-sm shadow-xl" :style="{ top: `${menu.y}px`, left: `${menu.x}px` }">
        <template v-for="(it, i) in menu.items" :key="i">
          <li v-if="it.separator" class="my-1 h-px bg-base-300/70" />
          <li v-if="it.heading" class="menu-title px-2 pt-1 pb-0.5 text-[10px] tracking-wide uppercase opacity-50">{{ it.label }}</li>
          <li v-else :class="{ disabled: it.disabled }">
            <button type="button" :class="{ 'text-error': it.danger }" :disabled="it.disabled" @click="run(it)">
              <span class="w-3 text-center">{{ it.checked ? '✓' : '' }}</span>{{ it.label }}
            </button>
          </li>
        </template>
      </ul>
    </template>
    <DvPrompt v-if="groupDialog" :title="groupDialog.mode === 'new' ? 'New group' : `Rename ${groupDialog.from}`" label="Group name" :initial="groupDialog.from ?? ''" placeholder="e.g. Production" :confirm="groupDialog.mode === 'new' ? 'Create & move' : 'Rename'" @ok="saveGroupName" @cancel="groupDialog = null" />

    <!-- New / edit connection -->
    <div class="flex-1 overflow-y-auto">
      <form class="mx-auto max-w-2xl px-8 pt-8 pb-10" @submit.prevent="save(true)">
        <h1 class="text-xl font-semibold tracking-tight">{{ editing ? (editing.temporary ? `Save ${editing.name}` : `Edit ${editing.name}`) : 'New connection' }}</h1>
        <p class="mt-1 mb-5 text-sm opacity-60">{{ editing ? 'Change anything below, then Save.' : 'Local, behind SSH, on AWS RDS or with credentials from Vault.' }}</p>

        <div v-if="!editing" role="tablist" class="seg mb-6">
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': setup === 'manual' }" @click="setup = 'manual'">Set up by hand</a>
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': setup === 'url' }" @click="setup = 'url'">From a URL</a>
        </div>

        <!-- From a URL -->
        <div v-if="!editing && setup === 'url'" class="dv-card">
          <div class="dv-card-body space-y-3">
            <label class="block">
              <span class="dv-label">Connection URL</span>
              <textarea v-model="url" class="textarea w-full font-mono text-xs leading-relaxed" rows="3" placeholder="mysql://user:password@db.example.com:3306/shop?ssl=true&#10;postgres://… · redis://… · mongodb+srv://… · https://… (Elasticsearch) · sqlite:///path/app.db" spellcheck="false" autocomplete="off" @keydown.enter.prevent="connectUrl" />
            </label>
            <p v-if="urlError" class="text-xs text-error">{{ urlError }}</p>
            <p v-else class="text-[11px] opacity-50">A DATABASE_URL / REDIS_URL line copied from a .env works too. ?ssl, sslmode, tls, socket and connect_timeout are read. Special characters in the password must be %-encoded.</p>
            <div class="flex items-center gap-2 pt-1">
              <span class="text-xs opacity-55">Connect opens it for this session; Fill in moves it to the form so you can name and save it.</span>
              <span class="flex-1" />
              <button type="button" class="btn btn-sm" :disabled="!url.trim()" @click="fillFromUrl">Fill in the form</button>
              <button type="button" class="btn btn-primary btn-sm" :disabled="!url.trim()" @click="connectUrl">Connect</button>
            </div>
          </div>
        </div>

        <template v-if="editing || setup === 'manual'">
        <!-- Name & colour -->
        <div class="dv-card mb-5">
          <div class="dv-card-body grid grid-cols-6 gap-3">
            <label class="col-span-4 block"><span class="dv-label">Name</span><input v-model="form.name" class="input input-sm w-full" placeholder="e.g. Shop production" required spellcheck="false" /></label>
            <div class="col-span-2">
              <span class="dv-label">Tab colour</span>
              <span class="flex h-8 items-center gap-1.5">
                <button v-for="c in COLORS" :key="c" type="button" class="size-5 rounded-full ring-offset-2 ring-offset-base-100 transition" :class="form.color === c ? 'ring-2 ring-base-content/60' : 'hover:scale-110'" :style="{ background: c }" @click="form.color = c" />
              </span>
            </div>
            <div class="col-span-6">
              <span class="dv-label">Safety</span>
              <div class="grid grid-cols-3 gap-2">
                <button v-for="mo in MODES" :key="mo.id" type="button" class="dv-choice" :class="{ 'is-active': form.options.mode === mo.id }" @click="form.options.mode = mo.id">
                  <span class="flex items-center gap-1.5 font-medium"><span class="size-2 rounded-full" :style="{ background: mo.dot }" />{{ mo.name }}</span>
                  <span class="block text-[11px] leading-snug opacity-60">{{ mo.hint }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Engine -->
        <div class="mb-5 grid grid-cols-4 gap-2">
          <button v-for="e in ENGINES" :key="e" type="button" class="dv-engine" :class="{ 'is-active': form.engine === e }" @click="form.engine = e">
            <img :src="DB_LOGO[e]" alt="" class="size-6 rounded bg-white p-0.5" draggable="false" />{{ ENGINE_NAME[e] }}
          </button>
        </div>

        <!-- Server -->
        <div class="dv-card">
          <div class="dv-card-head">
            <h3>Server</h3>
            <div v-if="form.engine !== 'sqlite'" role="tablist" class="seg seg-xs">
              <a v-for="x in methods" :key="x" role="tab" class="seg-item normal-case" :class="{ 'is-active': form.method === x }" @click="form.method = x as DvMethod">{{ DV_METHOD_NAME[x as DvMethod] }}</a>
            </div>
          </div>

          <!-- SQLite: a file -->
          <div v-if="form.engine === 'sqlite'" class="dv-card-body">
            <label class="block">
              <span class="dv-label">Database file or folder</span>
              <div class="join w-full">
                <input v-model="form.file" class="input input-sm join-item w-full font-mono text-xs" placeholder="/path/to/app.sqlite" required spellcheck="false" />
                <button type="button" class="btn btn-sm join-item" @click="pickFile">Choose…</button>
              </div>
            </label>
          </div>

          <template v-else>
            <!-- Through an SSH host -->
            <div v-if="m === 'ssh'" class="dv-sub">
              <p class="dv-sub-title">Through an SSH host <span class="font-normal opacity-60">— DBCatz opens the tunnel itself</span></p>
              <div class="grid grid-cols-6 gap-3">
                <label class="col-span-4 block"><span class="dv-label">SSH host</span><input v-model="form.ssh.host" class="input input-sm w-full font-mono" placeholder="bastion.example.com" required spellcheck="false" /></label>
                <label class="col-span-2 block"><span class="dv-label">Port</span><input v-model.number="form.ssh.port" type="number" min="1" max="65535" class="input input-sm w-full font-mono" /></label>
                <label class="col-span-2 block"><span class="dv-label">User</span><input v-model="form.ssh.user" class="input input-sm w-full font-mono" placeholder="ubuntu" required spellcheck="false" autocomplete="off" /></label>
                <label class="col-span-2 block">
                  <span class="dv-label">Sign in with</span>
                  <select v-model="form.ssh.auth" class="select select-sm w-full"><option value="key">Private key</option><option value="password">Password</option><option value="agent">ssh-agent</option></select>
                </label>
                <label v-if="form.ssh.auth !== 'agent'" class="col-span-2 block">
                  <span class="dv-label">{{ form.ssh.auth === 'key' ? 'Passphrase' : 'Password' }}</span>
                  <input v-model="form.sshSecret" :type="show ? 'text' : 'password'" class="input input-sm w-full font-mono" :placeholder="editing?.hasSshSecret && form.sshSecret === null ? '•••• (kept)' : form.ssh.auth === 'key' ? 'if any' : ''" autocomplete="new-password" @focus="form.sshSecret === null && (form.sshSecret = '')" />
                </label>
                <p v-else class="col-span-2 self-end pb-2 text-[11px] opacity-55">Keys from ssh-agent</p>
                <label v-if="form.ssh.auth === 'key'" class="col-span-6 block">
                  <span class="dv-label">Private key</span>
                  <div class="join w-full">
                    <input v-model="form.ssh.keyPath" class="input input-sm join-item w-full font-mono text-xs" list="dv-ssh-keys" placeholder="~/.ssh/id_ed25519" spellcheck="false" />
                    <button type="button" class="btn btn-sm join-item" @click="pickKey">Choose…</button>
                  </div>
                  <datalist id="dv-ssh-keys"><option v-for="k in sshKeys" :key="k" :value="k" /></datalist>
                </label>
              </div>
            </div>

            <!-- AWS IAM -->
            <div v-if="m === 'aws-iam'" class="dv-sub">
              <p class="dv-sub-title">AWS IAM <span class="font-normal opacity-60">— a 15-minute token signs in; SSL with Amazon’s RDS certificates is always on</span></p>
              <div class="grid grid-cols-6 gap-3">
                <label class="col-span-2 block"><span class="dv-label">Region</span><input v-model="form.aws.region" class="input input-sm w-full font-mono" :placeholder="regionHint || 'ap-southeast-1'" spellcheck="false" /></label>
                <label class="col-span-4 block">
                  <span class="dv-label">Credentials</span>
                  <select v-model="form.aws.profile" class="select select-sm w-full font-mono">
                    <option value="">{{ form.aws.accessKeyId ? 'the access key below' : 'default profile / environment' }}</option>
                    <option v-for="p in awsProfiles" :key="p" :value="p">profile {{ p }}</option>
                  </select>
                </label>
                <label class="col-span-3 block"><span class="dv-label">Access key ID <span class="normal-case opacity-50">(optional)</span></span><input v-model="form.aws.accessKeyId" class="input input-sm w-full font-mono" placeholder="AKIA…" spellcheck="false" autocomplete="off" /></label>
                <label class="col-span-3 block"><span class="dv-label">Secret access key</span><input v-model="form.awsSecret" :type="show ? 'text' : 'password'" class="input input-sm w-full font-mono" :placeholder="editing?.hasAwsSecret && form.awsSecret === null ? '•••• (kept)' : ''" autocomplete="new-password" :disabled="!form.aws.accessKeyId" @focus="form.awsSecret === null && (form.awsSecret = '')" /></label>
              </div>
            </div>

            <!-- Vault -->
            <div v-if="m === 'vault'" class="dv-sub">
              <p class="dv-sub-title">HashiCorp Vault <span class="font-normal opacity-60">— the user name and password are read from the secret each time</span></p>
              <div class="grid grid-cols-6 gap-3">
                <label class="col-span-4 block"><span class="dv-label">Address</span><input v-model="form.vault.addr" class="input input-sm w-full font-mono" placeholder="https://vault.example.com:8200" required spellcheck="false" /></label>
                <label class="col-span-2 block"><span class="dv-label">Namespace <span class="normal-case opacity-50">(optional)</span></span><input v-model="form.vault.namespace" class="input input-sm w-full font-mono" spellcheck="false" /></label>
                <label class="col-span-3 block"><span class="dv-label">Secret path</span><input v-model="form.vault.path" class="input input-sm w-full font-mono" placeholder="database/creds/readonly" required spellcheck="false" /></label>
                <label class="col-span-3 block"><span class="dv-label">Token</span><input v-model="form.vaultToken" :type="show ? 'text' : 'password'" class="input input-sm w-full font-mono" :placeholder="editing?.hasVaultToken && form.vaultToken === null ? '•••• (kept)' : 'hvs.…'" autocomplete="new-password" @focus="form.vaultToken === null && (form.vaultToken = '')" /></label>
              </div>
            </div>

            <!-- Address -->
            <div class="dv-card-body">
              <div v-if="m === 'socket'" class="grid grid-cols-6 gap-3">
                <label :class="form.engine === 'postgresql' ? 'col-span-4' : 'col-span-6'" class="block">
                  <span class="dv-label">Socket {{ form.engine === 'postgresql' ? 'folder or file' : 'file' }}</span>
                  <input v-model="form.socket" class="input input-sm w-full font-mono" :placeholder="form.engine === 'postgresql' ? '/tmp or /var/run/postgresql' : '/tmp/mysql.sock'" required spellcheck="false" />
                </label>
                <label v-if="form.engine === 'postgresql'" class="col-span-2 block"><span class="dv-label">Port</span><input v-model.number="form.port" type="number" class="input input-sm w-full font-mono" title="PostgreSQL names its socket after the port" /></label>
              </div>
              <div v-else class="grid grid-cols-6 gap-3">
                <label class="col-span-4 block">
                  <span class="dv-label">{{ m === 'ssh' ? 'Database host, as seen from the SSH host' : m === 'aws-iam' ? 'RDS endpoint' : form.options.srv ? 'SRV host' : 'Host' }}</span>
                  <input v-model="form.host" class="input input-sm w-full font-mono" :placeholder="m === 'aws-iam' ? 'mydb.abc123.ap-southeast-1.rds.amazonaws.com' : m === 'ssh' ? '127.0.0.1' : 'db.example.com'" required spellcheck="false" />
                </label>
                <label class="col-span-2 block"><span class="dv-label">Port</span><input v-model.number="form.port" type="number" min="1" max="65535" class="input input-sm w-full font-mono" required :disabled="form.options.srv" /></label>
                <label v-if="form.engine === 'mongodb'" class="col-span-6 flex cursor-pointer items-center gap-2 text-xs opacity-80"><input v-model="form.options.srv" type="checkbox" class="checkbox checkbox-xs" />Atlas / mongodb+srv (the host is an SRV record)</label>
              </div>
            </div>
          </template>
        </div>

        <!-- Login -->
        <div v-if="form.engine !== 'sqlite'" class="dv-card">
          <div class="dv-card-head"><h3>Login</h3><span v-if="m === 'vault'" class="text-xs opacity-55">from Vault</span><span v-else-if="m === 'aws-iam'" class="text-xs opacity-55">IAM token instead of a password</span></div>
          <div class="dv-card-body grid grid-cols-6 gap-3">
            <label v-if="m !== 'vault'" :class="m === 'aws-iam' ? 'col-span-6' : 'col-span-3'" class="block">
              <span class="dv-label">{{ m === 'aws-iam' ? 'Database user with IAM auth' : 'User' }} <span v-if="m !== 'aws-iam' && form.engine !== 'mysql' && form.engine !== 'mariadb' && form.engine !== 'postgresql'" class="normal-case opacity-50">(optional)</span></span>
              <input v-model="form.user" class="input input-sm w-full font-mono" spellcheck="false" autocomplete="off" :required="m === 'aws-iam'" />
            </label>
            <label v-if="m !== 'vault' && m !== 'aws-iam'" class="col-span-3 block">
              <span class="dv-label">Password</span>
              <div class="join w-full">
                <input v-model="form.password" :type="show ? 'text' : 'password'" class="input input-sm join-item w-full font-mono" :placeholder="editing?.hasPassword && form.password === null ? '•••••••• (kept)' : 'none'" spellcheck="false" autocomplete="new-password" @focus="form.password === null && (form.password = '')" />
                <button type="button" class="btn btn-sm join-item" @click="show = !show">{{ show ? 'Hide' : 'Show' }}</button>
              </div>
            </label>
            <label v-if="form.engine === 'postgresql' || form.engine === 'mysql' || form.engine === 'mariadb' || form.engine === 'mongodb'" class="col-span-6 block">
              <span class="dv-label">Database <span class="normal-case opacity-50">{{ form.engine === 'postgresql' ? '(opened first; others from the sidebar)' : form.engine === 'mongodb' ? '(also the auth database)' : '(optional: opened first)' }}</span></span>
              <input v-model="form.database" class="input input-sm w-full font-mono" spellcheck="false" />
            </label>
          </div>
        </div>

        <!-- Advanced (folded) -->
        <div v-if="form.engine !== 'sqlite'" class="dv-card">
          <button type="button" class="dv-card-head w-full text-left" @click="advanced = !advanced">
            <h3>Advanced</h3>
            <span class="min-w-0 flex-1 truncate text-xs opacity-55">{{ summary }}</span>
            <svg viewBox="0 0 20 20" class="size-4 shrink-0 opacity-60 transition-transform" :class="{ 'rotate-180': advanced }" fill="currentColor"><path d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" /></svg>
          </button>
          <div v-if="advanced" class="dv-card-body space-y-4">
            <p v-if="m === 'aws-iam'" class="rounded-lg bg-base-200/60 px-3 py-2 text-xs opacity-70">AWS IAM always connects over SSL with Amazon’s RDS certificates and the cleartext plugin, so those are set for you.</p>
            <div v-if="optionsShown.length" class="space-y-0.5">
              <label v-for="o in optionsShown" :key="o.key" class="dv-toggle">
                <input type="checkbox" class="toggle toggle-sm mt-0.5" :class="o.insecure ? 'toggle-warning' : 'toggle-primary'" :checked="!!form.options[o.key]" @change="toggle(o.key)" />
                <span class="min-w-0">
                  <span class="block text-[13px] font-medium">{{ o.label }}<span v-if="o.insecure" class="ml-1 text-[11px] font-normal text-warning">insecure</span></span>
                  <span class="block text-[11px] leading-snug opacity-55">{{ o.hint }}</span>
                </span>
              </label>
              <label v-if="form.options.requireSsl && support.requireSsl === true" class="dv-toggle">
                <input v-model="form.options.verifyCert" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
                <span class="min-w-0"><span class="block text-[13px] font-medium">Verify the server certificate</span><span class="block text-[11px] leading-snug opacity-55">Turn off for a self-signed certificate.</span></span>
              </label>
            </div>
            <div class="grid grid-cols-6 gap-3">
              <label class="col-span-3 block">
                <span class="dv-label">Time zone</span>
                <input v-model="form.options.timeZone" class="input input-sm w-full font-mono" list="dv-tz" :placeholder="sqlTz ? 'Use Server Time Zone' : 'n/a'" :disabled="!sqlTz" spellcheck="false" />
                <datalist id="dv-tz">
                  <option value="+00:00">UTC</option>
                  <option value="+07:00">WIB (Asia/Jakarta)</option>
                  <option value="+08:00">WITA (Asia/Makassar)</option>
                  <option value="+09:00">WIT (Asia/Jayapura)</option>
                  <option value="Asia/Jakarta" />
                  <option value="Asia/Makassar" />
                  <option value="Asia/Singapore" />
                  <option value="UTC" />
                </datalist>
                <span class="mt-1 block text-[11px] opacity-50">{{ sqlTz ? (form.options.timeZone ? `Each session runs SET ${form.engine === 'postgresql' ? 'TIME ZONE' : 'time_zone ='} ${form.options.timeZone}` : 'Empty: the server’s time zone') : 'MySQL, MariaDB and PostgreSQL only' }}</span>
              </label>
              <label class="col-span-3 block">
                <span class="dv-label">Connect timeout</span>
                <div class="join w-full">
                  <input v-model.number="form.options.connectTimeout" type="number" min="3" max="300" class="input input-sm join-item w-full font-mono" />
                  <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 text-xs opacity-70">seconds</span>
                </div>
              </label>
            </div>
          </div>
        </div>

        </template>

        <DvProgress v-if="testToken && (editing || setup === 'manual')" :key="testToken" :progress="progress.get(testToken) ?? null" title="Testing the connection…" class="mt-5" @cancel="api.dvCancelConnect(testToken)" />

        <div v-if="editing || setup === 'manual'" class="mt-5 flex items-center gap-2">
          <button type="button" class="btn btn-sm" :disabled="!!busy" @click="test"><span v-if="busy === 'test'" class="loading loading-spinner loading-xs" />Test connection</button>
          <span class="flex-1" />
          <button v-if="editing" type="button" class="btn btn-ghost btn-sm" :disabled="busy === 'save' || busy === 'connect'" @click="editing = null">Cancel</button>
          <button type="button" class="btn btn-sm" :disabled="busy === 'save' || busy === 'connect'" @click="save(false)"><span v-if="busy === 'save'" class="loading loading-spinner loading-xs" />Save</button>
          <button class="btn btn-primary btn-sm" :disabled="busy === 'save' || busy === 'connect'"><span v-if="busy === 'connect'" class="loading loading-spinner loading-xs" />{{ editing ? 'Save & connect' : 'Connect' }}</button>
        </div>
        <p v-if="editing || setup === 'manual'" class="mt-3 text-[11px] opacity-45">Kept in DBCatz’s settings on this Mac; passwords, passphrases, AWS keys and Vault tokens are encrypted with the macOS Keychain.</p>
      </form>
    </div>

    <ConfirmDialog v-if="removing" :title="`${removing.temporary ? 'Forget' : 'Delete'} ${removing.name}?`" text="Only the connection is removed; the server and its data are untouched." :confirm="removing.temporary ? 'Forget' : 'Delete'" tone="error" @ok="remove" @cancel="removing = null" />
  </div>
</template>
