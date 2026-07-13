/*
 * db_query.h — filter matching, sorting, and projection for collection
 * queries (db.h). Operates purely on binjson bytes (documents, filters,
 * sort/projection specs); knows nothing about bpt or dc_collection.
 *
 * Filters are binjson OBJECTs. A top-level key is either a logical
 * operator ($and/$or/$nor, each taking a non-empty ARRAY of filter
 * OBJECTs) or a field path (dot-separated, e.g. "a.b.c" — descending
 * through nested OBJECTs only; a path segment that would need to index
 * into an ARRAY, or implicitly fan out over an array of subdocuments, is
 * not supported yet and simply resolves to "not found"). All top-level
 * entries are ANDed together, matching the reference's shallow-equality
 * behavior it replaces.
 *
 * A field's value is either a literal (matched by equality) or an
 * "operator expression" — an OBJECT whose keys are *all* $-prefixed
 * ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $not). Multiple
 * operators on one field are ANDed (e.g. {age: {$gte: 18, $lt: 65}}).
 * Any other $-prefixed key is an error (BJ_ERR_STATE) rather than a
 * silent no-op — an unrecognized operator (e.g. $regex, $type, $elemMatch,
 * $size, $all — not implemented yet) must never be mistaken for "matches
 * everything".
 *
 * If a resolved field value is an ARRAY, every operator except $exists
 * matches if it holds for the array value itself *or* for any one of its
 * elements (one level deep — matching MongoDB's default array-field
 * behavior for a plain path, without $elemMatch's element-wide-AND
 * semantics, which is deferred).
 *
 * Equality ($eq, and bare-literal matching) is exact encoded-byte
 * equality, same rationale as db.h: binjson's encoder is a deterministic
 * function of the JS value, so this reproduces MongoDB's embedded-
 * document/array exact-match semantics for free. A missing field never
 * equality-matches even a literal `null` (MongoDB's null-matches-missing
 * quirk is not implemented). Ordering ($gt/$gte/$lt/$lte) only compares
 * same-domain values — number vs number (INT and FLOAT unified, as
 * everywhere else in this codebase) or string vs string (byte-wise) — a
 * cross-domain comparison (or against a non-number/non-string) never
 * matches; MongoDB's full cross-BSON-type ordering is not implemented.
 */
#ifndef DB_QUERY_H
#define DB_QUERY_H

#include <stdint.h>
#include <stddef.h>

#include "binjson.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Does `doc` (a binjson OBJECT) match `filter` (a binjson OBJECT)? */
int qry_matches(const uint8_t *doc, size_t doc_len,
                const uint8_t *filter, size_t filter_len, int *out_matches);

/*
 * True (via *is_expr) iff `value` is a binjson OBJECT whose keys are all
 * $-prefixed (an "operator expression", e.g. {$gt: 5}) rather than a
 * literal to match by equality. An empty object {} is a literal (matches
 * a field whose value is itself {}). Exposed so db.c's equality-index
 * planner can recognize the same bare-value/{$eq: v} shape qry_matches
 * treats as a plain equality condition.
 */
int qry_is_operator_expr(const uint8_t *value, size_t value_len, int *is_expr);

typedef struct {
    const uint8_t *sort;        /* binjson OBJECT {field: 1|-1, ...}, or NULL for none */
    uint32_t sort_len;
    int64_t skip;                 /* 0 = none */
    int64_t limit;                 /* 0 = unlimited */
    const uint8_t *projection;   /* binjson OBJECT {field: 0|1, ...}, or NULL for none */
    uint32_t projection_len;
} qry_options;

/* Validate opts->sort up front (BJ_ERR_STATE if any value isn't exactly 1
 * or -1) so a later qry_collect can't fail partway through a sort. Safe to
 * call with a NULL `opts` (no-op, BJ_OK). */
int qry_validate_options(const qry_options *opts);

typedef struct { const uint8_t *ptr; size_t len; } qry_doc;

/*
 * Apply opts->sort/skip/limit/projection (any/all may be absent: NULL
 * `opts`, no sort, skip 0, limit 0, no projection) to `docs` — already-
 * matched, already-collected documents the caller owns and keeps valid
 * for the duration of this call — and emit the result as a binjson ARRAY
 * through *out / *out_len (freshly malloc'd, caller frees). Does not take
 * ownership of `docs` or its entries.
 */
int qry_collect(const qry_doc *docs, size_t count, const qry_options *opts,
                uint8_t **out, size_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* DB_QUERY_H */
