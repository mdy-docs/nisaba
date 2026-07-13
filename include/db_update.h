/*
 * db_update.h — apply MongoDB-style update operators to a document.
 *
 * An update document's top level must be entirely $-prefixed operators —
 * $set, $unset, $inc, $push, $pull — each an OBJECT mapping a field name
 * to an operand; a plain field (a full replacement document) is rejected
 * (BJ_ERR_STATE), since that is replaceOne's job, not updateOne/
 * updateMany's, matching the modern MongoDB driver's own validation.
 *
 * Scope, deliberately conservative (matching how db_query.h and db_keyenc.h
 * scope their own first cuts):
 *   - Target field names are top-level only — no dotted paths yet, so
 *     {$set: {"a.b": 1}} is rejected rather than silently doing something
 *     the caller didn't ask for. Auto-vivifying intermediate objects for a
 *     dotted $set path is real MongoDB behavior, not implemented here.
 *   - A field may be targeted by at most one operator per update (matches
 *     MongoDB's own "path collision" validation).
 *   - `_id` may never be targeted by any operator (matches MongoDB: the
 *     _id field cannot be modified by an update).
 *   - $inc requires the field (if present) and the operand to both be
 *     numbers (INT/FLOAT unified, as everywhere else in this codebase);
 *     the result is INT if it's a safe integer, else FLOAT — the same rule
 *     src/binjson-wasm.js's encoder uses for a plain JS number.
 *   - $push always appends a single element (no $each/$sort/$slice
 *     modifiers yet) and requires the field, if present, to be an ARRAY.
 *   - $pull removes every element *byte-equal* to its operand (no
 *     query-operator condition support yet, e.g. {$pull: {$gt: 5}} is not
 *     implemented) and requires the field, if present, to be an ARRAY;
 *     it is a no-op if the field is absent.
 */
#ifndef DB_UPDATE_H
#define DB_UPDATE_H

#include <stdint.h>
#include <stddef.h>

#include "binjson.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Apply `update` to `doc` (both binjson OBJECTs), producing a modified
 * copy through *out / *out_len (freshly malloc'd, caller frees). `doc`'s
 * `_id` field, and any field the update doesn't target, is copied through
 * unchanged.
 */
int upd_apply(const uint8_t *doc, size_t doc_len,
              const uint8_t *update, size_t update_len,
              uint8_t **out, size_t *out_len);

/*
 * Validate `update`'s shape (the same checks upd_apply does before
 * touching any particular document) without needing a document at hand —
 * for validating an update spec up front, before scanning for matches.
 */
int upd_validate(const uint8_t *update, size_t update_len);

#ifdef __cplusplus
}
#endif

#endif /* DB_UPDATE_H */
