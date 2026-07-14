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
import { ready, MemoryStorageProvider } from '../wasm/nisaba-wasm.js';
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
