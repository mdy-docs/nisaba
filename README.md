# Nisaba

> Nisaba (pronunciation: nee-SAH-bah)
> 
> Nisaba was the Sumerian goddess of writing, grain, and accounting — one of the oldest deities associated with record keeping and scribes. She was often depicted with a stylus and clay tablet, and scribes would invoke her name at the end of texts as a mark of accuracy and completeness.

A WASM/C, MongoDB-driver-shaped embedded document database: CRUD,
operator-aware query matching, `$regex` (ECMAScript-flavored, via
[regex-engine](https://github.com/mdy-docs/regex-engine)), update
operators, secondary/geo/text indexes, and change streams (`watch()`).

Built on [binjson](https://github.com/mdy-docs/binjson) (the wire
format and value types) and
[binjson-structures](https://github.com/mdy-docs/binjson-structures)
(the B+ tree primary store and secondary equality index, R-tree for geo
indexes, text index for `$text`-style search) — `nisaba`'s own C code
(`wasm/src/db.c`/`db_query.c`/`db_update.c`/`db_keyenc.c`/`db_wasm.c`, plus
`regex.c` as the `$regex` adapter over regex-engine) is the CRUD/query/
update layer built on top of those, not a data structure itself.

Split out from the parent `binjson` document-database project (currently
staged ahead of becoming its own git submodule/repo there — see that
project's `third_party/regex-engine` for the pattern this is following).
The cloud SaaS layer that runs this as a service (control plane,
REST/WebSocket gateways, a MongoDB-driver-shaped HTTP client) is **not**
part of this package — it stays in the parent project, built on top of
the `Db`/`Client` this package exports, the same way any other
application would consume it.

## Dependencies

This package's C sources call directly into binjson's encoder/builder
and binjson-structures' B+ tree/R-tree/text-index functions — real
compile-time and link-time dependencies, not just shared headers. Its
own standalone WASM build links this package's sources together with
checkouts of binjson, binjson-structures, and regex-engine into one
binary; its JS wrapper keeps its own self-contained copy of the codec
and tree-wrapper classes for the same reason (see the top comment of
`wasm/nisaba-wasm.js`).

Those checkouts are git submodules of *this* repo
(`third_party/binjson`, `third_party/binjson-structures`,
`third_party/regex-engine`), used only for this package's own
standalone build/test. A project that already depends on all of these
(like the parent `binjson` project itself) should supply its own single
copy of each to build against, rather than relying on these nested
copies, to avoid ending up with duplicate checkouts linked into the
same binary.

```
git submodule update --init
./wasm/build-wasm.sh
```

## Usage

```js
import { ready, connect, MemoryStorageProvider } from './wasm/nisaba-wasm.js';

await ready();
const db = await connect(new MemoryStorageProvider());
const users = await db.collection('users');

const { insertedId } = await users.insertOne({ name: 'Ada', team: 'core' });
await users.createIndex({ team: 1 });
const core = await users.find({ team: 'core' }).toArray();
```

`connect(provider)` opens a single database against a storage provider
(`MemoryStorageProvider` for in-memory/ephemeral use, `OPFSStorageProvider`
for real browser/Worker persistence). `connectClient(provider)` opens a
`Client` with multiple independently named databases, each its own
isolated storage scope — see `Client.db(name)`.
