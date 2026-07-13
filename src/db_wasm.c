/*
 * db_wasm.c — Emscripten glue over the document-collection ops in db.c.
 *
 * A collection is opened once via dcw_collection_open(primaryTreeCtx) —
 * primary and index trees themselves are opened via the existing
 * bptw_create/bptw_open (bplustree_wasm.c) — and freed with
 * dcw_collection_free. Filters, documents, replacements and index field/
 * value lists cross the bridge as pre-encoded binjson bytes (ptr+len) the
 * JS side already produces via encode(); dc_find_one/dc_find/
 * dc_collection_find_by_index results land in a reusable per-collection
 * output slot (dcw_out_new/dcw_out_free, mirroring textindex_wasm.c's
 * tixw_out) read via dcw_out_ptr/dcw_out_len.
 *
 * Memory: heap growth may swap HEAPU8's ArrayBuffer, so JS must re-read
 * HEAPU8 after any call before touching a returned pointer.
 */
#include "db.h"
#include "dbuf.h"

#include <limits.h>
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

typedef struct { uint8_t *buf; size_t len; } dcw_out;

EMSCRIPTEN_KEEPALIVE dcw_out *dcw_out_new(void) {
    return (dcw_out *)calloc(1, sizeof(dcw_out));
}
EMSCRIPTEN_KEEPALIVE void dcw_out_free(dcw_out *o) {
    if (!o) return;
    free(o->buf);
    free(o);
}
static void reset_out(dcw_out *o) { free(o->buf); o->buf = NULL; o->len = 0; }

EMSCRIPTEN_KEEPALIVE dc_collection *dcw_collection_open(bpt *primary) {
    return dc_collection_open(primary);
}
EMSCRIPTEN_KEEPALIVE void dcw_collection_free(dc_collection *c) {
    dc_collection_free(c);
}

EMSCRIPTEN_KEEPALIVE int dcw_collection_attach_index(dc_collection *c,
        const char *name, int name_len, bpt *index_tree,
        const uint8_t *fields, int fields_len) {
    return dc_collection_attach_index(c, name, name_len, index_tree, fields, (uint32_t)fields_len);
}
EMSCRIPTEN_KEEPALIVE int dcw_collection_add_index(dc_collection *c,
        const char *name, int name_len, bpt *index_tree,
        const uint8_t *fields, int fields_len) {
    return dc_collection_add_index(c, name, name_len, index_tree, fields, (uint32_t)fields_len);
}
EMSCRIPTEN_KEEPALIVE int dcw_collection_attach_text_index(dc_collection *c,
        const char *name, int name_len,
        bpt *tix_index, bpt *tix_doc_terms, bpt *tix_doc_lengths,
        const char *field, int field_len) {
    return dc_collection_attach_text_index(c, name, name_len, tix_index, tix_doc_terms, tix_doc_lengths, field, field_len);
}
EMSCRIPTEN_KEEPALIVE int dcw_collection_add_text_index(dc_collection *c,
        const char *name, int name_len,
        bpt *tix_index, bpt *tix_doc_terms, bpt *tix_doc_lengths,
        const char *field, int field_len) {
    return dc_collection_add_text_index(c, name, name_len, tix_index, tix_doc_terms, tix_doc_lengths, field, field_len);
}

EMSCRIPTEN_KEEPALIVE int dcw_collection_attach_geo_index(dc_collection *c,
        const char *name, int name_len, rtree *rt,
        const char *field, int field_len) {
    return dc_collection_attach_geo_index(c, name, name_len, rt, field, field_len);
}
EMSCRIPTEN_KEEPALIVE int dcw_collection_add_geo_index(dc_collection *c,
        const char *name, int name_len, rtree *rt,
        const char *field, int field_len) {
    return dc_collection_add_geo_index(c, name, name_len, rt, field, field_len);
}

EMSCRIPTEN_KEEPALIVE int dcw_collection_remove_index(dc_collection *c,
        const char *name, int name_len) {
    return dc_collection_remove_index(c, name, name_len);
}

EMSCRIPTEN_KEEPALIVE int dcw_find_by_index(dcw_out *o, dc_collection *c,
        const char *name, int name_len, const uint8_t *values, int values_len) {
    reset_out(o);
    return dc_collection_find_by_index(c, name, name_len, values, (uint32_t)values_len, &o->buf, &o->len);
}

EMSCRIPTEN_KEEPALIVE int dcw_insert_one(dc_collection *c, const uint8_t *doc, int doc_len) {
    return dc_insert_one(c, doc, (uint32_t)doc_len);
}

/* Returns 1 if found (document in the out slot), 0 if not, negative on error. */
EMSCRIPTEN_KEEPALIVE int dcw_find_one(dcw_out *o, dc_collection *c,
                                      const uint8_t *filter, int filter_len) {
    reset_out(o);
    int found = 0;
    int e = dc_find_one(c, filter, (uint32_t)filter_len, &found, &o->buf, &o->len);
    if (e) return e;
    return found ? 1 : 0;
}

/* `sort`/`projection` may be NULL (with length 0) for "none"; skip/limit
 * cross the bridge as doubles (like every other count/size value here) and
 * 0 means "no skip" / "no limit" -- see query.h. */
EMSCRIPTEN_KEEPALIVE int dcw_find(dcw_out *o, dc_collection *c,
                                  const uint8_t *filter, int filter_len,
                                  const uint8_t *sort, int sort_len,
                                  double skip, double limit,
                                  const uint8_t *projection, int projection_len) {
    reset_out(o);
    qry_options opts;
    opts.sort = sort_len > 0 ? sort : NULL;
    opts.sort_len = sort_len > 0 ? (uint32_t)sort_len : 0;
    opts.skip = (int64_t)skip;
    opts.limit = (int64_t)limit;
    opts.projection = projection_len > 0 ? projection : NULL;
    opts.projection_len = projection_len > 0 ? (uint32_t)projection_len : 0;
    return dc_find(c, filter, (uint32_t)filter_len, &opts, &o->buf, &o->len);
}

/* Returns 1 if deleted, 0 if not found, negative on error. */
EMSCRIPTEN_KEEPALIVE int dcw_delete_one(dc_collection *c, const uint8_t *filter, int filter_len) {
    int deleted = 0;
    int e = dc_delete_one(c, filter, (uint32_t)filter_len, &deleted);
    if (e) return e;
    return deleted ? 1 : 0;
}

/* Returns 0 (no match, no upsert), 1 (matched and replaced), 2 (upserted),
 * or a negative error. */
EMSCRIPTEN_KEEPALIVE int dcw_replace_one(dc_collection *c,
        const uint8_t *filter, int filter_len,
        const uint8_t *replacement, int replacement_len,
        const uint8_t *default_id, int upsert) {
    int result = 0;
    int e = dc_replace_one(c, filter, (uint32_t)filter_len,
                           replacement, (uint32_t)replacement_len,
                           default_id, upsert, &result);
    if (e) return e;
    return result;
}

/* Returns 0 (no match, no upsert), 1 (matched and updated), 2 (upserted),
 * or a negative error. */
EMSCRIPTEN_KEEPALIVE int dcw_update_one(dc_collection *c,
        const uint8_t *filter, int filter_len,
        const uint8_t *update, int update_len,
        const uint8_t *default_id, int upsert) {
    int result = 0;
    int e = dc_update_one(c, filter, (uint32_t)filter_len,
                          update, (uint32_t)update_len,
                          default_id, upsert, &result);
    if (e) return e;
    return result;
}

/* Writes a binjson OBJECT { matchedCount: number, upserted: bool } into the
 * out slot; matchedCount is 0 whenever upserted is true. Returns 0 on
 * success, negative on error. */
EMSCRIPTEN_KEEPALIVE int dcw_update_many(dcw_out *o, dc_collection *c,
        const uint8_t *filter, int filter_len,
        const uint8_t *update, int update_len,
        const uint8_t *default_id, int upsert) {
    reset_out(o);
    int64_t matched = 0; int upserted = 0;
    int e = dc_update_many(c, filter, (uint32_t)filter_len,
                           update, (uint32_t)update_len,
                           default_id, upsert, &matched, &upserted);
    if (e) return e;

    bj_builder *b = bj_builder_new();
    if (!b) return BJ_ERR_OOM;
    e = bj_begin_object(b);
    if (!e) e = bj_put_key(b, (const uint8_t *)"matchedCount", 12);
    if (!e) e = bj_put_int(b, matched);
    if (!e) e = bj_put_key(b, (const uint8_t *)"upserted", 8);
    if (!e) e = bj_put_bool(b, upserted);
    if (!e) e = bj_end_object(b);
    if (!e) {
        size_t n; const uint8_t *p = bj_builder_data(b, &n);
        if (!p) e = bj_builder_error(b) ? bj_builder_error(b) : BJ_ERR_STATE;
        else e = dbuf_dup(p, n, &o->buf, &o->len);
    }
    bj_builder_free(b);
    return e;
}

EMSCRIPTEN_KEEPALIVE double dcw_count(dc_collection *c, const uint8_t *filter, int filter_len) {
    int64_t n = 0;
    int e = dc_count(c, filter, (uint32_t)filter_len, &n);
    return e ? (double)e : (double)n;
}

EMSCRIPTEN_KEEPALIVE const uint8_t *dcw_out_ptr(dcw_out *o) { return o->buf; }
/* Length of the slot's last output, or BJ_ERR_INT_RANGE if it cannot cross
 * the boundary as an int (>= 2 GB) instead of a silently truncated number. */
EMSCRIPTEN_KEEPALIVE int dcw_out_len(dcw_out *o) {
    return o->len > INT_MAX ? BJ_ERR_INT_RANGE : (int)o->len;
}
