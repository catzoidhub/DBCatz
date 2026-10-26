import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DvConnection } from '@shared/types';

/**
 * DBCatz's own bridge.json (Catzoid ecosystem; DialCatz reads it for "Check in DBCatz"): the connections DBCatz knows —
 * the saved ones and the DevCatz services it lists — so another Catzoid app can link to one with
 * dbcatz://open?conn=<id>&db=…&table=…&col=…&val=…. Names, engines, hosts, ports and default databases only: never a
 * password, token, user name or connection string. Written in DBCatz's own data folder (folder 0700, file 0600,
 * atomically) at start and whenever the list changes; Uninstall removes it with the folder.
 */

export const bridgeFile = () => process.env.DBCATZ_BRIDGE_FILE || join(app.getPath('userData'), 'bridge.json');

interface BridgeConnection {
  id: string;
  name: string;
  engine: string;
  host: string | null;
  port: number | null;
  database: string | null;
  /** SQLite: the database file (saved) or folder of files (DevCatz service). */
  file?: string;
  source: 'saved' | 'devcatz';
}

/** The ecosystem's engine names (DBCatz says postgresql). */
const ENGINE: Record<string, string> = { postgresql: 'postgres' };

function entry(c: DvConnection): BridgeConnection {
  const sqlite = c.engine === 'sqlite';
  return {
    id: c.id,
    name: c.name,
    engine: ENGINE[c.engine] ?? c.engine,
    host: sqlite ? null : c.host || null,
    port: sqlite ? null : c.port || null,
    database: c.database || null,
    ...(sqlite ? { file: c.file } : {}),
    source: c.serviceId ? 'devcatz' : 'saved',
  };
}

let last = '';

/** Writes the file when the list changed (connections opened from a URL for this session are left out). */
export function writeBridge(connections: DvConnection[]): void {
  const list = connections.filter((c) => !c.temporary).map(entry);
  const body = JSON.stringify(list);
  if (body === last) return;
  try {
    const file = bridgeFile();
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    else chmodSync(dir, 0o700);
    const doc = { schema: 1, app: 'DBCatz', version: app.getVersion(), updatedAt: Date.now(), connections: list };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    last = body;
  } catch (e) {
    console.warn('bridge.json could not be written:', (e as Error).message);
  }
}
