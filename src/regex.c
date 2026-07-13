/*
 * regex.c — see regex.h.
 *
 * Compiles a pattern directly to a flat backtracking-VM instruction array
 * (Cox's backtracking construction: I_SPLIT tries its first branch as a
 * full recursive attempt of everything from there on, falling back to its
 * second branch only if that entire attempt fails) via a recursive-descent
 * parser. Each parse_* function returns its own self-contained `ibuf`
 * (instruction buffer) whose jump targets are relative to its own start;
 * a caller splices a child buffer into itself by copying its instructions
 * and adding the splice position to every jump target (simple relocation,
 * no in-place shifting of anything already emitted).
 */
#include "regex.h"
#include "binjson.h"

#include <stdlib.h>
#include <string.h>

/* ---- ASCII character predicates (no <ctype.h>, no locale surprises --
 * matches stemmer.c's own precedent of writing explicit ASCII checks). */
static int is_digit_byte(int c) { return c >= '0' && c <= '9'; }
static int is_word_byte(int c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || is_digit_byte(c) || c == '_';
}
static int is_space_byte(int c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}
static int to_lower_byte(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }
static int to_upper_byte(int c) { return (c >= 'a' && c <= 'z') ? c - 32 : c; }

/* ---- Instructions ------------------------------------------------------ */

typedef enum { I_CHAR, I_ANY, I_CLASS, I_BOL, I_EOL, I_JMP, I_SPLIT, I_MATCH } inst_op;

typedef struct {
    inst_op op;
    unsigned char c;             /* I_CHAR */
    unsigned char bits[32];      /* I_CLASS: 256-bit set */
    int negate;                  /* I_CLASS */
    int x, y;                    /* I_JMP: x = target; I_SPLIT: x/y = two targets */
} inst;

static void set_bit(unsigned char bits[32], int c) { bits[c >> 3] |= (unsigned char)(1u << (c & 7)); }
static int get_bit(const unsigned char bits[32], int c) { return (bits[c >> 3] >> (c & 7)) & 1; }

/* ---- Growable instruction buffer ---------------------------------------- */

typedef struct { inst *items; int count, cap; } ibuf;

static void ibuf_init(ibuf *b) { b->items = NULL; b->count = 0; b->cap = 0; }

static int ibuf_push(ibuf *b, inst in) {
    if (b->count == b->cap) {
        int ncap = b->cap ? b->cap * 2 : 16;
        inst *nb = (inst *)realloc(b->items, (size_t)ncap * sizeof(inst));
        if (!nb) return -1;
        b->items = nb; b->cap = ncap;
    }
    b->items[b->count] = in;
    return b->count++;
}

/* Copy src's instructions into dst, relocating jump targets by dst's
 * current length (src is left untouched -- caller frees it separately,
 * since some quantifiers splice the same atom more than once). */
static void ibuf_splice(ibuf *dst, const ibuf *src) {
    int base = dst->count;
    for (int i = 0; i < src->count; i++) {
        inst in = src->items[i];
        if (in.op == I_JMP) in.x += base;
        else if (in.op == I_SPLIT) { in.x += base; in.y += base; }
        ibuf_push(dst, in);
    }
}

static inst mk(inst_op op) { inst in; memset(&in, 0, sizeof(in)); in.op = op; return in; }

/* ---- Parser -------------------------------------------------------------- */

typedef struct {
    const char *p, *end;
    int error;
} rx_parser;

static int peek(const rx_parser *ps) { return ps->p < ps->end ? (unsigned char)*ps->p : '\0'; }
static int peek_at(const rx_parser *ps, int off) {
    return ps->p + off < ps->end ? (unsigned char)ps->p[off] : '\0';
}
static void advance(rx_parser *ps) { if (ps->p < ps->end) ps->p++; }

static ibuf parse_alt(rx_parser *ps);

static void or_in_shorthand(unsigned char bits[32], int e) {
    for (int c = 0; c < 256; c++) {
        int hit;
        switch (e) {
        case 'd': hit = is_digit_byte(c); break;
        case 'D': hit = !is_digit_byte(c); break;
        case 'w': hit = is_word_byte(c); break;
        case 'W': hit = !is_word_byte(c); break;
        case 's': hit = is_space_byte(c); break;
        case 'S': hit = !is_space_byte(c); break;
        default: hit = 0; break;
        }
        if (hit) set_bit(bits, c);
    }
}
static int is_shorthand(int e) { return e=='d'||e=='D'||e=='w'||e=='W'||e=='s'||e=='S'; }
/* NUL is never escapable (and must never reach strchr: searching for '\0'
 * would otherwise "find" the search string's own terminator). */
static int is_escapable_meta(int e) { return e != '\0' && strchr(".*+?()[]{}|^$\\-", e) != NULL; }

static ibuf parse_class(rx_parser *ps) {
    ibuf out; ibuf_init(&out);
    inst in = mk(I_CLASS);
    if (peek(ps) == '^') { in.negate = 1; advance(ps); }
    int first = 1;
    while (first || peek(ps) != ']') {
        if (peek(ps) == '\0') { ps->error = 1; return out; }
        first = 0;
        int c = peek(ps);
        if (c == '\\') {
            advance(ps);
            int e = peek(ps);
            if (e == '\0') { ps->error = 1; return out; }
            if (is_shorthand(e)) { advance(ps); or_in_shorthand(in.bits, e); continue; }
            if (is_escapable_meta(e)) { advance(ps); c = e; }
            else { ps->error = 1; return out; }
        } else {
            advance(ps);
        }
        if (peek(ps) == '-' && peek_at(ps, 1) != ']' && peek_at(ps, 1) != '\0') {
            advance(ps); /* consume '-' */
            int hi = peek(ps);
            if (hi == '\\') { ps->error = 1; return out; } /* escaped range endpoint: not supported */
            advance(ps);
            if (hi < c) { ps->error = 1; return out; }
            for (int ch = c; ch <= hi; ch++) set_bit(in.bits, ch);
        } else {
            set_bit(in.bits, c);
        }
    }
    advance(ps); /* consume ']' */
    ibuf_push(&out, in);
    return out;
}

static ibuf parse_atom(rx_parser *ps) {
    ibuf out; ibuf_init(&out);
    int c = peek(ps);
    if (c == '(') {
        advance(ps);
        ibuf inner = parse_alt(ps);
        if (ps->error) { free(inner.items); return out; }
        if (peek(ps) != ')') { ps->error = 1; free(inner.items); return out; }
        advance(ps);
        ibuf_splice(&out, &inner);
        free(inner.items);
        return out;
    }
    if (c == '^') { advance(ps); ibuf_push(&out, mk(I_BOL)); return out; }
    if (c == '$') { advance(ps); ibuf_push(&out, mk(I_EOL)); return out; }
    if (c == '.') { advance(ps); ibuf_push(&out, mk(I_ANY)); return out; }
    if (c == '[') { advance(ps); ibuf f = parse_class(ps); return f; }
    if (c == '\\') {
        advance(ps);
        int e = peek(ps);
        if (e == '\0') { ps->error = 1; return out; }
        advance(ps);
        if (is_shorthand(e)) {
            inst in = mk(I_CLASS);
            or_in_shorthand(in.bits, e);
            ibuf_push(&out, in);
        } else if (is_escapable_meta(e)) {
            inst in = mk(I_CHAR); in.c = (unsigned char)e;
            ibuf_push(&out, in);
        } else {
            ps->error = 1;
        }
        return out;
    }
    if (c == '\0' || c == '|' || c == ')') { ps->error = 1; return out; }
    if (c == '*' || c == '+' || c == '?') { ps->error = 1; return out; } /* nothing to quantify */
    advance(ps);
    { inst in = mk(I_CHAR); in.c = (unsigned char)c; ibuf_push(&out, in); }
    return out;
}

/* Build atom{min,max} (max < 0 means unbounded) into a fresh ibuf; does
 * not free/consume `atom` (some callers splice it more than once). */
static ibuf build_quantified(const ibuf *atom, int min, int max) {
    ibuf out; ibuf_init(&out);
    for (int i = 0; i < min; i++) ibuf_splice(&out, atom);
    if (max < 0) {
        int split_idx = ibuf_push(&out, mk(I_SPLIT));
        ibuf_splice(&out, atom);
        int jmp_idx = ibuf_push(&out, mk(I_JMP));
        out.items[jmp_idx].x = split_idx;
        out.items[split_idx].x = split_idx + 1;
        out.items[split_idx].y = out.count;
    } else {
        for (int i = min; i < max; i++) {
            int split_idx = ibuf_push(&out, mk(I_SPLIT));
            ibuf_splice(&out, atom);
            out.items[split_idx].x = split_idx + 1;
            out.items[split_idx].y = out.count;
        }
    }
    return out;
}

#define RX_MAX_REPEAT 1000

static ibuf parse_repeat(rx_parser *ps) {
    ibuf atom = parse_atom(ps);
    if (ps->error) return atom;
    int c = peek(ps);
    if (c == '*') { advance(ps); ibuf o = build_quantified(&atom, 0, -1); free(atom.items); return o; }
    if (c == '+') { advance(ps); ibuf o = build_quantified(&atom, 1, -1); free(atom.items); return o; }
    if (c == '?') { advance(ps); ibuf o = build_quantified(&atom, 0, 1); free(atom.items); return o; }
    if (c == '{') {
        rx_parser save = *ps;
        advance(ps);
        int min = 0; int have_min = 0;
        while (is_digit_byte(peek(ps))) { min = min * 10 + (peek(ps) - '0'); advance(ps); have_min = 1; if (min > RX_MAX_REPEAT) { ps->error = 1; break; } }
        int max = min, unbounded = 0;
        if (!ps->error && peek(ps) == ',') {
            advance(ps);
            if (is_digit_byte(peek(ps))) {
                max = 0;
                while (is_digit_byte(peek(ps))) { max = max * 10 + (peek(ps) - '0'); advance(ps); if (max > RX_MAX_REPEAT) { ps->error = 1; break; } }
            } else {
                unbounded = 1;
            }
        }
        if (!ps->error && have_min && peek(ps) == '}' && (unbounded || max >= min)) {
            advance(ps);
            ibuf o = build_quantified(&atom, min, unbounded ? -1 : max);
            free(atom.items);
            return o;
        }
        /* Doesn't parse as a bounded-repetition operator: not supported as
         * a literal '{' either (unlike some regex dialects) -- a hard
         * parse error, consistent with never silently misinterpreting. */
        *ps = save;
        ps->error = 1;
        return atom;
    }
    return atom;
}

static ibuf parse_concat(rx_parser *ps) {
    ibuf out; ibuf_init(&out);
    while (!ps->error && peek(ps) != '|' && peek(ps) != ')' && peek(ps) != '\0') {
        ibuf atom = parse_repeat(ps);
        if (ps->error) { free(atom.items); break; }
        ibuf_splice(&out, &atom);
        free(atom.items);
    }
    return out;
}

static ibuf parse_alt(rx_parser *ps) {
    ibuf *branches = NULL; int nbranches = 0, cap = 0;
    for (;;) {
        ibuf b = parse_concat(ps);
        if (ps->error) {
            free(b.items);
            for (int i = 0; i < nbranches; i++) free(branches[i].items);
            free(branches);
            ibuf empty; ibuf_init(&empty);
            return empty;
        }
        if (nbranches == cap) {
            cap = cap ? cap * 2 : 4;
            branches = (ibuf *)realloc(branches, (size_t)cap * sizeof(ibuf));
        }
        branches[nbranches++] = b;
        if (peek(ps) == '|') { advance(ps); continue; }
        break;
    }

    ibuf out; ibuf_init(&out);
    if (nbranches == 1) { out = branches[0]; free(branches); return out; }

    int *end_jmps = (int *)malloc(sizeof(int) * (size_t)nbranches);
    int n_end_jmps = 0;
    for (int i = 0; i < nbranches; i++) {
        if (i < nbranches - 1) {
            int split_idx = ibuf_push(&out, mk(I_SPLIT));
            out.items[split_idx].x = out.count;
            ibuf_splice(&out, &branches[i]);
            int jmp_idx = ibuf_push(&out, mk(I_JMP));
            end_jmps[n_end_jmps++] = jmp_idx;
            out.items[split_idx].y = out.count;
        } else {
            ibuf_splice(&out, &branches[i]);
        }
        free(branches[i].items);
    }
    for (int i = 0; i < n_end_jmps; i++) out.items[end_jmps[i]].x = out.count;
    free(end_jmps);
    free(branches);
    return out;
}

/* ---- VM ------------------------------------------------------------------ */

/*
 * Backtracking is implemented with an explicit heap-allocated stack of
 * (pc, sp) resume points rather than recursive calls: I_SPLIT's "try the
 * first branch, and if that whole path eventually fails, fall back to the
 * second" is what makes greedy quantifiers/alternation work, but an
 * unbounded quantifier's loop body pushes one resume point per repetition
 * -- recursing there (an earlier version of this file did) makes C-stack
 * depth scale with subject length, overflowing the ~1MB WASM stack on a
 * multi-KB field with nothing more exotic than `\w+`. An explicit stack is
 * bounded by the heap instead, and a LIFO (most-recently-pushed resumes
 * first) exactly replicates recursive depth-first order. RX_MAX_STEPS
 * separately caps total VM steps, not depth -- the guard against
 * pathologically slow (e.g. catastrophic-backtracking-shaped) patterns,
 * refusing loudly rather than hanging, matching BPT_MAX_DEPTH/RT_MAX_DEPTH's
 * existing "refuse past a generous bound" precedent elsewhere.
 */
#define RX_MAX_STEPS 2000000

static int char_eq(unsigned char a, unsigned char b, int ignorecase) {
    if (a == b) return 1;
    return ignorecase && to_lower_byte(a) == to_lower_byte(b);
}
static int class_match(const inst *in, unsigned char c, int ignorecase) {
    int hit = get_bit(in->bits, c);
    if (!hit && ignorecase) {
        int alt = (c >= 'a' && c <= 'z') ? to_upper_byte(c) : to_lower_byte(c);
        hit = get_bit(in->bits, (unsigned char)alt);
    }
    return in->negate ? !hit : hit;
}

typedef struct { int pc; const unsigned char *sp; } resume_point;

/* -1 = no match, 0 = matched, 1 = step budget exceeded (caller treats as an
 * error, not a silent non-match). */
static int vm_run(const inst *prog, const unsigned char *sp0,
                  const unsigned char *begin, const unsigned char *end,
                  int ignorecase, int *matched) {
    resume_point *stack = NULL;
    int count = 0, cap = 0;
    int pc = 0;
    const unsigned char *sp = sp0;
    int result = 1; /* pessimistic default in case of OOM below */
    long steps = 0;

    for (;;) {
        if (++steps > RX_MAX_STEPS) { result = 1; goto done; }
        const inst *in = &prog[pc];
        int fail = 0;
        switch (in->op) {
        case I_CHAR:
            if (sp >= end || !char_eq(*sp, in->c, ignorecase)) fail = 1;
            else { sp++; pc++; }
            break;
        case I_ANY:
            if (sp >= end) fail = 1;
            else { sp++; pc++; }
            break;
        case I_CLASS:
            if (sp >= end || !class_match(in, *sp, ignorecase)) fail = 1;
            else { sp++; pc++; }
            break;
        case I_BOL:
            if (sp != begin) fail = 1; else pc++;
            break;
        case I_EOL:
            if (sp != end) fail = 1; else pc++;
            break;
        case I_JMP:
            pc = in->x;
            break;
        case I_SPLIT:
            if (count == cap) {
                int ncap = cap ? cap * 2 : 64;
                resume_point *nb = (resume_point *)realloc(stack, (size_t)ncap * sizeof(resume_point));
                if (!nb) { result = 1; goto done; }
                stack = nb; cap = ncap;
            }
            stack[count].pc = in->y;
            stack[count].sp = sp;
            count++;
            pc = in->x;
            break;
        case I_MATCH:
            result = 0;
            *matched = 1;
            goto done;
        }
        if (fail) {
            if (count == 0) { result = 0; *matched = 0; goto done; }
            count--;
            pc = stack[count].pc;
            sp = stack[count].sp;
        }
    }
done:
    free(stack);
    return result;
}

int rx_match(const char *pattern, int pattern_len, int ignorecase,
             const char *subject, int subject_len, int *out_matches) {
    *out_matches = 0;
    rx_parser ps; ps.p = pattern; ps.end = pattern + pattern_len; ps.error = 0;
    ibuf prog = parse_alt(&ps);
    if (ps.error || ps.p != ps.end) { free(prog.items); return BJ_ERR_STATE; }
    ibuf_push(&prog, mk(I_MATCH));

    const unsigned char *begin = (const unsigned char *)subject;
    const unsigned char *end = begin + subject_len;
    int rc = BJ_OK;
    for (const unsigned char *sp = begin; sp <= end; sp++) {
        int matched = 0;
        int r = vm_run(prog.items, sp, begin, end, ignorecase, &matched);
        if (r) { rc = BJ_ERR_STATE; break; } /* OOM or step budget exceeded */
        if (matched) { *out_matches = 1; break; }
    }
    free(prog.items);
    return rc;
}
