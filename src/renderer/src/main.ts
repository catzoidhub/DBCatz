import { createApp } from 'vue';
import DbCatzApp from './viewer/DbCatzApp.vue';
import './assets/main.css';

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
