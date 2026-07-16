/**
 * NodeFSStorageProvider (docs/roadmap.md P0 #4): the whole engine against
 * real files through plain node:fs -- no OPFS shim. Covers the two things
 * the provider adds over MemoryStorageProvider: durability across
 * close/reopen of real files (fsync-backed flush), and the advisory
 * per-directory lock (live holder refused, dead holder reclaimed).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ready, ObjectId } from '../wasm/nisaba-wasm.js';
import { connect, connectClient, NodeFSStorageProvider } from '../src/db-node.js';

await ready();

const roots = [];
function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nisaba-test-'));
  roots.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const point = (lng, lat) => ({ type: 'Point', coordinates: [lng, lat] });

describe('db: NodeFSStorageProvider', () => {
  it('full CRUD + every index kind against real files, durable across reopen', async () => {
    const root = tmpRoot();
    const provider = new NodeFSStorageProvider(root);
    const db = await connect(provider);
    const users = await db.collection('users');
    await users.createIndex({ team: 1 }, { name: 'teamIdx' });
    await users.createIndex({ bio: 'text' }, { name: 'bioIdx' });
    await users.createIndex({ loc: '2dsphere' }, { name: 'locIdx' });
    for (let i = 0; i < 40; i++) {
      await users.insertOne({ i, team: `t${i % 4}`, bio: `person number${i}`, loc: point(i * 0.01, 0) });
    }
    await users.updateMany({ team: 't0' }, { $set: { team: 'zero' } });
    await users.deleteMany({ team: 't1' });
    expect(await users.countDocuments({})).toBe(30);
    await db.close();
    await provider.close();

    // Real bytes on disk, reopened by a fresh provider.
    expect(fs.readdirSync(root).some((f) => f.startsWith('coll-users'))).toBe(true);
    const provider2 = new NodeFSStorageProvider(root);
    const db2 = await connect(provider2);
    const users2 = await db2.collection('users');
    expect(await users2.countDocuments({})).toBe(30);
    expect(await users2.find({ team: 'zero' }).toArray()).toHaveLength(10);
    expect((await users2.find({ $text: { $search: 'number3' } }).toArray()).length).toBeGreaterThan(0);
    const near = await users2.find({ loc: { $near: { $geometry: point(0.05, 0), $maxDistance: 3000 } } }).toArray();
    expect(near.length).toBeGreaterThan(0);
    await db2.close();
    await provider2.close();
  });

  it('compaction swaps generations of real files and survives reopen', async () => {
    const root = tmpRoot();
    const provider = new NodeFSStorageProvider(root);
    const db = await connect(provider);
    const users = await db.collection('users');
    await users.createIndex({ team: 1 });
    for (let i = 0; i < 50; i++) await users.insertOne({ i, team: 'a', pad: 'x'.repeat(200) });
    await users.updateMany({}, { $set: { pad: 'y'.repeat(50) } });

    const stats = await users.compact();
    expect(stats.generation).toBe(1);
    expect(stats.bytesFreed).toBeGreaterThan(0);
    expect(fs.readdirSync(root).some((f) => f.startsWith('g1-coll-users'))).toBe(true);
    expect(fs.readdirSync(root).some((f) => f === 'coll-users.bj')).toBe(false); // old gen deleted
    await db.close();
    await provider.close();

    const provider2 = new NodeFSStorageProvider(root);
    const db2 = await connect(provider2);
    expect(await (await db2.collection('users')).countDocuments({})).toBe(50);
    await db2.close();
    await provider2.close();
  });

  it('refuses a directory locked by a live process, with a clear message', async () => {
    const root = tmpRoot();
    const provider = new NodeFSStorageProvider(root);
    const db = await connect(provider);

    const second = new NodeFSStorageProvider(root);
    await expect(connect(second)).rejects.toThrow(/locked by pid \d+/);

    await db.close();
    await provider.close(); // releases the lock...
    const third = new NodeFSStorageProvider(root);
    const db3 = await connect(third); // ...so a later open succeeds
    await db3.close();
    await third.close();
  });

  it('reclaims a stale lock left by a dead process', async () => {
    const root = tmpRoot();
    // A pid that cannot be alive: past kernel defaults, and no live claim.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.nisaba-lock'), '999999999');

    const provider = new NodeFSStorageProvider(root);
    const db = await connect(provider);
    await (await db.collection('t')).insertOne({ ok: true });
    await db.close();
    await provider.close();
  });

  it('connectClient: each named database is an isolated, separately locked subdirectory', async () => {
    const root = tmpRoot();
    const provider = new NodeFSStorageProvider(root);
    const client = await connectClient(provider);
    const a = await client.db('alpha');
    const b = await client.db('beta');
    await (await a.collection('t')).insertOne({ from: 'alpha' });
    await (await b.collection('t')).insertOne({ from: 'beta' });

    expect(await (await a.collection('t')).countDocuments({})).toBe(1);
    expect((await (await b.collection('t')).findOne({})).from).toBe('beta');
    expect(fs.existsSync(path.join(root, 'alpha', '__catalog__.bj'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'beta', '.nisaba-lock'))).toBe(true);

    await client.close();
    await provider.close();
    // Children's locks were released with the parent.
    expect(fs.existsSync(path.join(root, 'alpha', '.nisaba-lock'))).toBe(false);
  });

  it('rejects path-traversal file and database names', async () => {
    const provider = new NodeFSStorageProvider(tmpRoot());
    await expect(provider.openFile('../escape.bj', { create: true })).rejects.toThrow(/Invalid file name/);
    await expect(provider.openFile('a/b.bj', { create: true })).rejects.toThrow(/Invalid file name/);
    await expect(provider.subProvider('..')).rejects.toThrow(/Invalid database name/);
    await provider.close();
  });

  it('ObjectIds round-trip byte-identically through real files', async () => {
    const provider = new NodeFSStorageProvider(tmpRoot());
    const db = await connect(provider);
    const coll = await db.collection('ids');
    const _id = new ObjectId();
    await coll.insertOne({ _id, tag: 'x' });
    await db.close();
    await provider.close();

    const provider2 = new NodeFSStorageProvider(provider._dir);
    const db2 = await connect(provider2);
    const found = await (await db2.collection('ids')).findOne({ _id });
    expect(found._id.toHexString()).toBe(_id.toHexString());
    await db2.close();
    await provider2.close();
  });
});
