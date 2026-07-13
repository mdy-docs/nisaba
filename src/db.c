/*
 * db.c — see db.h.
 *
 * Documents and filters are read with the shared bjcursor.h primitives
 * (object_begin/take_key/skip_value); nothing here decodes a value into a
 * host tree the way binjson.h's visitor-based bj_decode does — field lookup
 * and filter matching only ever need "where does this field's value start
 * and end", which skip_value gives directly. Composite index keys are built
 * with keyenc.h.
 */
#include "db.h"
#include "keyenc.h"
#include "bjcursor.h"

#include <stdlib.h>
#include <string.h>

/* ---- dc_collection: primary tree + attached secondary indexes --------- */

typedef struct {
    char *name;
    uint32_t name_len;
    bpt *tree;                  /* not owned */
    uint8_t **field_names;      /* owned copies, one per composite-key part */
    uint32_t *field_name_lens;
    uint32_t field_count;
} dc_index;

struct dc_collection {
    bpt *primary;                /* not owned */
    dc_index *indexes;           /* owned, dense array */
    uint32_t index_count;
    uint32_t index_cap;
};

static void free_index(dc_index *ix) {
    free(ix->name);
    for (uint32_t i = 0; i < ix->field_count; i++) free(ix->field_names[i]);
    free(ix->field_names);
    free(ix->field_name_lens);
    memset(ix, 0, sizeof(*ix));
}

dc_collection *dc_collection_open(bpt *primary) {
    dc_collection *c = (dc_collection *)calloc(1, sizeof(dc_collection));
    if (!c) return NULL;
    c->primary = primary;
    return c;
}

void dc_collection_free(dc_collection *c) {
    if (!c) return;
    for (uint32_t i = 0; i < c->index_count; i++) free_index(&c->indexes[i]);
    free(c->indexes);
    free(c);
}

static dc_index *find_index(dc_collection *c, const char *name, int name_len) {
    for (uint32_t i = 0; i < c->index_count; i++) {
        if (c->indexes[i].name_len == (uint32_t)name_len &&
            memcmp(c->indexes[i].name, name, (size_t)name_len) == 0) {
            return &c->indexes[i];
        }
    }
    return NULL;
}

int dc_collection_attach_index(dc_collection *c, const char *name, int name_len,
                               bpt *index_tree,
                               const uint8_t *fields, uint32_t fields_len) {
    if (find_index(c, name, name_len)) return BJ_ERR_STATE;

    cur fc = { fields, fields_len, 0 };
    uint32_t fcount;
    int e = array_begin(&fc, &fcount);
    if (e) return e;
    if (fcount == 0) return BJ_ERR_STATE;

    dc_index ix;
    memset(&ix, 0, sizeof(ix));
    ix.name = (char *)malloc(name_len ? (size_t)name_len : 1);
    if (!ix.name) return BJ_ERR_OOM;
    memcpy(ix.name, name, (size_t)name_len);
    ix.name_len = (uint32_t)name_len;
    ix.tree = index_tree;
    ix.field_names = (uint8_t **)calloc(fcount, sizeof(uint8_t *));
    ix.field_name_lens = (uint32_t *)calloc(fcount, sizeof(uint32_t));
    if (!ix.field_names || !ix.field_name_lens) { free_index(&ix); return BJ_ERR_OOM; }

    for (uint32_t i = 0; i < fcount; i++) {
        const uint8_t *sp; uint32_t slen;
        e = take_string(&fc, &sp, &slen);
        if (e) { free_index(&ix); return e; }
        ix.field_names[i] = (uint8_t *)malloc(slen ? slen : 1);
        if (!ix.field_names[i]) { free_index(&ix); return BJ_ERR_OOM; }
        memcpy(ix.field_names[i], sp, slen);
        ix.field_name_lens[i] = slen;
        ix.field_count = i + 1;
    }

    if (c->index_count == c->index_cap) {
        uint32_t ncap = c->index_cap ? c->index_cap * 2 : 4;
        dc_index *nb = (dc_index *)realloc(c->indexes, ncap * sizeof(dc_index));
        if (!nb) { free_index(&ix); return BJ_ERR_OOM; }
        c->indexes = nb;
        c->index_cap = ncap;
    }
    c->indexes[c->index_count++] = ix;
    return BJ_OK;
}

int dc_collection_remove_index(dc_collection *c, const char *name, int name_len) {
    for (uint32_t i = 0; i < c->index_count; i++) {
        if (c->indexes[i].name_len == (uint32_t)name_len &&
            memcmp(c->indexes[i].name, name, (size_t)name_len) == 0) {
            free_index(&c->indexes[i]);
            for (uint32_t j = i; j + 1 < c->index_count; j++) c->indexes[j] = c->indexes[j + 1];
            c->index_count--;
            return BJ_OK;
        }
    }
    return BJ_ERR_STATE;
}

/* ---- shared helpers ----------------------------------------------------- */

static void oid_key(const uint8_t id[12], bpt_key *k) {
    k->is_string = 1;
    k->num = 0;
    k->str = id;
    k->str_len = 12;
}

static int dup_bytes(const uint8_t *p, size_t n, uint8_t **out, size_t *out_len) {
    uint8_t *buf = (uint8_t *)malloc(n ? n : 1);
    if (!buf) return BJ_ERR_OOM;
    if (n) memcpy(buf, p, n);
    *out = buf;
    *out_len = n;
    return BJ_OK;
}

/* Look up `name` at the top level of binjson OBJECT `obj`. On success,
 * *found = 1 and val_ptr/val_len span exactly the field's encoded value
 * (type byte included), pointing into `obj`; *found = 0 if no such field. */
static int obj_get_field(const uint8_t *obj, size_t obj_len,
                          const uint8_t *name, uint32_t name_len,
                          const uint8_t **val_ptr, size_t *val_len, int *found) {
    cur c = { obj, obj_len, 0 };
    uint32_t count;
    int e = object_begin(&c, &count);
    if (e) return e;
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *kp; uint32_t klen;
        e = take_key(&c, &kp, &klen);
        if (e) return e;
        size_t vstart = c.pos;
        e = skip_value(&c);
        if (e) return e;
        if (klen == name_len && memcmp(kp, name, name_len) == 0) {
            *val_ptr = c.d + vstart;
            *val_len = c.pos - vstart;
            *found = 1;
            return BJ_OK;
        }
    }
    *found = 0;
    return BJ_OK;
}

/* `doc`'s top-level _id, which must be an OID (13 encoded bytes: type + 12
 * raw). BJ_ERR_STATE if absent or any other type. */
static int dc_get_id(const uint8_t *doc, uint32_t doc_len, uint8_t id_out[12]) {
    const uint8_t *vp; size_t vlen; int found;
    int e = obj_get_field(doc, doc_len, (const uint8_t *)"_id", 3, &vp, &vlen, &found);
    if (e) return e;
    if (!found || vlen != 13 || vp[0] != BJ_TYPE_OID) return BJ_ERR_STATE;
    memcpy(id_out, vp + 1, 12);
    return BJ_OK;
}

/* True (via *out_matches) iff every field in `filter` has an identically-
 * encoded counterpart in `doc` — see db.h for why byte equality is the
 * right notion of "equal" here. */
static int dc_matches(const uint8_t *doc, size_t doc_len,
                      const uint8_t *filter, size_t filter_len, int *out_matches) {
    cur c = { filter, filter_len, 0 };
    uint32_t count;
    int e = object_begin(&c, &count);
    if (e) return e;
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *kp; uint32_t klen;
        e = take_key(&c, &kp, &klen);
        if (e) return e;
        size_t vstart = c.pos;
        e = skip_value(&c);
        if (e) return e;
        size_t vlen = c.pos - vstart;

        const uint8_t *dval; size_t dlen; int found;
        e = obj_get_field(doc, doc_len, kp, klen, &dval, &dlen, &found);
        if (e) return e;
        if (!found || dlen != vlen || memcmp(dval, c.d + vstart, vlen) != 0) {
            *out_matches = 0;
            return BJ_OK;
        }
    }
    *out_matches = 1;
    return BJ_OK;
}

/* True (via *is_id_filter) iff `filter` is exactly {_id: <OID>}; when true,
 * writes the 12 id bytes. Any other shape is *is_id_filter = 0, not an
 * error — callers fall back to a scan. */
static int filter_is_id_only(const uint8_t *filter, size_t filter_len,
                             uint8_t id_out[12], int *is_id_filter) {
    cur c = { filter, filter_len, 0 };
    uint32_t count;
    int e = object_begin(&c, &count);
    if (e) return e;
    *is_id_filter = 0;
    if (count != 1) return BJ_OK;
    const uint8_t *kp; uint32_t klen;
    e = take_key(&c, &kp, &klen);
    if (e) return e;
    if (!(klen == 3 && memcmp(kp, "_id", 3) == 0)) return BJ_OK;
    size_t vstart = c.pos;
    e = skip_value(&c);
    if (e) return e;
    size_t vlen = c.pos - vstart;
    if (vlen != 13 || c.d[vstart] != BJ_TYPE_OID) return BJ_OK;
    memcpy(id_out, c.d + vstart + 1, 12);
    *is_id_filter = 1;
    return BJ_OK;
}

/* ---- index maintenance --------------------------------------------------- */

/* Build one index's composite key for `doc`/`id` (its ordered field values
 * followed by the id-suffix tag + `id`) into `out`, an ordinary dbuf the
 * caller zero-inits and frees. */
static int build_index_key(const dc_index *ix, const uint8_t *doc, size_t doc_len,
                           const uint8_t id[12], dbuf *out) {
    for (uint32_t i = 0; i < ix->field_count; i++) {
        const uint8_t *vp; size_t vlen; int found;
        int e = obj_get_field(doc, doc_len, ix->field_names[i], ix->field_name_lens[i], &vp, &vlen, &found);
        if (e) return e;
        if (!found) return BJ_ERR_STATE; /* indexed field missing from this document */
        e = qk_put_value(out, vp, vlen);
        if (e) return e;
    }
    return qk_put_id(out, id);
}

static int add_to_one_index(dc_index *ix, const uint8_t *doc, size_t doc_len, const uint8_t id[12]) {
    dbuf key_bytes; memset(&key_bytes, 0, sizeof(key_bytes));
    int e = build_index_key(ix, doc, doc_len, id, &key_bytes);
    if (e) { dbuf_free(&key_bytes); return e; }
    bpt_key key; key.is_string = 1; key.num = 0;
    key.str = key_bytes.data; key.str_len = (uint32_t)key_bytes.len;
    /* The index's value is a proper binjson-encoded OID (the row reference,
     * per bplustree.h's composite-key convention) so index files stay
     * independently inspectable with bin/bplustree.js. */
    uint8_t idval[13]; idval[0] = BJ_TYPE_OID; memcpy(idval + 1, id, 12);
    e = bpt_add(ix->tree, &key, idval, 13);
    dbuf_free(&key_bytes);
    return e;
}

static int remove_from_one_index(dc_index *ix, const uint8_t *doc, size_t doc_len, const uint8_t id[12]) {
    dbuf key_bytes; memset(&key_bytes, 0, sizeof(key_bytes));
    int e = build_index_key(ix, doc, doc_len, id, &key_bytes);
    if (e) { dbuf_free(&key_bytes); return e; }
    bpt_key key; key.is_string = 1; key.num = 0;
    key.str = key_bytes.data; key.str_len = (uint32_t)key_bytes.len;
    e = bpt_delete(ix->tree, &key);
    dbuf_free(&key_bytes);
    return e;
}

static int add_to_indexes(dc_collection *c, const uint8_t *doc, size_t doc_len, const uint8_t id[12]) {
    for (uint32_t i = 0; i < c->index_count; i++) {
        int e = add_to_one_index(&c->indexes[i], doc, doc_len, id);
        if (e) return e;
    }
    return BJ_OK;
}

static int remove_from_indexes(dc_collection *c, const uint8_t *doc, size_t doc_len, const uint8_t id[12]) {
    for (uint32_t i = 0; i < c->index_count; i++) {
        int e = remove_from_one_index(&c->indexes[i], doc, doc_len, id);
        if (e) return e;
    }
    return BJ_OK;
}

int dc_collection_add_index(dc_collection *c, const char *name, int name_len,
                            bpt *index_tree,
                            const uint8_t *fields, uint32_t fields_len) {
    int e = dc_collection_attach_index(c, name, name_len, index_tree, fields, fields_len);
    if (e) return e;
    dc_index *ix = &c->indexes[c->index_count - 1];

    bpt_cursor *cur_h = bpt_cursor_open(c->primary, NULL, NULL);
    if (!cur_h) { dc_collection_remove_index(c, name, name_len); return BJ_ERR_OOM; }
    int rc = BJ_OK;
    for (;;) {
        bpt_key k; const uint8_t *val; size_t vlen;
        int r = bpt_cursor_next(cur_h, &k, &val, &vlen);
        if (r < 0) { rc = r; break; }
        if (r == 0) break;
        rc = add_to_one_index(ix, val, vlen, k.str);
        if (rc) break;
    }
    bpt_cursor_close(cur_h);
    if (rc) { dc_collection_remove_index(c, name, name_len); return rc; }
    return BJ_OK;
}

int dc_collection_find_by_index(dc_collection *c, const char *name, int name_len,
                                const uint8_t *values, uint32_t values_len,
                                uint8_t **out, size_t *out_len) {
    *out = NULL; *out_len = 0;
    dc_index *ix = find_index(c, name, name_len);
    if (!ix) return BJ_ERR_STATE;

    cur vc = { values, values_len, 0 };
    uint32_t vcount;
    int e = array_begin(&vc, &vcount);
    if (e) return e;
    if (vcount != ix->field_count) return BJ_ERR_STATE;

    dbuf prefix; memset(&prefix, 0, sizeof(prefix));
    for (uint32_t i = 0; i < vcount && !e; i++) {
        size_t vstart = vc.pos;
        e = skip_value(&vc);
        if (!e) e = qk_put_value(&prefix, vc.d + vstart, vc.pos - vstart);
    }
    if (e) { dbuf_free(&prefix); return e; }

    dbuf upper; memset(&upper, 0, sizeof(upper));
    e = dbuf_put(&upper, prefix.data, prefix.len);
    if (!e) e = qk_put_upper_bound(&upper);
    if (e) { dbuf_free(&prefix); dbuf_free(&upper); return e; }

    bpt_key min_key; min_key.is_string = 1; min_key.num = 0;
    min_key.str = prefix.data; min_key.str_len = (uint32_t)prefix.len;
    bpt_key max_key; max_key.is_string = 1; max_key.num = 0;
    max_key.str = upper.data; max_key.str_len = (uint32_t)upper.len;

    bj_builder *b = bj_builder_new();
    if (!b) { dbuf_free(&prefix); dbuf_free(&upper); return BJ_ERR_OOM; }
    e = bj_begin_array(b);

    bpt_cursor *cur_h = NULL;
    if (!e) {
        cur_h = bpt_cursor_open(ix->tree, &min_key, &max_key);
        if (!cur_h) e = BJ_ERR_OOM;
    }
    while (!e && cur_h) {
        bpt_key k; const uint8_t *val; size_t vlen;
        int r = bpt_cursor_next(cur_h, &k, &val, &vlen);
        if (r < 0) { e = r; break; }
        if (r == 0) break;
        if (vlen != 13 || val[0] != BJ_TYPE_OID) { e = BJ_ERR_STATE; break; }
        bpt_key pkey; oid_key(val + 1, &pkey);
        int found = 0; const uint8_t *dp; size_t dn;
        e = bpt_search(c->primary, &pkey, &found, &dp, &dn);
        if (e) break;
        if (found) e = bj_put_raw(b, dp, (uint32_t)dn);
    }
    if (cur_h) bpt_cursor_close(cur_h);
    dbuf_free(&prefix);
    dbuf_free(&upper);
    if (!e) e = bj_end_array(b);

    if (!e) {
        size_t n; const uint8_t *p = bj_builder_data(b, &n);
        if (!p) e = bj_builder_error(b) ? bj_builder_error(b) : BJ_ERR_STATE;
        else e = dup_bytes(p, n, out, out_len);
    }
    bj_builder_free(b);
    return e;
}

/* ---- CRUD ---------------------------------------------------------------- */

int dc_insert_one(dc_collection *c, const uint8_t *doc, uint32_t doc_len) {
    uint8_t id[12];
    int e = dc_get_id(doc, doc_len, id);
    if (e) return e;
    bpt_key key; oid_key(id, &key);
    int found = 0;
    const uint8_t *p; size_t n;
    e = bpt_search(c->primary, &key, &found, &p, &n);
    if (e) return e;
    if (found) return DC_ERR_DUPLICATE;
    e = bpt_add(c->primary, &key, doc, doc_len);
    if (e) return e;
    return add_to_indexes(c, doc, doc_len, id);
}

int dc_find_one(dc_collection *c, const uint8_t *filter, uint32_t filter_len,
                int *found, uint8_t **out, size_t *out_len) {
    *found = 0; *out = NULL; *out_len = 0;

    uint8_t id[12]; int is_id;
    int e = filter_is_id_only(filter, filter_len, id, &is_id);
    if (e) return e;

    if (is_id) {
        bpt_key key; oid_key(id, &key);
        int f = 0; const uint8_t *p; size_t n;
        e = bpt_search(c->primary, &key, &f, &p, &n);
        if (e || !f) return e;
        *found = 1;
        return dup_bytes(p, n, out, out_len);
    }

    bpt_cursor *cur_h = bpt_cursor_open(c->primary, NULL, NULL);
    if (!cur_h) return BJ_ERR_OOM;
    int rc = BJ_OK;
    for (;;) {
        bpt_key k; const uint8_t *val; size_t vlen;
        int r = bpt_cursor_next(cur_h, &k, &val, &vlen);
        if (r < 0) { rc = r; break; }
        if (r == 0) break;
        int m = 0;
        rc = dc_matches(val, vlen, filter, filter_len, &m);
        if (rc) break;
        if (m) {
            *found = 1;
            rc = dup_bytes(val, vlen, out, out_len);
            break;
        }
    }
    bpt_cursor_close(cur_h);
    return rc;
}

int dc_find(dc_collection *c, const uint8_t *filter, uint32_t filter_len,
            uint8_t **out, size_t *out_len) {
    *out = NULL; *out_len = 0;
    bj_builder *b = bj_builder_new();
    if (!b) return BJ_ERR_OOM;

    int e = bj_begin_array(b);
    bpt_cursor *cur_h = NULL;
    if (!e) {
        cur_h = bpt_cursor_open(c->primary, NULL, NULL);
        if (!cur_h) e = BJ_ERR_OOM;
    }
    while (!e && cur_h) {
        bpt_key k; const uint8_t *val; size_t vlen;
        int r = bpt_cursor_next(cur_h, &k, &val, &vlen);
        if (r < 0) { e = r; break; }
        if (r == 0) break;
        int m = 0;
        e = dc_matches(val, vlen, filter, filter_len, &m);
        if (e) break;
        if (m) e = bj_put_raw(b, val, (uint32_t)vlen);
    }
    if (cur_h) bpt_cursor_close(cur_h);
    if (!e) e = bj_end_array(b);

    if (!e) {
        size_t n; const uint8_t *p = bj_builder_data(b, &n);
        if (!p) e = bj_builder_error(b) ? bj_builder_error(b) : BJ_ERR_STATE;
        else e = dup_bytes(p, n, out, out_len);
    }
    bj_builder_free(b);
    return e;
}

int dc_delete_one(dc_collection *c, const uint8_t *filter, uint32_t filter_len, int *deleted) {
    *deleted = 0;
    int found = 0; uint8_t *doc = NULL; size_t doc_len = 0;
    int e = dc_find_one(c, filter, filter_len, &found, &doc, &doc_len);
    if (e) { free(doc); return e; }
    if (!found) { free(doc); return BJ_OK; }

    uint8_t id[12];
    e = dc_get_id(doc, (uint32_t)doc_len, id);
    if (!e) e = remove_from_indexes(c, doc, doc_len, id);
    if (e) { free(doc); return e; }

    bpt_key key; oid_key(id, &key);
    e = bpt_delete(c->primary, &key);
    free(doc);
    if (e) return e;
    *deleted = 1;
    return BJ_OK;
}

/* Encode `replacement` with its top-level _id forced to `id` (replacing any
 * _id field it carries, or adding one if it has none); every other field's
 * bytes are spliced verbatim (bj_put_raw) rather than decoded/re-encoded. */
static int splice_id(const uint8_t *replacement, size_t replacement_len,
                     const uint8_t id[12], uint8_t **out, size_t *out_len) {
    cur c = { replacement, replacement_len, 0 };
    uint32_t count;
    int e = object_begin(&c, &count);
    if (e) return e;

    bj_builder *b = bj_builder_new();
    if (!b) return BJ_ERR_OOM;
    e = bj_begin_object(b);
    if (!e) e = bj_put_key(b, (const uint8_t *)"_id", 3);
    if (!e) e = bj_put_oid(b, id);
    for (uint32_t i = 0; !e && i < count; i++) {
        const uint8_t *kp; uint32_t klen;
        e = take_key(&c, &kp, &klen);
        if (e) break;
        size_t vstart = c.pos;
        e = skip_value(&c);
        if (e) break;
        if (klen == 3 && memcmp(kp, "_id", 3) == 0) continue;
        e = bj_put_key(b, kp, klen);
        if (!e) e = bj_put_raw(b, c.d + vstart, (uint32_t)(c.pos - vstart));
    }
    if (!e) e = bj_end_object(b);
    if (!e) {
        size_t n; const uint8_t *p = bj_builder_data(b, &n);
        if (!p) e = bj_builder_error(b) ? bj_builder_error(b) : BJ_ERR_STATE;
        else e = dup_bytes(p, n, out, out_len);
    }
    bj_builder_free(b);
    return e;
}

int dc_replace_one(dc_collection *c, const uint8_t *filter, uint32_t filter_len,
                   const uint8_t *replacement, uint32_t replacement_len,
                   const uint8_t default_id[12], int upsert, int *result) {
    *result = 0;

    uint8_t repl_id[12]; int repl_has_id;
    {
        const uint8_t *vp; size_t vlen; int found;
        int e = obj_get_field(replacement, replacement_len,
                              (const uint8_t *)"_id", 3, &vp, &vlen, &found);
        if (e) return e;
        if (found) {
            if (vlen != 13 || vp[0] != BJ_TYPE_OID) return BJ_ERR_STATE;
            memcpy(repl_id, vp + 1, 12);
        }
        repl_has_id = found;
    }

    int found = 0; uint8_t *doc = NULL; size_t doc_len = 0;
    int e = dc_find_one(c, filter, filter_len, &found, &doc, &doc_len);
    if (e) { free(doc); return e; }

    if (!found) {
        free(doc);
        if (!upsert) return BJ_OK;
        const uint8_t *use_id = repl_has_id ? repl_id : default_id;
        uint8_t *spliced; size_t spliced_len;
        e = splice_id(replacement, replacement_len, use_id, &spliced, &spliced_len);
        if (e) return e;
        e = dc_insert_one(c, spliced, (uint32_t)spliced_len);
        free(spliced);
        if (e) return e;
        *result = 2;
        return BJ_OK;
    }

    uint8_t existing_id[12];
    e = dc_get_id(doc, (uint32_t)doc_len, existing_id);
    if (e) { free(doc); return e; }

    if (repl_has_id && memcmp(repl_id, existing_id, 12) != 0) {
        free(doc);
        return DC_ERR_ID_MISMATCH;
    }

    uint8_t *spliced; size_t spliced_len;
    e = splice_id(replacement, replacement_len, existing_id, &spliced, &spliced_len);
    if (e) { free(doc); return e; }

    e = remove_from_indexes(c, doc, doc_len, existing_id);
    free(doc);
    if (e) { free(spliced); return e; }

    bpt_key key; oid_key(existing_id, &key);
    e = bpt_add(c->primary, &key, spliced, (uint32_t)spliced_len);
    if (!e) e = add_to_indexes(c, spliced, (uint32_t)spliced_len, existing_id);
    free(spliced);
    if (e) return e;
    *result = 1;
    return BJ_OK;
}

int dc_count(dc_collection *c, const uint8_t *filter, uint32_t filter_len, int64_t *out_count) {
    cur cu = { filter, filter_len, 0 };
    uint32_t fcount;
    int e = object_begin(&cu, &fcount);
    if (e) return e;
    if (fcount == 0) { *out_count = bpt_size(c->primary); return BJ_OK; }

    bpt_cursor *cur_h = bpt_cursor_open(c->primary, NULL, NULL);
    if (!cur_h) return BJ_ERR_OOM;
    int64_t n = 0;
    int rc = BJ_OK;
    for (;;) {
        bpt_key k; const uint8_t *val; size_t vlen;
        int r = bpt_cursor_next(cur_h, &k, &val, &vlen);
        if (r < 0) { rc = r; break; }
        if (r == 0) break;
        int m = 0;
        rc = dc_matches(val, vlen, filter, filter_len, &m);
        if (rc) break;
        if (m) n++;
    }
    bpt_cursor_close(cur_h);
    if (rc) return rc;
    *out_count = n;
    return BJ_OK;
}
