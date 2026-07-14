/**
 * Multi-tab OPFS coordination tests (docs/db-plan.md, "OPFS concurrency").
 *
 * Runs in a real browser (vitest --browser, Chromium via Playwright — see
 * package.json's test:browser script and vitest.config.js). Each dedicated
 * Worker spawned here (test/db-coordinator-harness.js) stands in for one
 * tab: Workers of the same origin share OPFS/Web Locks/BroadcastChannel
 * exactly like separate tabs do, so this exercises the real coordination
 * primitives without needing actual multi-tab browser orchestration.
 */
import { describe, it, expect, afterEach } from 'vitest';
// Pure JS, not the WASM build: this runs on the main test thread, which
// never calls ready() -- only test/db-coordinator-harness.js's Worker does
// -- same reasoning as public/db.html's own import of these two.
import { encode, decode } from '../third_party/binjson/js/binjson.js';

let counter = 0;
const dirs = [];

function makeTab() {
  const worker = new Worker(new URL('./db-coordinator-harness.js', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map();
  const changes = [];
  const changeWaiters = []; // pending nextChange() resolvers, FIFO
  worker.addEventListener('message', (event) => {
    const { id, ok, result, error, change } = event.data;
    if (change !== undefined) {
      const decoded = decode(change);
      if (changeWaiters.length) changeWaiters.shift()(decoded);
      else changes.push(decoded);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(decode(result));
    else p.reject(new Error(error));
  });
  function call(cmd, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Raw structured-clone would silently mangle ObjectId (ordinary class
      // instances lose their prototype across postMessage) -- binjson-encode
      // args the same way the harness already encodes results back.
      worker.postMessage({ id, cmd, argsPayload: encode(args === undefined ? null : args) });
    });
  }
  /** Resolves with the next change event this tab's watch() receives
   * (already-arrived ones queue up, same as ChangeStream.next()). */
  function nextChange() {
    if (changes.length) return Promise.resolve(changes.shift());
    return new Promise((resolve) => changeWaiters.push(resolve));
  }
  return {
    call,
    nextChange,
    terminate: () => worker.terminate()
  };
}

const tabs = [];
function tab() {
  const t = makeTab();
  tabs.push(t);
  return t;
}

afterEach(async () => {
  for (const t of tabs.splice(0)) {
    try { await t.call('close'); } catch { /* already gone */ }
    t.terminate();
  }
  const root = await navigator.storage.getDirectory();
  for (const d of dirs.splice(0)) {
    await root.removeEntry(d, { recursive: true }).catch(() => {});
  }
});

function dirName() {
  const d = `test-coord-${Date.now()}-${counter++}`;
  dirs.push(d);
  return d;
}

describe('db-coordinator: multi-tab OPFS sharing', () => {
  it('exactly one of several simultaneously-started tabs becomes leader', async () => {
    const dir = dirName();
    const t1 = tab(), t2 = tab(), t3 = tab();
    const [r1, r2, r3] = await Promise.all([
      t1.call('connect', { dbName: 'shared', dirName: dir }),
      t2.call('connect', { dbName: 'shared', dirName: dir }),
      t3.call('connect', { dbName: 'shared', dirName: dir })
    ]);
    const roles = [r1.role, r2.role, r3.role];
    expect(roles.filter(r => r === 'leader')).toHaveLength(1);
    expect(roles.filter(r => r === 'follower')).toHaveLength(2);
  });

  it('a write via a follower is visible through find() on the leader and another follower', async () => {
    const dir = dirName();
    const t1 = tab(), t2 = tab(), t3 = tab();
    const roles = await Promise.all([
      t1.call('connect', { dbName: 'shared', dirName: dir }),
      t2.call('connect', { dbName: 'shared', dirName: dir }),
      t3.call('connect', { dbName: 'shared', dirName: dir })
    ]);
    const leader = [t1, t2, t3][roles.findIndex(r => r.role === 'leader')];
    const followers = [t1, t2, t3].filter(t => t !== leader);

    await followers[0].call('collection', { collection: 'users', method: 'insertOne', args: [{ name: 'Ada', team: 'core' }] });

    for (const t of [leader, ...followers]) {
      const all = await t.call('collection', { collection: 'users', method: 'find', args: [{}, {}] });
      expect(all.map(d => d.name)).toEqual(['Ada']);
    }
  });

  it('ObjectId and Date fields survive the RPC round trip unchanged', async () => {
    const dir = dirName();
    const t1 = tab(), t2 = tab();
    const roles = await Promise.all([
      t1.call('connect', { dbName: 'shared', dirName: dir }),
      t2.call('connect', { dbName: 'shared', dirName: dir })
    ]);
    const leader = [t1, t2][roles.findIndex(r => r.role === 'leader')];
    const follower = [t1, t2].find(t => t !== leader);

    const when = new Date('2026-01-15T00:00:00.000Z');
    const { insertedId } = await follower.call('collection', { collection: 'events', method: 'insertOne', args: [{ when }] });
    expect(insertedId).toBeTruthy();

    const found = await leader.call('collection', { collection: 'events', method: 'findOne', args: [{ _id: insertedId }] });
    expect(found.when).toEqual(when);
    expect(found._id).toEqual(insertedId);
  });

  it('terminating the leader hands off to a follower, which keeps working and sees prior data', async () => {
    const dir = dirName();
    const t1 = tab(), t2 = tab(), t3 = tab();
    const roles = await Promise.all([
      t1.call('connect', { dbName: 'shared', dirName: dir }),
      t2.call('connect', { dbName: 'shared', dirName: dir }),
      t3.call('connect', { dbName: 'shared', dirName: dir })
    ]);
    const all = [t1, t2, t3];
    const leaderIdx = roles.findIndex(r => r.role === 'leader');
    const leader = all[leaderIdx];
    const survivors = all.filter((_, i) => i !== leaderIdx);

    await leader.call('collection', { collection: 'users', method: 'insertOne', args: [{ name: 'Grace' }] });

    leader.terminate();
    tabs.splice(tabs.indexOf(leader), 1); // don't try to close() it in afterEach

    // One of the survivors should pick up leadership and keep serving reads
    // and writes, seeing data written before the handover.
    let lastErr;
    let ok = false;
    for (let attempt = 0; attempt < 20 && !ok; attempt++) {
      try {
        await survivors[0].call('collection', { collection: 'users', method: 'insertOne', args: [{ name: 'Katherine' }] });
        ok = true;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    expect(ok, `survivor never recovered leadership: ${lastErr}`).toBe(true);

    const names = (await survivors[1].call('collection', { collection: 'users', method: 'find', args: [{}, {}] }))
      .map((d) => d.name).sort();
    expect(names).toEqual(['Grace', 'Katherine']);
  });

  it('watch() delivers a change made in one tab to another tab watching the same collection', async () => {
    const dir = dirName();
    const t1 = tab(), t2 = tab();
    await Promise.all([
      t1.call('connect', { dbName: 'shared', dirName: dir }),
      t2.call('connect', { dbName: 'shared', dirName: dir })
    ]);

    // Start watching before the write so there's no race against the
    // change's own (async, BroadcastChannel-carried) rebroadcast.
    await t2.call('watch', { collection: 'users' });
    const { insertedId } = await t1.call('collection', { collection: 'users', method: 'insertOne', args: [{ name: 'Ada' }] });

    const change = await t2.nextChange();
    expect(change.operationType).toBe('insert');
    expect(change.documentKey._id).toEqual(insertedId);
    expect(change.fullDocument.name).toBe('Ada');
  });

  it('two independent dbNames on the same OPFS root do not cross-talk', async () => {
    const dirA = dirName();
    const dirB = dirName();
    const a1 = tab(), a2 = tab(), b1 = tab();
    await Promise.all([
      a1.call('connect', { dbName: 'appA', dirName: dirA }),
      a2.call('connect', { dbName: 'appA', dirName: dirA }),
      b1.call('connect', { dbName: 'appB', dirName: dirB })
    ]);

    await a1.call('collection', { collection: 'items', method: 'insertOne', args: [{ tag: 'a' }] });
    await b1.call('collection', { collection: 'items', method: 'insertOne', args: [{ tag: 'b' }] });

    const aItems = await a2.call('collection', { collection: 'items', method: 'find', args: [{}, {}] });
    const bItems = await b1.call('collection', { collection: 'items', method: 'find', args: [{}, {}] });
    expect(aItems.map((d) => d.tag)).toEqual(['a']);
    expect(bItems.map((d) => d.tag)).toEqual(['b']);
  });
});
