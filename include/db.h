/*
 * db.h — document-collection CRUD, secondary-index maintenance and filter
 * matching on top of B+ trees (bplustree.h).
 *
 * A collection is a `dc_collection`: one primary bpt (documents keyed by the
 * raw 12-byte ObjectId, an opaque byte-string key) plus zero or more
 * attached secondary indexes, each its own bpt keyed by a composite of
 * ordered field values + an id suffix (keyenc.h), per the convention
 * documented in bplustree.h. `dc_collection` only *coordinates* already-open
 * bpt handles — every bpt (primary and each index) is opened/closed by the
 * host (JS), exactly as milestone 1's plain `bpt*` was.
 *
 * _id is a client-side concern, like textlog's ts_ms: the caller supplies a
 * document whose top-level `_id` field is already an OID — dc_insert_one
 * extracts it as the key and errors if it is missing or the wrong type. This
 * mirrors how MongoDB drivers generate _id before the wire write rather than
 * the storage engine inventing it, and keeps randomness/clock access (which
 * WASM has no portable source for) out of C entirely.
 *
 * Filters are themselves binjson OBJECTs, matched by top-level field
 * equality: a filter field matches a document field when their encoded
 * value bytes are identical. Because binjson's encoder is a deterministic
 * function of the JS value, equal values always produce identical bytes —
 * including for embedded documents and arrays, where byte equality
 * reproduces MongoDB's own exact-match semantics (field order matters for
 * embedded-document equality queries in real MongoDB too). No $operators
 * yet, and find/findOne/count do not consult indexes — that's the query
 * planner, a later milestone; dc_collection_find_by_index is a low-level
 * index-scan primitive exposed for that milestone (and for verifying an
 * index directly) to build on.
 *
 * Known gap (see docs/db-plan.md milestone 5): index maintenance is not
 * transactional with the primary write. If a crash or an index-maintenance
 * error (e.g. a document missing an indexed field) happens between updating
 * the primary tree and an index tree, they can end up inconsistent. This
 * mirrors textindex.c's cross-tree consistency gap before its own journal
 * milestone (docs/textindex-atomicity.md).
 *
 * All operations return BJ_OK (0) or a negative BJ_ERR_* / DC_ERR_* code.
 */
#ifndef DB_H
#define DB_H

#include <stdint.h>
#include <stddef.h>

#include "binjson.h"
#include "bplustree.h"

#ifdef __cplusplus
extern "C" {
#endif

/* insertOne (or a replaceOne upsert) targets an _id that already exists. */
#define DC_ERR_DUPLICATE   (-10)
/* replaceOne's replacement document names an _id different from the
 * document `filter` matched. */
#define DC_ERR_ID_MISMATCH (-11)

typedef struct dc_collection dc_collection;

/* Wrap an already-open primary bpt as a collection with no indexes attached
 * yet. Returns NULL on OOM. Does not take ownership of `primary`. */
dc_collection *dc_collection_open(bpt *primary);
/* Free the collection's own bookkeeping (index registrations). Does not
 * close/free the primary tree or any attached index tree — those are owned
 * by the host. Safe on NULL. */
void dc_collection_free(dc_collection *c);

/*
 * Register `index_tree` (already open, caller-owned, expected to already
 * hold exactly the composite-key entries for every document currently in
 * `c`) as a secondary index named `name`, keyed by the ordered fields named
 * in `fields` (a binjson ARRAY of at least one STRING, in composite-key
 * order) — for reattaching an index that was already built, e.g. on
 * collection reopen. Use dc_collection_add_index instead to create and
 * backfill a brand-new index. BJ_ERR_STATE if `name` is already registered
 * or `fields` is empty/malformed.
 */
int dc_collection_attach_index(dc_collection *c, const char *name, int name_len,
                               bpt *index_tree,
                               const uint8_t *fields, uint32_t fields_len);

/*
 * Like dc_collection_attach_index, but also backfills `index_tree` (expected
 * empty) against every document already in `c`'s primary tree before
 * attaching it for ongoing maintenance — for creating a brand-new index.
 * All-or-nothing: a document missing one of `fields`, or holding a
 * non-number/string value for one, fails the whole call (BJ_ERR_STATE) and
 * leaves `c` without the index registered (the caller should discard
 * `index_tree`'s file), matching MongoDB's own index-build failure
 * behavior for a field with disqualifying values.
 */
int dc_collection_add_index(dc_collection *c, const char *name, int name_len,
                            bpt *index_tree,
                            const uint8_t *fields, uint32_t fields_len);

/* Unregister a previously attached/added index by name. Does not touch its
 * tree (the host closes/deletes its file). BJ_ERR_STATE if no such index. */
int dc_collection_remove_index(dc_collection *c, const char *name, int name_len);

/*
 * Every document whose indexed fields equal `values` (a binjson ARRAY of
 * scalars, same count and order as index `name`'s fields), found via an
 * O(log n + k) range scan of the index rather than a collection scan.
 * Writes a freshly malloc'd binjson ARRAY of documents through
 * *out / *out_len (caller frees). BJ_ERR_STATE if no such index or `values`
 * doesn't match its field count.
 */
int dc_collection_find_by_index(dc_collection *c, const char *name, int name_len,
                                const uint8_t *values, uint32_t values_len,
                                uint8_t **out, size_t *out_len);

/*
 * Insert `doc` (a binjson OBJECT whose top-level `_id` is an OID — BJ_ERR_
 * STATE if missing or not an OID) into `c`'s primary tree and every
 * attached index. DC_ERR_DUPLICATE if that id already exists.
 */
int dc_insert_one(dc_collection *c, const uint8_t *doc, uint32_t doc_len);

/*
 * First document matching `filter` (a binjson OBJECT; {} matches every
 * document). *found is 1/0; when found, writes a freshly malloc'd copy of
 * the document through *out / *out_len (caller frees). The special case
 * filter == {_id: <oid>} is an O(log n) bpt_search; anything else is a full
 * scan of the primary tree (indexes are not consulted yet).
 */
int dc_find_one(dc_collection *c, const uint8_t *filter, uint32_t filter_len,
                int *found, uint8_t **out, size_t *out_len);

/*
 * Every document matching `filter`, as a binjson ARRAY of documents (not
 * {key,value} pairs). Writes a freshly malloc'd buffer through *out / *out_len
 * (caller frees).
 */
int dc_find(dc_collection *c, const uint8_t *filter, uint32_t filter_len,
            uint8_t **out, size_t *out_len);

/* Delete the first document matching `filter`, from the primary tree and
 * every attached index. *deleted is 1/0. */
int dc_delete_one(dc_collection *c, const uint8_t *filter, uint32_t filter_len, int *deleted);

/*
 * Replace the first document matching `filter` with `replacement` (a
 * binjson OBJECT), updating every attached index to match. The stored
 * document keeps the matched document's _id regardless of what
 * `replacement` carries for _id, unless `replacement` names a *different*
 * OID, which fails with DC_ERR_ID_MISMATCH.
 *
 * No match: `upsert` 0 is a no-op. `upsert` 1 inserts `replacement` — using
 * its own `_id` field if it has one, otherwise `default_id` (the host
 * supplies this, generated the same way an insertOne id would be, since
 * whether it will actually be needed is only known after the match here).
 *
 * *result is written to 0 (no match, no upsert), 1 (matched and replaced),
 * or 2 (upserted).
 */
int dc_replace_one(dc_collection *c, const uint8_t *filter, uint32_t filter_len,
                   const uint8_t *replacement, uint32_t replacement_len,
                   const uint8_t default_id[12], int upsert, int *result);

/* Count of documents matching `filter` ({} is bpt_size of the primary tree,
 * O(1)). */
int dc_count(dc_collection *c, const uint8_t *filter, uint32_t filter_len, int64_t *out_count);

#ifdef __cplusplus
}
#endif

#endif /* DB_H */
