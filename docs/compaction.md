# Collection compaction

How `Collection.compact()` / `Db.compact()` reclaim the space append-only
storage costs, and why the atomic unit of compaction is a collection's
*entire file set* swapped through *one catalog commit*.

Implementation: `wasm/nisaba-wasm.js` (`Collection.compact`, `Db.compact`,
`Db._sweepOrphans`, the `g<N>-` naming helpers), on top of the per-structure
streaming rewriters that already existed (`bpt_compact` in
`binjson-structures/src/bplustree.c`, `rt_compact` in `rtree.c`). Tests:
`test/db.compact.test.js` (including byte-level crash-window simulations),
plus a coordinator round trip in `test/db-coordinator.test.js`.

## The problem

Every backing file here is append-only: a mutation appends new tree nodes
plus fresh metadata, and nothing written earlier is ever modified or
reused. That is the foundation of the whole durability story — commits
are atomic because a torn tail can simply be truncated away
(`docs/textindex-atomicity.md`) — but it means files grow with *write
traffic*, not with *live data*. A collection whose documents are updated
in place forever still grows without bound. Deleting keys makes it worse:
each delete appends a rewritten node path.

The per-structure cure already existed: `bpt_compact` (and the R-tree's
`rt_compact`) stream every live entry into a destination file as a
minimal, fully-packed tree — O(height) memory, one pass, source file
untouched. What was missing was everything around it: which files to
rewrite together, how to adopt the new files without a crash window, and
who cleans up what a crash leaves behind.

## Why the unit is the whole collection

A collection is not one file. It is:

| file | role |
|---|---|
| `coll-<name>.bj` | primary B+ tree (`_id` → document) |
| `idx-<coll>-<ix>.bj` | one per equality index (B+ tree) or geo index (R-tree) |
| `idx-<coll>-<ix>-{terms,documents,lengths}.bj` | three per text index |
| `coll-<name>-journal.bj` | cross-file commit journal |

The journal records the byte length of *every* file in the set per
committed write; recovery rewinds all files to the newest satisfiable
record. Those lengths are only meaningful for the exact files they were
measured against — compact even one file of the set and every recorded
length for it becomes garbage. So compaction rewrites the whole set in
one operation and pairs the result with a **fresh, empty journal of its
own** (an empty journal means "no constraint; adopt the trees as-is",
which is exactly right for freshly written, internally consistent files).

## The swap: one catalog commit

The catalog (`__catalog__.bj`, itself a B+ tree) already stores every
file name a collection uses, and `Collection._open()` opens files strictly
by those recorded names — the `coll-`/`idx-` naming convention is only a
default for newly created things, never re-derived on open. That makes the
adoption problem disappear:

> Writing the collection's catalog entry with new file names is an atomic
> multi-file swap. A B+ tree commit is already crash-atomic (CRC trailer;
> torn tails truncate away), so after any crash the entry names either the
> complete old set or the complete new set — never a mixture.

This is the same move the text-index journal makes (a small, atomically
written record that says which bytes count), one level up. The
alternatives lose: OPFS has no reliable cross-browser rename, and a
rename-based scheme couldn't swap five files atomically anyway.

New files are named with a generation prefix — `g1-coll-users.bj`,
`g2-idx-users-team_1.bj`, … — with the counter stored in the catalog
entry (`gen`). A *prefix* rather than a `.g1` suffix so a generation can
never collide with a gen-0 name: collection names may legally contain
dots, so a collection literally named `users.g2` must not claim what a
suffix scheme would call generation 2 of `users`. Gen 0 keeps the
historical un-prefixed names; a pre-compaction database opens completely
unchanged, and its first compact is the ordinary path, not a migration.

The journal file name also moves into the catalog entry (`journal`) at
first compact, giving each generation its own journal by construction.
Readers fall back to the derived gen-0 name for entries that predate the
field. This ordering matters: if instead one journal file were *reset*
after the flip, a crash between flip and reset would pair fresh short
files with a stale journal whose recorded lengths nothing can satisfy —
recovery would (correctly, but uselessly) refuse to open. With the
journal name inside the flipped entry, the new generation atomically
arrives with its empty journal.

## The algorithm

`Collection.compact()` runs four phases:

1. **Build.** Stream the primary tree and every index into
   `g<N+1>`-prefixed files via the per-structure compactors, and create
   the new empty journal. The live trees are only *read* (the compactors
   never touch their source), so the collection is fully intact if
   anything in here fails — half-built files are deleted on the way out,
   or swept later if even that fails.
2. **Flip.** One `catalog.add(name, newEntry)` — new file names, new
   journal name, `gen`, and `compactedBytes` (the growth-heuristic
   baseline, below) — followed by a catalog `flush()`. The flush must
   precede the deletes in phase 4: if the OS lost an unflushed flip
   *after* the old files were deleted, the recovered catalog would point
   at nothing.
3. **Adopt.** Close every handle and WASM context and re-run the normal
   `_open()` path, which reads the flipped entry: new files opened,
   indexes re-attached, fresh journal recovered (a no-op). `watch()`
   streams are deliberately left alone and keep emitting afterwards.
4. **Cleanup.** Delete the old generation's files. Best-effort: anything
   left behind is unreferenced by the catalog and swept at the next open.

Every new file is flushed by its compactor before the flip, so the flip
never publishes names whose bytes might still be lost.

### Crash windows

| crash during | reopened state |
|---|---|
| build | old generation (catalog never changed); partial `g<N+1>-*` files are unreferenced → swept |
| flip (torn catalog tail) | truncated back to the old entry → old generation, new files swept |
| between flip and cleanup | new generation; old files are unreferenced → swept |

`test/db.compact.test.js` simulates each window byte-for-byte by
snapshotting all files before and after a real compact and reopening
synthesized combinations, exactly the technique of
`test/textindex.atomic-wasm.test.js`.

### The orphan sweep

`Db.open()` lists the provider's files and deletes any that match the
database's own naming pattern (`/^(?:g\d+-)?(?:coll|idx)-.*\.bj$/`) but are
referenced by no catalog entry. The catalog is the sole source of truth
for which generation is live, so an unreferenced matching file is garbage
by definition — a crashed compact's leftovers on either side of the flip,
or a crashed `dropCollection`'s. Files outside the pattern (anything a
host stored alongside) are never touched. The sweep requires
`listFiles()` on the storage provider (`MemoryStorageProvider` and
`OPFSStorageProvider` both provide it) and is silently skipped for
providers that don't — orphans cost space, never correctness.

## Concurrency

Compaction is stop-the-world for the one collection, fail-loud rather
than queueing:

- `compact()` **throws if any `find()` cursor is open** — a cursor's
  WASM-side scan is physically positioned inside the old files (the
  hazard `db.h` documents for `dc_cursor`).
- While a compact is in flight, **every other operation on that
  collection throws** a "being compacted" error (a synchronous flag
  check at each public entry point). A mutation that interleaved with
  the build phase would make the new generation internally inconsistent
  — the files are streamed one at a time — and a read that interleaved
  with the adopt phase would touch freed WASM handles. Failing loudly
  is simple, impossible to deadlock, and invisible to any caller that
  awaits its operations in order (the barrier can only trip when calls
  are issued concurrently with a pending `compact()`).
- Under `connectShared`, `compact` is an ordinary proxied method: only
  the leader holds files, so the swap happens where the handles live,
  and a follower RPC that races it gets the same retryable error.

Blocking writes during compaction is what real MongoDB's `compact` did
for years; the difference here is only that waiting is the caller's
choice rather than an internal queue.

## When to compact

Nothing triggers compaction automatically — the same host-driven
convention as TTL pruning (`pruneExpired()`): browsers give no reliable
background execution, and only the host knows its idle moments. Two
knobs make eager polling cheap:

- Each compact records `compactedBytes` (the new set's total size) in
  the catalog entry.
- `db.compact({ minBytes, factor })` skips any collection whose current
  file bytes are under `minBytes`, or under `factor ×` its
  `compactedBytes` baseline. Skipped collections cost a few `getSize()`
  calls. A never-compacted collection only needs to clear `minBytes`.

So `db.compact({ minBytes: 1 << 20, factor: 4 })` on a timer (or on
coordinator-leadership acquisition) approximates "compact anything that
has quadrupled since last time, ignore anything under a megabyte" — a
LevelDB-style growth heuristic that self-tunes: a collection whose live
set genuinely grows raises its own baseline with every compact.

## Deliberate non-goals

- **The catalog itself is not compacted.** It only grows on DDL
  (collection creation, createIndex/dropIndex — `compact()` adds one
  entry rewrite), not per document write, so growth is negligible. If it
  ever matters, the same generation trick applies with a fixed-size
  ping-pong manifest file (the journal's own pattern) as the bootstrap
  pointer to the live catalog file.
- **No online/incremental compaction.** `bpt_compact` accepts snapshots,
  so a future version could stream from a snapshot while buffering
  writes and replaying them before the flip; today the stop-the-world
  window is the cost of a much simpler correctness argument.
- **History is destroyed.** Snapshots (`snapshotAt`) and `boundaries()`
  of the old files become invalid — inherent to compaction, already the
  documented contract of `bpt_compact`. Don't compact a collection whose
  historical boundaries you still need.
- **Peak space is old + live.** Both generations exist between build and
  cleanup. Hosts near their OPFS quota should compact their largest
  collection first only if *live + old* still fits, or accept the
  failure mode: a build-phase quota error aborts cleanly, old generation
  intact.
