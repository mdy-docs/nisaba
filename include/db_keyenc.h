/*
 * db_keyenc.h — order-preserving byte encoding for B+ tree composite/secondary-
 * index keys. C port of orderedKey/compositeKey/compositeUpperBound in
 * src/binjson-wasm.js; see bplustree.h's key-convention note for the
 * rationale: the tree is unique-key, so a secondary index encodes the
 * indexed value(s) followed by the primary key into one composite byte
 * string and scans a contiguous range for a given value.
 *
 * Only binjson INT/FLOAT (one "number" domain, matching how JS treats every
 * number uniformly) and STRING values have an order-preserving encoding
 * here — the same scope as the JS primitive being ported. Any other type
 * (including a document missing the field) is BJ_ERR_STATE; extending the
 * domain (OID, Date, a full BSON-like total order across types, sparse
 * indexes for missing fields) is future work, not this port.
 *
 * Wire shape of one encoded key, built by calling qk_put_value once per
 * indexed field (in index order) followed by exactly one qk_put_id:
 *   - number: 0x00 tag + 8-byte sign-normalized big-endian IEEE-754 double
 *   - string: 0x01 tag + UTF-8 bytes + a 0x00 terminator (so a string part
 *     must not itself contain U+0000)
 *   - id suffix: 0x02 tag + the 12 raw ObjectId bytes verbatim
 * Every part's tag byte is < 0xff and every part is self-delimiting, so
 * parts concatenate unambiguously and qk_put_upper_bound's single 0xff
 * sentinel is guaranteed to sort after every real key sharing the same
 * value prefix, regardless of what bytes follow (in particular, regardless
 * of the arbitrary bytes of a following id suffix).
 *
 * The 0x02 id-tag is a new addition beyond the ported JS functions (which
 * never encode a primary-key suffix themselves, only document the
 * convention) — untagged raw id bytes would occasionally corrupt range-scan
 * upper bounds, since an id's first byte can itself be 0xff.
 */
#ifndef DB_KEYENC_H
#define DB_KEYENC_H

#include <stdint.h>
#include <stddef.h>

#include "binjson.h"
#include "dbuf.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Append the order-preserving encoding of one binjson-encoded scalar value
 * (`value`/`value_len` spans exactly one type byte + payload, e.g. as
 * produced by bjcursor.h's skip_value) to `out`. BJ_ERR_STATE if `value`
 * isn't BJ_TYPE_INT/BJ_TYPE_FLOAT/BJ_TYPE_STRING, is NaN, or is a string
 * containing U+0000.
 */
int qk_put_value(dbuf *out, const uint8_t *value, size_t value_len);

/* Append the id-suffix encoding of a 12-byte ObjectId (always the last part
 * of a composite key — the tree's row reference). */
int qk_put_id(dbuf *out, const uint8_t id[12]);

/*
 * Append the exclusive upper-bound sentinel (0xff) for range-scanning every
 * composite key sharing the value parts already written to `out`. Call this
 * on a copy of the value-parts-only prefix (i.e. before any qk_put_id), not
 * on a buffer that already has an id suffix appended.
 */
int qk_put_upper_bound(dbuf *out);

#ifdef __cplusplus
}
#endif

#endif /* DB_KEYENC_H */
