/**
 * Types for `nisaba/coordinator` (src/db-coordinator.js) -- multi-tab
 * sharing. SharedDb/SharedCollection mirror Db/Collection's public API
 * (enforced by reflection in test/db-coordinator.test.js), so they're
 * typed as the same shapes minus the in-process-only members.
 */
import type { Collection, ConnectOptions, CompactStats, Document, StorageProvider } from './nisaba.js';

export interface SharedDb {
  collection<T extends Document = Document>(name: string): Promise<Collection<T>>;
  listCollections(): Promise<string[]>;
  dropCollection(name: string): Promise<boolean>;
  compact(options?: { minBytes?: number; factor?: number; skipBusy?: boolean }): Promise<Record<string, CompactStats | null>>;
  storageEstimate(): Promise<{ usage?: number; quota?: number } | null>;
  close(): Promise<void>;
}

/**
 * Join (or create) a database shared across every tab/worker calling with
 * the same name against the same OPFS directory: one caller becomes the
 * leader and owns the files; the rest proxy to it over BroadcastChannel.
 * Requires navigator.locks + BroadcastChannel (run inside a Worker).
 * `options` (including autoCompact) reaches every newly elected leader's
 * connect().
 */
export function connectShared(dbName: string, provider: StorageProvider, options?: ConnectOptions): Promise<SharedDb>;
