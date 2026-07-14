/*
 * db_keyenc.c — see db_keyenc.h.
 */
#include "db_keyenc.h"
#include "bjcursor.h"

#include <string.h>

int qk_put_value(dbuf *out, const uint8_t *value, size_t value_len) {
    if (value_len < 1) return BJ_ERR_EOF;
    uint8_t type = value[0];

    if (type == BJ_TYPE_INT || type == BJ_TYPE_FLOAT) {
        cur c = { value, value_len, 0 };
        double d;
        int e = read_number(&c, &d);
        if (e) return e;
        if (isnan(d)) return BJ_ERR_STATE; /* NaN has no ordering */
        if (d == 0) d = 0; /* normalize -0 to +0 so they encode equal */

        uint64_t bits;
        memcpy(&bits, &d, 8);
        uint8_t enc[9];
        enc[0] = 0x00;
        for (int i = 0; i < 8; i++) enc[1 + i] = (uint8_t)(bits >> (8 * (7 - i)));
        /* Total-order transform: flip the sign bit for positives, all bits
         * for negatives, so unsigned byte order matches numeric order. */
        if (enc[1] & 0x80) { for (int i = 1; i < 9; i++) enc[i] ^= 0xff; }
        else enc[1] ^= 0x80;
        return dbuf_put(out, enc, 9);
    }

    if (type == BJ_TYPE_DATE) {
        if (value_len != 9) return BJ_ERR_STATE;
        uint64_t bits = rdu64(value + 1); /* raw LE bytes = int64 millis-since-epoch, per bj_put_date */
        uint8_t enc[9];
        enc[0] = 0x03;
        for (int i = 0; i < 8; i++) enc[1 + i] = (uint8_t)(bits >> (8 * (7 - i)));
        /* Same signed-integer total-order transform as the number case
         * above, applied to the raw int64 millis rather than an IEEE-754
         * bit pattern: flipping just the sign bit converts two's-
         * complement ordering into unsigned byte-order comparison. */
        enc[1] ^= 0x80;
        return dbuf_put(out, enc, 9);
    }

    if (type == BJ_TYPE_STRING) {
        cur c = { value, value_len, 0 };
        const uint8_t *sp; uint32_t slen;
        int e = take_string(&c, &sp, &slen);
        if (e) return e;
        for (uint32_t i = 0; i < slen; i++) {
            if (sp[i] == 0) return BJ_ERR_STATE; /* reserved as the terminator */
        }
        uint8_t tag = 0x01;
        e = dbuf_put(out, &tag, 1);
        if (e) return e;
        e = dbuf_put(out, sp, slen);
        if (e) return e;
        uint8_t term = 0x00;
        return dbuf_put(out, &term, 1);
    }

    return BJ_ERR_STATE; /* unsupported type for an ordered key part */
}

int qk_put_id(dbuf *out, const uint8_t id[12]) {
    uint8_t tag = 0x02;
    int e = dbuf_put(out, &tag, 1);
    if (e) return e;
    return dbuf_put(out, id, 12);
}

int qk_put_upper_bound(dbuf *out) {
    uint8_t sentinel = 0xff;
    return dbuf_put(out, &sentinel, 1);
}
