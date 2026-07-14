/**
 * Client/connectClient tests: db(name) routes to a genuinely isolated
 * storage scope per name (a real OPFS subdirectory, or an independent
 * in-memory file map), mirroring the cloud service's per-tenant db(name)
 * routing (service/tenant-worker.js's createProvider(tenantId, dbName))
 * minus the tenant axis -- see docs/db-api.md's "Client (multiple named
 * databases)".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ready } from '../wasm/nisaba-wasm.js';
import { connectClient, MemoryStorageProvider, OPFSStorageProvider } from '../src/db.js';
import { bootstrapOPFS } from './binjson.suite.js';

await ready();
const { hasOPFS } = await bootstrapOPFS();

describe('Client (in-memory provider)', () => {
  it('db(name) opens independent, isolated databases', async () => {
    const client = await connectClient(new MemoryStorageProvider());
    const a = await client.db('a');
    const b = await client.db('b');

    await (await a.collection('users')).insertOne({ name: 'Ada' });
    await (await b.collection('users')).insertOne({ name: 'Grace' });

    expect((await (await a.collection('users')).find({}).toArray()).map((d) => d.name)).toEqual(['Ada']);
    expect((await (await b.collection('users')).find({}).toArray()).map((d) => d.name)).toEqual(['Grace']);
    await client.close();
  });

  it('db(name) called twice returns the same cached Db instance', async () => {
    const client = await connectClient(new MemoryStorageProvider());
    const a1 = await client.db('a');
    const a2 = await client.db('a');
    expect(a1).toBe(a2);
    await client.close();
  });

  it('close() closes every database the client opened', async () => {
    const client = await connectClient(new MemoryStorageProvider());
    const a = await client.db('a');
    const b = await client.db('b');
    await client.close();
    expect(a.isOpen).toBe(false);
    expect(b.isOpen).toBe(false);
  });

  it('rejects invalid database names, same constraints as a collection name', async () => {
    const client = await connectClient(new MemoryStorageProvider());
    await expect(client.db('a/b')).rejects.toThrow(/Invalid database name/);
    await expect(client.db('')).rejects.toThrow(/Invalid database name/);
    await client.close();
  });
});

describe.skipIf(!hasOPFS)('Client (OPFS provider)', () => {
  let root = null;
  const dirs = [];
  const base = () => `test-dbclient-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    root = await navigator.storage.getDirectory();
  });

  afterAll(async () => {
    for (const d of dirs) await root.removeEntry(d, { recursive: true }).catch(() => {});
  });

  it('db(name) creates a real, separate OPFS subdirectory per name', async () => {
    const rootName = base();
    dirs.push(rootName);
    const dir = await root.getDirectoryHandle(rootName, { create: true });

    const client = await connectClient(new OPFSStorageProvider(dir));
    const app = await client.db('app');
    const analytics = await client.db('analytics');

    await (await app.collection('users')).insertOne({ name: 'Ada' });
    expect(await (await analytics.collection('users')).find({}).toArray()).toEqual([]);

    // Real, independent subdirectories on disk -- not a namespace prefix inside one shared catalog.
    const appDir = await dir.getDirectoryHandle('app');
    const analyticsDir = await dir.getDirectoryHandle('analytics');
    expect(appDir.name).toBe('app');
    expect(analyticsDir.name).toBe('analytics');

    await client.close();
  });

  it('reopening a Client against the same root sees the same on-disk databases', async () => {
    const rootName = base();
    dirs.push(rootName);
    const dir1 = await root.getDirectoryHandle(rootName, { create: true });
    const client1 = await connectClient(new OPFSStorageProvider(dir1));
    const db1 = await client1.db('app');
    const users1 = await db1.collection('users');
    await users1.insertOne({ name: 'Ada' });
    await client1.close();

    const dir2 = await root.getDirectoryHandle(rootName, { create: true });
    const client2 = await connectClient(new OPFSStorageProvider(dir2));
    const users = await (await client2.db('app')).collection('users');
    expect((await users.find({}).toArray()).map((d) => d.name)).toEqual(['Ada']);
    await client2.close();
  });
});
