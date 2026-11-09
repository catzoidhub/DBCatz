import { createApp } from 'vue';
import DbCatzApp from './viewer/DbCatzApp.vue';
import './assets/main.css';
import { currentOS } from '@shared/platform';

// `html.is-win`: CSS for Windows and Linux (the tab strip makes room for the window buttons, no traffic lights on the left).
if (currentOS !== 'mac') document.documentElement.classList.add('is-win');

// A file dropped outside a drop zone must not open in the window.
for (const type of ['dragover', 'drop'] as const)
  document.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });

// The window opens at #viewer=<connection id>[&db=<database>][&table=…&col=…&val=…] (empty: the Connections tab).
const h = new URLSearchParams(location.hash.replace(/^#/, ''));
const opt = (k: string) => h.get(k) ?? undefined;
createApp(DbCatzApp, { connId: h.get('viewer') ?? '', db: h.get('db') ?? '', table: opt('table'), col: opt('col'), val: opt('val') }).mount('#app');
