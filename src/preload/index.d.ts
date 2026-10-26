import type { DbCatzBridge } from './index';

declare global {
  interface Window {
    dbcatz: DbCatzBridge;
  }
}

export {};
