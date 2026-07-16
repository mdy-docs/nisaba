#!/usr/bin/env node
/**
 * Benchmark suite (docs/roadmap.md P2): tracks the WASM-boundary cost of
 * the hot paths so a change that regresses marshaling or the C engine
 * shows up as a number, not a hunch. Informational -- no CI gate; run it
 * before/after a change you suspect:
 *
 *   npm run bench                 # in-memory, N=1000
 *   node bench/bench.js --n 100000
 *   node bench/bench.js --provider node   # real files via NodeFSStorageProvider
 *
 * Results print as ops/sec over wall time for N operations after a small
 * untimed warmup. Absolute numbers vary by machine; the point is
 * comparing runs on the same machine across code versions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, MemoryStorageProvider, ObjectId } from '../src/db.js';
import { NodeFSStorageProvider } from '../src/db-node.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const N = parseInt(opt('n', '1000'), 10);
const PROVIDER = opt('provider', 'memory');

let tmpDir = null;
function makeProvider() {
  if (PROVIDER === 'memory') return new MemoryStorageProvider();
  if (PROVIDER === 'node') {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nisaba-bench-'));
    return new NodeFSStorageProvider(tmpDir);
  }
  throw new Error(`unknown --provider ${PROVIDER} (memory | node)`);
}

const results = [];
async function bench(name, ops, fn) {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  results.push({ name, ops, ms });
  const opsSec = ops / (ms / 1000);
  console.log(`${name.padEnd(38)} ${String(ops).padStart(8)} ops  ${ms.toFixed(1).padStart(9)} ms  ${Math.round(opsSec).toLocaleString().padStart(12)} ops/s`);
}

const doc = (i) => ({
  i,
  team: `t${i % 7}`,
  name: `person-${i}`,
  bio: `person number${i} enjoys writing benchmarks`,
  when: new Date(1700000000000 + i * 1000),
  pad: 'x'.repeat(64)
});

async function main() {
  console.log(`nisaba bench  provider=${PROVIDER}  N=${N}  node ${process.version}`);
  const provider = makeProvider();
  const db = await connect(provider);
  const coll = await db.collection('bench');
  await coll.createIndex({ team: 1 }, { name: 'teamIdx' });

  // Untimed warmup: first calls pay WASM warmup + file creation.
  await coll.insertMany(Array.from({ length: 50 }, (_, i) => doc(i + 10_000_000)));
  await coll.deleteMany({ i: { $gte: 10_000_000 } });

  const ids = [];
  await bench('insertOne', N, async () => {
    for (let i = 0; i < N; i++) ids.push((await coll.insertOne(doc(i))).insertedId);
  });

  await bench('insertMany (batches of 1000)', N, async () => {
    for (let at = 0; at < N; at += 1000) {
      await coll.insertMany(Array.from({ length: Math.min(1000, N - at) }, (_, j) => doc(1_000_000 + at + j)));
    }
  });

  await bench('findOne by _id (point lookup)', N, async () => {
    for (let i = 0; i < N; i++) await coll.findOne({ _id: ids[i % ids.length] });
  });

  await bench('find equality via index (toArray)', 200, async () => {
    for (let i = 0; i < 200; i++) await coll.find({ team: `t${i % 7}` }).toArray();
  });

  await bench('find full scan w/ filter (streaming)', 20, async () => {
    for (let i = 0; i < 20; i++) await coll.find({ i: { $gt: N - 10 } }).toArray();
  });

  await bench('countDocuments({})', 200, async () => {
    for (let i = 0; i < 200; i++) await coll.countDocuments({});
  });

  await bench('updateOne by _id ($set)', N, async () => {
    for (let i = 0; i < N; i++) {
      await coll.updateOne({ _id: ids[i % ids.length] }, { $set: { pad: `y${i}` } });
    }
  });

  await bench('aggregate $match+$group', 50, async () => {
    for (let i = 0; i < 50; i++) {
      await coll.aggregate([
        { $match: { team: 't1' } },
        { $group: { _id: '$team', n: { $sum: 1 }, avg: { $avg: '$i' } } }
      ]).toArray();
    }
  });

  await bench('compact (whole file set rewrite)', 1, async () => {
    await coll.compact();
  });

  await db.close();

  const t0 = performance.now();
  const provider2 = PROVIDER === 'memory' ? provider : new NodeFSStorageProvider(tmpDir);
  const reopened = await connect(provider2);
  await (await reopened.collection('bench')).countDocuments({});
  results.push({ name: 'reopen (recovery + first read)', ops: 1, ms: performance.now() - t0 });
  console.log(`${'reopen (recovery + first read)'.padEnd(38)} ${String(1).padStart(8)} ops  ${(performance.now() - t0).toFixed(1).padStart(9)} ms`);
  await reopened.close();
  if (provider2.close) await provider2.close();
  if (provider !== provider2 && provider.close) await provider.close();

  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => { console.error(err); process.exit(1); });
