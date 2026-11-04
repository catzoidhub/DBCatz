import type { ActionDef } from '@catzoid/mcatzp-host';
import type { DbCatzApi } from '@shared/types';
import { readActions } from './actions';
import { changeActions } from './changes';

/** Every tool with everything shared, for the reference and the coverage test. Nothing here runs: the API is never called. */
export function allActions(): ActionDef[] {
  const never = () => {
    throw new Error('The registry is only listed here');
  };
  const api = new Proxy({}, { get: () => never }) as DbCatzApi;
  const scopes = { connection: () => true, rows: true, changes: true };
  const reads = { queryLog: never, queryHistory: never };
  return [...readActions(api, { readQuery: never }, scopes, reads, never), ...changeActions(api, scopes, never, never)];
}
