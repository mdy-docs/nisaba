/*
 * regex.h — a small backtracking regex engine for db_query.c's `$regex`
 * operator.
 *
 * Supported syntax:
 *   - literal bytes
 *   - `.`                any byte
 *   - `\d \D \w \W \s \S` ASCII shorthand classes (d = 0-9; w = A-Za-z0-9_;
 *     s = space/tab/newline/CR/FF/VT) -- not Unicode-aware
 *   - `\. \* \+ \? \( \) \[ \] \{ \} \| \^ \$ \\` escaped metacharacters
 *   - `[...]` / `[^...]`  character classes, with `a-z` ranges and the
 *     shorthand classes above usable inside
 *   - `*` `+` `?`         greedy quantifiers on the preceding atom
 *   - `{n}` `{n,}` `{n,m}` greedy bounded repetition
 *   - `^` `$`             anchors (whole-subject only, no multiline mode)
 *   - `(...)`             grouping (scopes a quantifier/alternation; no
 *     capture -- matching is boolean only, which is all `$regex` needs)
 *   - `|`                 alternation
 *
 * Deliberately not supported (a malformed/unrecognized construct is a
 * parse error, never silently misinterpreted): non-greedy quantifiers
 * (`*?` etc.), backreferences, lookahead/lookbehind, named/capturing
 * groups, POSIX classes (`[[:alpha:]]`), and Unicode-aware classes --
 * matching is byte-oriented, so a multi-byte UTF-8 character is matched by
 * `.`/a class one byte at a time (the same documented limitation
 * textindex.c's own ASCII-oriented tokenizer already carries). Only the
 * `i` (case-insensitive) match option exists at the db_query.c layer; `m`/
 * `s`/`x`/`u` are not implemented there.
 *
 * Implementation: a recursive-descent parser compiles the pattern directly
 * to a flat backtracking-VM instruction array (Russ Cox's "Regular
 * Expression Matching Can Be Simple And Fast," the backtracking variant --
 * not a Thompson-NFA construction), then a small recursive interpreter
 * walks it. No compiled-pattern lifetime is exposed: rx_match compiles,
 * matches, and frees within one call, matching db_query.c's existing
 * no-cross-document-caching design (a filter's bytes are re-walked from
 * scratch per document already; re-parsing a small pattern per document is
 * an accepted cost, not a new one).
 */
#ifndef REGEX_H
#define REGEX_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Search `subject` (subject_len bytes) for `pattern` (pattern_len bytes)
 * anywhere within it (not anchored, unless the pattern itself starts with
 * `^`). `ignorecase` applies the `i` flag. Writes 1/0 through *out_matches
 * on success (BJ_OK); returns a negative BJ_ERR_* (BJ_ERR_STATE) if
 * `pattern` doesn't parse as valid syntax per this header's scope.
 */
int rx_match(const char *pattern, int pattern_len, int ignorecase,
             const char *subject, int subject_len, int *out_matches);

#ifdef __cplusplus
}
#endif

#endif /* REGEX_H */
