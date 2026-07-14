/**
 * db.js — public entry point for the document database (mirrors the
 * parent binjson project's own src/db.js, which re-exports the same set
 * from its own combined WASM module -- see wasm/nisaba-wasm.js's own top
 * comment for why the parent doesn't just re-export from here instead).
 */
export {
  Db,
  Collection,
  ChangeStream,
  MemoryStorageProvider,
  OPFSStorageProvider,
  connect,
  Client,
  connectClient
} from './wasm/nisaba-wasm.js';
