import { DV_SQL, type DvBulkResult } from '@shared/types';
import { quoteTable, type Driver } from './driver';
import { incomingFks } from './safety';
import * as ops from './ops';

/**
 * Dropping or emptying several tables at once (the sidebar's multi-selection).
 * Foreign keys between the picked tables are fine (they go child first, or in
 * one statement); a table outside the pick that still points at one of them
 * refuses the whole action unless `force` turns the integrity checks off:
 * MySQL / MariaDB FOREIGN_KEY_CHECKS=0, PostgreSQL CASCADE, SQLite
 * foreign_keys=OFF — all in one script so the setting holds for every step.
 */

interface Picked {
  name: string;
  view: boolean;
}

async function picked(d: Driver, db: string, names: string[]): Promise<Picked[]> {
  const all = await d.tables(db, true);
  const out: Picked[] = [];
  for (const n of [...new Set(names)]) {
    const t = all.find((x) => x.name === n);
    if (!t) throw new Error(`No table called ${n} in ${db}`);
    out.push({ name: t.name, view: t.type === 'view' });
  }
  if (!out.length) throw new Error('No table picked');
  return out;
}

/** Who points at whom among the picked tables, and who outside points in. */
async function references(d: Driver, db: string, list: Picked[]): Promise<{ inside: Map<string, Set<string>>; outside: string[] }> {
  const names = new Set(list.map((t) => t.name));
  const inside = new Map<string, Set<string>>();
  const outside: string[] = [];
  for (const t of list.filter((x) => !x.view)) {
    for (const f of await incomingFks(d, db, t.name)) {
      if (f.table === t.name) continue;
      if (names.has(f.table)) inside.set(t.name, (inside.get(t.name) ?? new Set()).add(f.table));
      else outside.push(`${f.table} → ${t.name} (${f.name})`);
    }
  }
  return { inside, outside: [...new Set(outside)] };
}

/** Tables that point at others first, so a parent goes after its children. */
function childFirst(list: Picked[], inside: Map<string, Set<string>>): Picked[] {
  const done = new Set<string>();
  const out: Picked[] = [];
  const visit = (t: Picked, path = new Set<string>()) => {
    if (done.has(t.name) || path.has(t.name)) return;
    path.add(t.name);
    for (const child of inside.get(t.name) ?? []) {
      const c = list.find((x) => x.name === child);
      if (c) visit(c, path);
    }
    done.add(t.name);
    out.push(t);
  };
  for (const t of list) visit(t);
  return out;
}

const refuse = (outside: string[], what: string) => {
  throw new Error(`Other tables point at the ones picked: ${outside.slice(0, 6).join(', ')}${outside.length > 6 ? ` … (${outside.length})` : ''}. ${what} them too, drop those foreign keys, or tick Force (disable integrity checks).`);
};

export async function dropTables(d: Driver, db: string, names: string[], force: boolean): Promise<DvBulkResult> {
  const list = await picked(d, db, names);
  if (!DV_SQL.includes(d.engine)) return each(list, (t) => ops.dropTable(d, db, t.name));
  const { inside, outside } = await references(d, db, list);
  if (outside.length && !force) refuse(outside, 'Pick');
  const order = childFirst(list, inside);
  const q = (t: Picked) => quoteTable(d.engine, t.name);
  const views = order.filter((t) => t.view);
  const tables = order.filter((t) => !t.view);
  const lines: string[] = [];
  if (d.engine === 'postgresql') {
    const cascade = force ? ' CASCADE' : '';
    if (views.length) lines.push(`DROP VIEW ${views.map(q).join(', ')}${cascade};`);
    if (tables.length) lines.push(`DROP TABLE ${tables.map(q).join(', ')}${cascade};`);
  } else {
    if (force) lines.push(d.engine === 'sqlite' ? 'PRAGMA foreign_keys = OFF;' : 'SET FOREIGN_KEY_CHECKS = 0;');
    for (const t of views) lines.push(`DROP VIEW ${q(t)};`);
    for (const t of tables) lines.push(`DROP TABLE ${q(t)};`);
    if (force) lines.push(d.engine === 'sqlite' ? 'PRAGMA foreign_keys = ON;' : 'SET FOREIGN_KEY_CHECKS = 1;');
  }
  await run(d, db, lines, force);
  return { done: order.map((t) => t.name), failed: [] };
}

export async function truncateTables(d: Driver, db: string, names: string[], force: boolean): Promise<DvBulkResult> {
  const all = await picked(d, db, names);
  const skipped = all.filter((t) => t.view).map((t) => ({ table: t.name, error: 'a view has no rows of its own' }));
  const list = all.filter((t) => !t.view);
  if (!list.length) return { done: [], failed: skipped };
  if (!DV_SQL.includes(d.engine)) {
    const r = await each(list, (t) => ops.truncateTable(d, db, t.name));
    return { done: r.done, failed: [...r.failed, ...skipped] };
  }
  const { inside, outside } = await references(d, db, list);
  if (outside.length && !force) refuse(outside, 'Empty');
  // MySQL refuses TRUNCATE on any table a foreign key points at, even from an empty one.
  if (!force && (d.engine === 'mysql' || d.engine === 'mariadb') && inside.size) throw new Error('MySQL refuses TRUNCATE on tables that foreign keys point at, even among the ones picked: tick Force (disable integrity checks).');
  const order = childFirst(list, inside);
  const q = (t: Picked) => quoteTable(d.engine, t.name);
  const lines: string[] = [];
  if (d.engine === 'postgresql') lines.push(`TRUNCATE TABLE ${order.map(q).join(', ')}${force ? ' CASCADE' : ''};`);
  else if (d.engine === 'sqlite') {
    if (force) lines.push('PRAGMA foreign_keys = OFF;');
    for (const t of order) lines.push(`DELETE FROM ${q(t)};`);
    if (force) lines.push('PRAGMA foreign_keys = ON;');
  } else {
    if (force) lines.push('SET FOREIGN_KEY_CHECKS = 0;');
    for (const t of order) lines.push(`TRUNCATE TABLE ${q(t)};`);
    if (force) lines.push('SET FOREIGN_KEY_CHECKS = 1;');
  }
  await run(d, db, lines, force);
  return { done: order.map((t) => t.name), failed: skipped };
}

/** The script in one go; a foreign key error without Force says that Force is the way through. */
async function run(d: Driver, db: string, lines: string[], force: boolean): Promise<void> {
  try {
    await d.exec(db, lines.join('\n'));
  } catch (e) {
    const msg = (e as Error).message;
    if (!force && /foreign key|constraint|no such table|referenc/i.test(msg)) throw new Error(`${msg} — a foreign key stands in the way; tick Force (disable integrity checks) to go ahead anyway.`);
    throw e;
  }
}

/** Collections / indices (no foreign keys): one by one, failures listed. */
async function each(list: Picked[], fn: (t: Picked) => Promise<void>): Promise<DvBulkResult> {
  const r: DvBulkResult = { done: [], failed: [] };
  for (const t of list) {
    try {
      await fn(t);
      r.done.push(t.name);
    } catch (e) {
      r.failed.push({ table: t.name, error: (e as Error).message });
    }
  }
  return r;
}
