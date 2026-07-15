/**
 * Compaction against real OPFS (docs/compaction.md).
 *
 * The Node suite (test/db.compact.test.js) already covers the algorithm
 * exhaustively over node-opfs, including byte-level crash-window
 * simulations. What only a real browser exercises -- and what this file
 * adds -- is compaction against genuine OPFS semantics: sync access
 * handles taking exclusive per-file locks during the streaming rewrite and
 * the swap, real directory enumeration in Db.open()'s orphan sweep, and
 * real file creation/deletion. The whole Db runs inside a Worker (OPFS
 * sync handles are Worker-only, via test/db-compact-harness.js); this main
 * thread only ever touches the OPFS *directory* (listing names, planting
 * an orphan), which needs no file locks and so is safe alongside the
 * worker's open handles.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { encode, decode } from '../third_party/binjson/js/binjson.js';

let counter = 0;
const dirs = [];
const tabs = [];

function makeTab() {
  const worker = new Worker(new URL('./db-compact-harness.js', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map();
  worker.addEventListener('message', (event) => {
    const { id, ok, result, error } = event.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(decode(result));
    else p.reject(new Error(error));
  });
  const call = (cmd, args) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, argsPayload: encode(args === undefined ? null : args) });
    });
  };
  const t = { call, terminate: () => worker.terminate() };
  tabs.push(t);
  return t;
}

/** OPFS file names directly under `dirName` (no locks needed -- names
 * only), read from the main thread while a worker may hold files open. */
async function opfsNames(dirName) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirName);
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  return names;
}

/** Plant a raw file directly in the OPFS directory from the main thread
 * (createWritable is available off the worker; createSyncAccessHandle is
 * not). */
async function writeOpfsFile(dirName, name, bytes) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirName);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

function dirName() {
  const d = `test-compact-${Date.now()}-${counter++}`;
  dirs.push(d);
  return d;
}

const call = (t, collection, method, args) => t.call('collection', { collection, method, args });

/** Seed a collection with the three index kinds, then churn it so the
 * append-only files carry real garbage to reclaim. Returns the surviving
 * document count. */
async function seedAndChurn(t) {
  await call(t, 'users', 'createIndex', [{ team: 1 }, { name: 'teamIdx' }]);
  await call(t, 'users', 'createIndex', [{ bio: 'text' }, { name: 'bioIdx' }]);
  await call(t, 'users', 'createIndex', [{ loc: '2dsphere' }, { name: 'locIdx' }]);
  const docs = Array.from({ length: 60 }, (_, i) => ({
    i,
    team: i % 3 === 0 ? 'core' : 'infra',
    bio: `person number${i} writes tests`,
    loc: { type: 'Point', coordinates: [i * 0.01, i * 0.01] }
  }));
  await call(t, 'users', 'insertMany', [docs]);
  await call(t, 'users', 'updateMany', [{ team: 'infra' }, { $set: { team: 'infra2' } }]);
  await call(t, 'users', 'deleteMany', [{ i: { $lt: 15 } }]);
  return docs.filter(d => d.i >= 15).length; // 45
}

afterEach(async () => {
  for (const t of tabs.splice(0)) {
    try { await t.call('close'); } catch { /* already closed/gone */ }
    t.terminate();
  }
  const root = await navigator.storage.getDirectory();
  for (const d of dirs.splice(0)) {
    await root.removeEntry(d, { recursive: true }).catch(() => {});
  }
});

describe('db: compaction against real OPFS', () => {
  it('rewrites the live file set into a new generation, deletes the old, and preserves all data', async () => {
    const dir = dirName();
    const t = makeTab();
    await t.call('connect', { dirName: dir });
    const survivors = await seedAndChurn(t);

    const before = await opfsNames(dir);
    expect(before).toContain('coll-users.bj');
    expect(before).toContain('idx-users-teamIdx.bj');
    expect(before).toContain('idx-users-bioIdx-terms.bj');
    expect(before).toContain('idx-users-locIdx.bj');

    const stats = await call(t, 'users', 'compact', []);
    expect(stats.generation).toBe(1);
    expect(stats.bytesFreed).toBeGreaterThan(0);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);

    // Real OPFS directory: new generation present, old generation deleted
    // (the delete happened during compact's cleanup, while files were open).
    const after = await opfsNames(dir);
    expect(after).toContain('g1-coll-users.bj');
    expect(after).toContain('g1-idx-users-teamIdx.bj');
    expect(after).toContain('g1-idx-users-bioIdx-terms.bj');
    expect(after).toContain('g1-idx-users-locIdx.bj');
    expect(after).not.toContain('coll-users.bj');
    expect(after).not.toContain('idx-users-teamIdx.bj');
    expect(after).not.toContain('coll-users-journal.bj');

    // Data + every index kind still correct on the compacted files.
    expect(await call(t, 'users', 'countDocuments', [{}])).toBe(survivors);
    expect((await call(t, 'users', 'findByIndex', ['teamIdx', ['core']])).length)
      .toBe(await call(t, 'users', 'countDocuments', [{ team: 'core' }]));
    const near = await call(t, 'users', 'find', [{ loc: { $near: { $geometry: { type: 'Point', coordinates: [0, 0] } } } }]);
    expect(near.length).toBe(survivors);
    const text = await call(t, 'users', 'find', [{ $text: { $search: 'number20' } }]);
    expect(text.map(d => d.i)).toEqual([20]);
  });

  it('survives close + reopen: the reopened Db reads the new generation', async () => {
    const dir = dirName();
    const t1 = makeTab();
    await t1.call('connect', { dirName: dir });
    const survivors = await seedAndChurn(t1);
    await call(t1, 'users', 'compact', []);
    await t1.call('close');
    t1.terminate();
    tabs.splice(tabs.indexOf(t1), 1);

    const t2 = makeTab();
    await t2.call('connect', { dirName: dir });
    expect(await call(t2, 'users', 'countDocuments', [{}])).toBe(survivors);
    // Still writable, and the write lands on the new-generation files.
    await call(t2, 'users', 'insertOne', [{ i: 999, team: 'core', bio: 'after reopen', loc: { type: 'Point', coordinates: [1, 1] } }]);
    expect((await call(t2, 'users', 'find', [{ $text: { $search: 'reopen' } }])).map(d => d.i)).toEqual([999]);
  });

  it("Db.open()'s sweep deletes a real orphaned file but keeps referenced and foreign ones", async () => {
    const dir = dirName();
    const t1 = makeTab();
    await t1.call('connect', { dirName: dir });
    const survivors = await seedAndChurn(t1);
    await call(t1, 'users', 'compact', []);
    await t1.call('close'); // release OPFS locks before touching the dir
    t1.terminate();
    tabs.splice(tabs.indexOf(t1), 1);

    // Simulate a crash leftover (a matching-but-unreferenced file, e.g. a
    // half-built generation) plus a foreign file the sweep must never touch.
    await writeOpfsFile(dir, 'g9-coll-users.bj', new Uint8Array([1, 2, 3]));
    await writeOpfsFile(dir, 'keep-me.txt', new Uint8Array([9]));
    expect(await opfsNames(dir)).toContain('g9-coll-users.bj');

    const t2 = makeTab();
    await t2.call('connect', { dirName: dir }); // Db.open() runs the sweep
    // The Db must be intact, and the sweep must have run.
    expect(await call(t2, 'users', 'countDocuments', [{}])).toBe(survivors);
    await t2.call('close');

    const names = await opfsNames(dir);
    expect(names).not.toContain('g9-coll-users.bj'); // orphan: swept
    expect(names).toContain('keep-me.txt');          // foreign: kept
    expect(names).toContain('g1-coll-users.bj');     // live generation: kept
  });
});
