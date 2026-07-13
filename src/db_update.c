/*
 * db_update.c — see db_update.h.
 */
#include "db_update.h"
#include "bjcursor.h"
#include "dbuf.h"

#include <stdlib.h>
#include <string.h>

#define UPD_MAX_FIELDS 128

typedef enum { UPD_SET, UPD_UNSET, UPD_INC, UPD_PUSH, UPD_PULL } upd_kind;

typedef struct {
    const uint8_t *name; uint32_t name_len;
    upd_kind kind;
    const uint8_t *operand; size_t operand_len;
} pending_op;

/* Parse `update`'s operators into a flat (field, kind, operand) list. */
static int parse_update(const uint8_t *update, size_t update_len,
                        pending_op *ops, uint32_t max_ops, uint32_t *out_count) {
    cur c = { update, update_len, 0 };
    uint32_t opcount;
    int e = object_begin(&c, &opcount);
    if (e) return e;
    if (opcount == 0) return BJ_ERR_STATE;

    uint32_t n = 0;
    for (uint32_t i = 0; i < opcount; i++) {
        const uint8_t *kp; uint32_t klen;
        e = take_key(&c, &kp, &klen);
        if (e) return e;
        size_t vstart = c.pos;
        e = skip_value(&c);
        if (e) return e;

        upd_kind kind;
        if (klen == 4 && memcmp(kp, "$set", 4) == 0) kind = UPD_SET;
        else if (klen == 6 && memcmp(kp, "$unset", 6) == 0) kind = UPD_UNSET;
        else if (klen == 4 && memcmp(kp, "$inc", 4) == 0) kind = UPD_INC;
        else if (klen == 5 && memcmp(kp, "$push", 5) == 0) kind = UPD_PUSH;
        else if (klen == 5 && memcmp(kp, "$pull", 5) == 0) kind = UPD_PULL;
        else return BJ_ERR_STATE; /* unrecognized operator, or a plain field
                                    (a replacement document) -- use
                                    replaceOne for a full replacement. */

        const uint8_t *opval = c.d + vstart;
        size_t opval_len = c.pos - vstart;
        if (opval_len < 1 || opval[0] != BJ_TYPE_OBJECT) return BJ_ERR_STATE;

        cur fc = { opval, opval_len, 0 };
        uint32_t fcount;
        e = object_begin(&fc, &fcount);
        if (e) return e;
        for (uint32_t j = 0; j < fcount; j++) {
            const uint8_t *fkp; uint32_t fklen;
            e = take_key(&fc, &fkp, &fklen);
            if (e) return e;
            size_t fvstart = fc.pos;
            e = skip_value(&fc);
            if (e) return e;

            if (fklen == 3 && memcmp(fkp, "_id", 3) == 0) return BJ_ERR_STATE;
            for (uint32_t k = 0; k < fklen; k++) {
                /* No dotted paths yet -- reject rather than treat "a.b" as
                 * a literal top-level field name (see db_update.h). */
                if (fkp[k] == '.') return BJ_ERR_STATE;
            }
            for (uint32_t k = 0; k < n; k++) {
                if (ops[k].name_len == fklen && memcmp(ops[k].name, fkp, fklen) == 0) {
                    return BJ_ERR_STATE; /* field targeted by more than one operator */
                }
            }
            if (n >= max_ops) return BJ_ERR_STATE;
            ops[n].name = fkp; ops[n].name_len = fklen;
            ops[n].kind = kind;
            ops[n].operand = fc.d + fvstart; ops[n].operand_len = fc.pos - fvstart;
            n++;
        }
    }
    *out_count = n;
    return BJ_OK;
}

int upd_validate(const uint8_t *update, size_t update_len) {
    pending_op ops[UPD_MAX_FIELDS];
    uint32_t n = 0;
    return parse_update(update, update_len, ops, UPD_MAX_FIELDS, &n);
}

/* cur_val/cur_val_len: NULL/0 if the field doesn't exist yet (treated as
 * 0). BJ_ERR_STATE if a present cur_val or the operand isn't a number. */
static int emit_incremented(bj_builder *b, const uint8_t *cur_val, size_t cur_val_len,
                            const uint8_t *operand, size_t operand_len) {
    double base = 0;
    if (cur_val) {
        if (cur_val_len < 1 || (cur_val[0] != BJ_TYPE_INT && cur_val[0] != BJ_TYPE_FLOAT)) return BJ_ERR_STATE;
        cur c = { cur_val, cur_val_len, 0 };
        int e = read_number(&c, &base);
        if (e) return e;
    }
    if (operand_len < 1 || (operand[0] != BJ_TYPE_INT && operand[0] != BJ_TYPE_FLOAT)) return BJ_ERR_STATE;
    cur oc = { operand, operand_len, 0 };
    double delta;
    int e = read_number(&oc, &delta);
    if (e) return e;

    double sum = base + delta;
    if (is_safe_int(sum)) return bj_put_int(b, (int64_t)sum);
    return bj_put_float(b, sum);
}

/* cur_val/cur_val_len: NULL/0 if the field doesn't exist yet (a fresh
 * single-element array is created). BJ_ERR_STATE if a present cur_val
 * isn't an ARRAY. */
static int emit_pushed(bj_builder *b, const uint8_t *cur_val, size_t cur_val_len,
                       const uint8_t *operand, size_t operand_len) {
    int e = bj_begin_array(b);
    if (e) return e;
    if (cur_val) {
        if (cur_val_len < 1 || cur_val[0] != BJ_TYPE_ARRAY) return BJ_ERR_STATE;
        cur c = { cur_val, cur_val_len, 0 };
        uint32_t count;
        e = array_begin(&c, &count);
        if (e) return e;
        for (uint32_t i = 0; i < count; i++) {
            size_t vstart = c.pos;
            e = skip_value(&c);
            if (e) return e;
            e = bj_put_raw(b, c.d + vstart, (uint32_t)(c.pos - vstart));
            if (e) return e;
        }
    }
    e = bj_put_raw(b, operand, (uint32_t)operand_len);
    if (e) return e;
    return bj_end_array(b);
}

/* cur_val must be a present ARRAY (upd_apply only calls this when the field
 * exists; $pull on a missing field is a no-op handled by the caller).
 * Removes every element byte-equal to `operand`. */
static int emit_pulled(bj_builder *b, const uint8_t *cur_val, size_t cur_val_len,
                       const uint8_t *operand, size_t operand_len) {
    if (cur_val_len < 1 || cur_val[0] != BJ_TYPE_ARRAY) return BJ_ERR_STATE;
    cur c = { cur_val, cur_val_len, 0 };
    uint32_t count;
    int e = array_begin(&c, &count);
    if (e) return e;
    e = bj_begin_array(b);
    if (e) return e;
    for (uint32_t i = 0; i < count; i++) {
        size_t vstart = c.pos;
        e = skip_value(&c);
        if (e) return e;
        size_t vlen = c.pos - vstart;
        if (vlen == operand_len && (vlen == 0 || memcmp(c.d + vstart, operand, vlen) == 0)) continue;
        e = bj_put_raw(b, c.d + vstart, (uint32_t)vlen);
        if (e) return e;
    }
    return bj_end_array(b);
}

int upd_apply(const uint8_t *doc, size_t doc_len,
             const uint8_t *update, size_t update_len,
             uint8_t **out, size_t *out_len) {
    *out = NULL; *out_len = 0;

    pending_op ops[UPD_MAX_FIELDS];
    uint32_t nops = 0;
    int e = parse_update(update, update_len, ops, UPD_MAX_FIELDS, &nops);
    if (e) return e;

    uint8_t applied[UPD_MAX_FIELDS];
    memset(applied, 0, sizeof(applied));

    bj_builder *b = bj_builder_new();
    if (!b) return BJ_ERR_OOM;
    e = bj_begin_object(b);

    cur c = { doc, doc_len, 0 };
    uint32_t count;
    if (!e) e = object_begin(&c, &count);
    for (uint32_t i = 0; !e && i < count; i++) {
        const uint8_t *kp; uint32_t klen;
        e = take_key(&c, &kp, &klen);
        if (e) break;
        size_t vstart = c.pos;
        e = skip_value(&c);
        if (e) break;
        const uint8_t *cur_val = c.d + vstart;
        size_t cur_val_len = c.pos - vstart;

        int op_index = -1;
        for (uint32_t k = 0; k < nops; k++) {
            if (ops[k].name_len == klen && memcmp(ops[k].name, kp, klen) == 0) { op_index = (int)k; break; }
        }
        if (op_index < 0) {
            e = bj_put_key(b, kp, klen);
            if (!e) e = bj_put_raw(b, cur_val, (uint32_t)cur_val_len);
            continue;
        }

        applied[op_index] = 1;
        const pending_op *op = &ops[op_index];
        if (op->kind == UPD_UNSET) continue; /* drop the field */

        e = bj_put_key(b, kp, klen);
        if (e) break;
        if (op->kind == UPD_SET) e = bj_put_raw(b, op->operand, (uint32_t)op->operand_len);
        else if (op->kind == UPD_INC) e = emit_incremented(b, cur_val, cur_val_len, op->operand, op->operand_len);
        else if (op->kind == UPD_PUSH) e = emit_pushed(b, cur_val, cur_val_len, op->operand, op->operand_len);
        else e = emit_pulled(b, cur_val, cur_val_len, op->operand, op->operand_len); /* UPD_PULL */
    }

    /* Fields the update targets that the document doesn't have yet. */
    for (uint32_t k = 0; !e && k < nops; k++) {
        if (applied[k]) continue;
        const pending_op *op = &ops[k];
        if (op->kind == UPD_UNSET || op->kind == UPD_PULL) continue; /* no-op on a missing field */
        e = bj_put_key(b, op->name, op->name_len);
        if (e) break;
        if (op->kind == UPD_SET) e = bj_put_raw(b, op->operand, (uint32_t)op->operand_len);
        else if (op->kind == UPD_INC) e = emit_incremented(b, NULL, 0, op->operand, op->operand_len);
        else e = emit_pushed(b, NULL, 0, op->operand, op->operand_len); /* UPD_PUSH */
    }

    if (!e) e = bj_end_object(b);
    if (!e) {
        size_t n; const uint8_t *p = bj_builder_data(b, &n);
        if (!p) e = bj_builder_error(b) ? bj_builder_error(b) : BJ_ERR_STATE;
        else e = dbuf_dup(p, n, out, out_len);
    }
    bj_builder_free(b);
    return e;
}
