# weavepack-core — 04: String Interning (strmap)

**Status:** Draft. Phase 2 of the weavepack roadmap.

## Scope

This document specifies the **string interning protocol** used by
weavepack to deduplicate repeated strings within a payload (and
across a delta chain). The strmap is profile-agnostic — every
profile that emits string-typed values uses this same protocol.

## Motivation

Structural data routinely contains repeated strings:

- Object keys repeated across siblings (e.g., a list of records
  with the same fields)
- Enum-like values (e.g., `"status": "active"` across many records)
- URLs, timestamps, identifiers

Self-describing formats (JSON, CBOR, MessagePack) emit each occurrence
in full. weavepack interns strings into a per-payload table and emits
1-bit references for repeats. This is the single largest source of
size win on schemaless workloads.

For schema-driven workloads, the schema can declare enum fields whose
values are dictionary-coded into small integers — see `06-schemas.md`.
The strmap remains useful for non-enum string fields.

## The strmap

The strmap is a **bidirectional table** mapping integer indices ↔
strings. It is built incrementally during encode and rebuilt during
decode:

```
strmap : { index: string }
str_rev: { string: index }
```

The first occurrence of a string is written **literally** to the
appropriate column (`vals` or `kvals`) and assigned the next available
index. Subsequent occurrences are written as **strmap references**
(1-bit flag + the index).

## Encoding rules

### First occurrence

When a string is encoded for the first time (within the current
payload's strmap context):

1. The encoder assigns the next index `i = strmap.size`
2. Inserts `(string, i)` into the strmap
3. Writes the string's literal representation to the appropriate
   column

For the JSON profile, the literal representation is:

- For `vals` column (string values): a `short(length)` length prefix
  followed by `length × 6` bits (base64url-eligible) or `length` ×
  LEB128 (fallback)
- For `kvals` column (string keys): the same character data, with
  the length encoded inside the `keys` column's ktype/length entry

### Subsequent occurrences

When a string appears again in the same payload:

1. The encoder looks up the index via `str_rev`
2. Writes a strmap reference (1-bit flag + the index) instead of
   the literal characters

For the JSON profile, the strmap reference appears in the `vals`
column as:

```
short(0)        ; length prefix of 0 signals "not literal"
1 bit           ; selector: 0 = strmap reference, 1 = strdiff
short(index)    ; the strmap index
```

For object keys (`kvals` column), the strmap reference is signaled
via ktype 2 with length=0 in the `keys` entry.

## Decoding rules

The decoder builds the strmap on the fly as it reads the columns:

1. The decoder maintains a counter `str_len` starting at 0 (or at
   the size of any inherited strmap from a chain).
2. When the decoder encounters a literal string, it inserts
   `(str_len, string)` into the strmap and increments `str_len`.
3. When the decoder encounters a strmap reference, it looks up
   the string by index and emits it.

After all columns are read, the strmap is the final dedup table.
The decoder MAY then **compact** the strmap by removing entries
whose strings are no longer referenced (e.g., after a delta that
replaces all occurrences of an old string).

## Strmap renumbering across deltas

When a delta is applied to a base ARTable, the resulting compacted
strmap may have a **different numeric index** for the same string.
This is by design: the strmap is renumbered to be densely packed
starting from 0 after each compact step.

The renumbering means strmap indices are NOT stable across deltas.
A reference to index 5 in `Delta_3` cannot be interpreted in
isolation; it MUST be resolved against the post-compact strmap of
`Delta_0..Delta_2`.

This is the cost of the dedup design. Random-access into a chain
requires either replaying from the start or caching post-compact
ARTables externally.

## Single-character optimization

For single-character strings drawn from `[A-Za-z]` (the strmap
alphabet), the encoder emits the character directly via a tag in
the `dc` column (single-payload mode) or via a 6-bit base64url index
in `kvals`/`vals`. No strmap entry is created for these — they are
inline and "free" (a 6-bit field).

The strmap alphabet `[A-Za-z]` is a strict subset of the base64url
alphabet `[A-Za-z0-9-_]` for this reason: single-char strings outside
`[A-Za-z]` (e.g., a single digit, or `_`) still go through the strmap
or get a special tag.

Profile-specific subsets MAY be defined for non-JSON profiles. For
example, a profile encoding chemical formulas might use a different
single-char alphabet. The core spec doesn't constrain this; profiles
declare their alphabets in their own docs.

## Strdiff: incremental string update

When a string in a structural slot changes from one delta to the
next, the encoder MAY emit a fast-diff patch instead of the full
new string. This is signaled in the `vals` column as:

```
short(0)        ; length prefix of 0 signals "not literal"
1 bit           ; selector = 1: strdiff (vs. 0 = strmap reference)
                ; (the patch itself is in the `strdiffs` column)
```

The patch format is in `03-bit-encoding.md` (strdiffs section).

The decoder, on encountering a strdiff signal, applies the patch
to the prior string value (looked up by the slot's prior content
in the base ARTable) to recover the new string.

The encoder's heuristic for emitting strdiff vs. full replace:

- Both prior and new strings MUST have length ≥ some threshold
- Patch size MUST be < some fraction of the new string length
- For the JSON profile: thresholds are 20 chars and 60% (see
  `profiles/json/04-deltas.md`)

Other profiles MAY use different thresholds or omit strdiff entirely.

## Hash-addressed strmap (optional)

For chains that share string content across many payloads, the
strmap MAY be **hash-addressed**: the strmap is stored separately
(e.g., as a sidecar or as a separate transaction in permanent
storage), and each payload references the strmap by a content hash.

The hash-addressing mechanism is profile-specific. The core spec
provides the infrastructure (extension gate; `07-extensions.md`),
but does not mandate a specific hash function or sidecar format.

For schemaful payloads, hash-addressed strmaps allow the strmap to
become an **enum dictionary** that is set up once and referenced by
many payloads, saving the per-payload strmap overhead entirely.

## Strmap size limits

There is no protocol-level limit on strmap size beyond the 2^32
limit on individual indices. Implementations MAY impose tighter
limits for memory budgeting; doing so is normative if documented.

For DoS resistance, decoders SHOULD bound the strmap size to a
reasonable maximum (e.g., 2^20 entries) and refuse payloads with
larger strmaps. This is documented per implementation.

## Conformance

A Level 3 encoder MUST use the same insertion order as the JS
reference (strings are interned in encode-walk order — first
occurrence in a depth-first traversal of the source value).

A Level 2 encoder MAY use a different insertion order; the resulting
payload will not be byte-equivalent to the reference output but
will decode to the same value.

A decoder MUST handle any insertion order it receives. The strmap
indices in the wire format are normative for the reader; they
unambiguously identify which strmap entry is referenced.
