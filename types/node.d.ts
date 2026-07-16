/**
 * Types for `nisaba/node` (src/db-node.js) -- everything the main entry
 * exports plus the node:fs storage provider.
 */
import type { StorageProvider, SyncAccessHandle } from './nisaba.js';

export * from './nisaba.js';

/** Real-file persistence over plain node:fs: fsync-backed flush() and an
 * advisory per-directory PID lock (one opener per database directory; a
 * dead holder's lock is reclaimed automatically). */
export class NodeFSStorageProvider implements StorageProvider {
  constructor(rootDir: string);
  openFile(name: string, options?: { create?: boolean }): Promise<SyncAccessHandle>;
  deleteFile(name: string): Promise<void>;
  listFiles(): Promise<string[]>;
  subProvider(name: string): Promise<NodeFSStorageProvider>;
  /** Release the directory lock (and children's) once the Db/Client is closed. */
  close(): Promise<void>;
}
