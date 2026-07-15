/**
 * Coordination-logic tests for db-coordinator.js (docs/db-plan.md, "OPFS
 * concurrency"). Runs in plain Node, part of the
 * default `npm test` suite -- no browser needed, because modern Node ships
 * spec-compliant `navigator.locks` and `BroadcastChannel` globals, and
 * connectShared() only actually requires those two plus a storage provider
 * (MemoryStorageProvider here, in place of OPFSStorageProvider). Several
 * connectShared() calls in this same process, sharing one provider by
 * reference, stand in for several tabs sharing one OPFS directory.
 *
 * This exercises the real election/RPC/handover code paths end to end
 * (not a mock of them). What it *can't* cover: an abrupt tab/worker crash
 * (there's no in-process analog to Worker.terminate()'s effect on held Web
 * Locks) -- only a graceful close(). The abrupt-termination handover case
 * is covered by test/db-coordinator.browser.test.js (real Workers, real
 * OPFS; run via `npm run test:browser`, which needs Playwright's Chromium
 * installed).
 */
import { describe, it, expect } from 'vitest';
import { ready, MemoryStorageProvider, ObjectId } from '../wasm/nisaba-wasm.js';
import { connect } from '../src/db.js';
import { connectShared } from '../src/db-coordinator.js';

await ready();

let counter = 0;
const nextDbName = () => `coord-${counter++}`;

describe('db-coordinator: election, RPC, and handover logic', () => {
  it('exactly one of several simultaneously-connecting tabs becomes leader', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const roles = dbs.map((d) => d._coord.role);
    expect(roles.filter((r) => r === 'leader')).toHaveLength(1);
    expect(roles.filter((r) => r === 'follower')).toHaveLength(2);
    await Promise.all(dbs.map((d) => d.close()));
  });

  it('a write via a follower is visible through find() on the leader and another follower', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const leader = dbs.find((d) => d._coord.role === 'leader');
    const followers = dbs.filter((d) => d !== leader);

    const followerUsers = await followers[0].collection('users');
    await followerUsers.insertOne({ name: 'Ada', team: 'core' });

    for (const d of dbs) {
      const coll = await d.collection('users');
      const all = await coll.find({}).toArray();
      expect(all.map((x) => x.name)).toEqual(['Ada']);
    }
    await Promise.all(dbs.map((d) => d.close()));
  });

  it('ObjectId and Date fields survive the RPC round trip unchanged', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const [a, b] = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const leader = a._coord.role === 'leader' ? a : b;
    const follower = leader === a ? b : a;

    const when = new Date('2026-01-15T00:00:00.000Z');
    const followerEvents = await follower.collection('events');
    const { insertedId } = await followerEvents.insertOne({ when });
    expect(insertedId).toBeTruthy();

    const leaderEvents = await leader.collection('events');
    const found = await leaderEvents.findOne({ _id: insertedId });
    expect(found.when).toEqual(when);
    expect(found._id.equals(insertedId)).toBe(true);

    await Promise.all([a, b].map((d) => d.close()));
  });

  it('closing the leader hands leadership to a follower, which keeps working and sees prior data', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const leader = dbs.find((d) => d._coord.role === 'leader');
    const survivors = dbs.filter((d) => d !== leader);

    const leaderUsers = await leader.collection('users');
    await leaderUsers.insertOne({ name: 'Grace' });

    await leader.close(); // graceful -- releases the Web Lock for the next queued follower

    const survivorUsers = await survivors[0].collection('users');
    // The hand-off (lock grant -> connect()) is asynchronous; give it a moment.
    let inserted = null;
    for (let attempt = 0; attempt < 20 && !inserted; attempt++) {
      try {
        inserted = await survivorUsers.insertOne({ name: 'Katherine' });
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    expect(inserted).toBeTruthy();

    const survivorUsers2 = await survivors[1].collection('users');
    const names = (await survivorUsers2.find({}).toArray()).map((d) => d.name).sort();
    expect(names).toEqual(['Grace', 'Katherine']);

    await Promise.all(survivors.map((d) => d.close()));
  });

  it('a follower\'s watch() sees a write made through the leader', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const leader = dbs.find((d) => d._coord.role === 'leader');
    const follower = dbs.find((d) => d !== leader);

    const followerUsers = await follower.collection('users');
    const stream = followerUsers.watch();

    const leaderUsers = await leader.collection('users');
    const { insertedId } = await leaderUsers.insertOne({ name: 'Ada' });

    const { value: change, done } = await stream.next();
    expect(done).toBe(false);
    expect(change.operationType).toBe('insert');
    expect(change.documentKey._id.equals(insertedId)).toBe(true);
    expect(change.fullDocument.name).toBe('Ada');

    stream.close();
    await Promise.all(dbs.map((d) => d.close()));
  });

  it('the leader\'s own watch() sees a write made through a follower (BroadcastChannel self-delivery fix)', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const leader = dbs.find((d) => d._coord.role === 'leader');
    const follower = dbs.find((d) => d !== leader);

    const leaderUsers = await leader.collection('users');
    const stream = leaderUsers.watch();

    const followerUsers = await follower.collection('users');
    await followerUsers.insertOne({ name: 'Grace' });

    const { value: change } = await stream.next();
    expect(change.operationType).toBe('insert');
    expect(change.fullDocument.name).toBe('Grace');

    stream.close();
    await Promise.all(dbs.map((d) => d.close()));
  });

  it('watch() delivers update and delete events across tabs, and stops after close()', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const leader = dbs.find((d) => d._coord.role === 'leader');
    const follower = dbs.find((d) => d !== leader);

    // watch() is registered before any writes happen, on purpose: the
    // 'change' rebroadcast is itself an async BroadcastChannel message, so
    // watching only *after* an earlier write's own promise resolves would
    // race that write's still-in-flight rebroadcast.
    const followerUsers = await follower.collection('users');
    const stream = followerUsers.watch();

    const leaderUsers = await leader.collection('users');
    const { insertedId } = await leaderUsers.insertOne({ name: 'Ada', team: 'core' });
    const insertChange = (await stream.next()).value;
    expect(insertChange.operationType).toBe('insert');

    await leaderUsers.updateOne({ _id: insertedId }, { $set: { team: 'kernel' } });
    const updateChange = (await stream.next()).value;
    expect(updateChange.operationType).toBe('update');
    expect(updateChange.fullDocument.team).toBe('kernel');

    await leaderUsers.deleteOne({ _id: insertedId });
    const deleteChange = (await stream.next()).value;
    expect(deleteChange.operationType).toBe('delete');
    expect(deleteChange.documentKey._id.equals(insertedId)).toBe(true);

    stream.close();
    await leaderUsers.insertOne({ name: 'Ignored' });
    // No await-able signal that "nothing more arrives", so just confirm the
    // stream itself reports closed rather than racing a timeout.
    const afterClose = await stream.next();
    expect(afterClose.done).toBe(true);

    await Promise.all(dbs.map((d) => d.close()));
  });

  it('SharedCollection exposes every public Collection method and the full cursor surface (API parity)', async () => {
    const shared = await connectShared(nextDbName(), new MemoryStorageProvider(), {});
    const sharedColl = await shared.collection('users');
    const realDb = await connect(new MemoryStorageProvider());
    const realColl = await realDb.collection('users');

    // Reflect over the real Collection rather than hardcoding a list, so a
    // method added there without a SharedCollection counterpart fails here.
    const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(realColl))
      .filter((n) => n !== 'constructor' && !n.startsWith('_') && typeof realColl[n] === 'function');
    expect(publicMethods.length).toBeGreaterThan(20); // guards the filter itself
    for (const m of publicMethods) {
      expect(typeof sharedColl[m], `SharedCollection.${m}`).toBe('function');
    }

    // Same for the find() cursor's surface (sort/skip/limit/project/
    // toArray/next/close/return + async iteration).
    const realCursor = realColl.find({});
    const sharedCursor = sharedColl.find({});
    for (const key of Object.keys(realCursor)) {
      if (typeof realCursor[key] !== 'function') continue;
      expect(typeof sharedCursor[key], `find() cursor .${key}`).toBe('function');
    }
    expect(typeof sharedCursor[Symbol.asyncIterator]).toBe('function');
    await realCursor.close();

    await realDb.close();
    await shared.close();
  });

  it('the full proxied API works end to end through a follower', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const follower = dbs.find((d) => d._coord.role === 'follower');
    const users = await follower.collection('users');

    // insertMany / estimatedDocumentCount / distinct
    const { insertedCount, insertedIds } = await users.insertMany([
      { i: 1, team: 'core' }, { i: 2, team: 'core' }, { i: 3, team: 'infra' }
    ]);
    expect(insertedCount).toBe(3);
    expect(insertedIds[0]).toBeTruthy();
    expect(await users.estimatedDocumentCount()).toBe(3);
    expect((await users.distinct('team')).sort()).toEqual(['core', 'infra']);

    // findOne now forwards options (projection)
    expect(await users.findOne({ i: 1 }, { projection: { i: 1, _id: 0 } })).toEqual({ i: 1 });

    // Cursor: manual next(), toArray() returning only what next() hasn't
    // handed out, and early for-await exit not hanging.
    const cursor = users.find({}).sort({ i: 1 });
    expect((await cursor.next()).value.i).toBe(1);
    expect((await cursor.toArray()).map((d) => d.i)).toEqual([2, 3]);
    expect((await cursor.next()).done).toBe(true);
    for await (const doc of users.find({})) { void doc; break; }

    // find-and-modify family
    const updated = await users.findOneAndUpdate({ i: 2 }, { $set: { team: 'kernel' } }, { returnDocument: 'after' });
    expect(updated.team).toBe('kernel');
    const replaced = await users.findOneAndReplace({ i: 3 }, { i: 3, team: 'ops' }, { returnDocument: 'after' });
    expect(replaced.team).toBe('ops');
    expect((await users.findOneAndDelete({ i: 1 })).i).toBe(1);

    // bulkWrite / deleteMany
    const bulk = await users.bulkWrite([
      { insertOne: { document: { i: 4, team: 'ops' } } },
      { updateMany: { filter: { team: 'ops' }, update: { $set: { floor: 2 } } } }
    ]);
    expect(bulk.insertedCount).toBe(1);
    expect(bulk.matchedCount).toBe(2);
    expect((await users.deleteMany({})).deletedCount).toBe(3);

    // pruneExpired via a TTL index created through the follower
    await users.createIndex({ seen: 1 }, { expireAfterSeconds: 60, name: 'ttl' });
    await users.insertOne({ seen: new Date(Date.now() - 3600 * 1000) });
    await users.insertOne({ seen: new Date() });
    expect(await users.pruneExpired()).toBe(1);

    await Promise.all(dbs.map((d) => d.close()));
  });

  it('insertMany/bulkWrite partial-failure details survive the RPC error channel', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const follower = dbs.find((d) => d._coord.role === 'follower');
    const users = await follower.collection('users');

    const dupe = new ObjectId();
    const caught = await users.insertMany([{ _id: dupe, i: 1 }, { _id: dupe, i: 2 }, { i: 3 }])
      .then(() => null, (e) => e);
    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/Duplicate _id/);
    expect(caught.result.insertedCount).toBe(1); // what landed before the failure
    expect(caught.result.insertedIds[0].equals(dupe)).toBe(true);

    const bulkErr = await users.bulkWrite([
      { insertOne: { document: { i: 10 } } },
      { insertOne: { document: { _id: dupe, i: 11 } } } // dupe landed above
    ]).then(() => null, (e) => e);
    expect(bulkErr).toBeTruthy();
    expect(bulkErr.result.insertedCount).toBe(1);
    expect(bulkErr.writeErrors).toHaveLength(1);
    expect(bulkErr.writeErrors[0].index).toBe(1);
    expect(bulkErr.writeErrors[0].error.message).toMatch(/Duplicate _id/);

    // An error *response* must not trigger the leader-gone retry: the
    // operation already partially ran on a live leader, and re-executing
    // it would double-apply the non-failing documents. Observable with an
    // unordered insertMany -- a hidden retry would insert {i: 99} twice.
    const unorderedErr = await users.insertMany(
      [{ _id: dupe, i: -1 }, { i: 99 }], { ordered: false }
    ).then(() => null, (e) => e);
    expect(unorderedErr).toBeTruthy();
    expect(unorderedErr.message).toMatch(/Duplicate _id/);
    expect(await users.find({ i: 99 }).toArray()).toHaveLength(1);

    await Promise.all(dbs.map((d) => d.close()));
  });

  it('a follower-initiated compact() runs on the leader and every tab keeps working', async () => {
    const provider = new MemoryStorageProvider();
    const dbName = nextDbName();
    const dbs = await Promise.all([
      connectShared(dbName, provider, {}),
      connectShared(dbName, provider, {})
    ]);
    const leader = dbs.find((d) => d._coord.role === 'leader');
    const follower = dbs.find((d) => d !== leader);

    // Churn through the leader so there is real history to reclaim.
    const leaderUsers = await leader.collection('users');
    await leaderUsers.insertMany(Array.from({ length: 40 }, (_, i) => ({ i, pad: 'x'.repeat(100) })));
    await leaderUsers.deleteMany({ i: { $lt: 20 } });

    const followerUsers = await follower.collection('users');
    const stats = await followerUsers.compact(); // proxied to the leader's real Collection
    expect(stats.generation).toBe(1);
    expect(stats.bytesFreed).toBeGreaterThan(0);

    // Both tabs still read and write the (swapped) collection.
    await followerUsers.insertOne({ i: 999 });
    expect(await leaderUsers.countDocuments({})).toBe(21);
    expect((await followerUsers.find({ i: 999 }).toArray())).toHaveLength(1);

    // Db-level compact via a follower, with thresholds: freshly compacted,
    // so the growth factor skips it.
    const skipped = await follower.compact({ minBytes: 1, factor: 4 });
    expect(skipped.users).toBeNull();

    await Promise.all(dbs.map((d) => d.close()));
  });

  it('two independent shared databases do not cross-talk', async () => {
    const providerA = new MemoryStorageProvider();
    const providerB = new MemoryStorageProvider();
    const dbName = nextDbName();
    const a1 = await connectShared(`${dbName}-A`, providerA, {});
    const a2 = await connectShared(`${dbName}-A`, providerA, {});
    const b1 = await connectShared(`${dbName}-B`, providerB, {});

    const a1Items = await a1.collection('items');
    await a1Items.insertOne({ tag: 'a' });
    const b1Items = await b1.collection('items');
    await b1Items.insertOne({ tag: 'b' });

    const a2Items = await a2.collection('items');
    expect((await a2Items.find({}).toArray()).map((d) => d.tag)).toEqual(['a']);
    expect((await b1Items.find({}).toArray()).map((d) => d.tag)).toEqual(['b']);

    await Promise.all([a1, a2, b1].map((d) => d.close()));
  });
});
