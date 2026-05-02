// JSON profile — type vocabulary manifest.
//
// This module declares the JSON-specific constants that other profiles
// would change. The core encoder/decoder/builder code currently uses
// inline numeric literals for these values; subsequent Phase 3 stages
// will replace those literals with imports from this manifest.
//
// See weavepack/profiles/json/01-types.md for the normative spec of
// each constant.

// ── vtype space (3 bits, 0..7) ──────────────────────────────────────────
//
// The vtypes column carries one 3-bit value per leaf, indicating the
// value's type and which value column carries its payload.
export const VTYPE = Object.freeze({
  UNDEFINED: 0,        // Internal marker; folds to null on decode
  NULL:      1,        // JSON null
  STR_B64:   2,        // String, base64url-eligible / strmap-ref / strdiff
  BOOL:      3,        // JSON true | false
  INT_POS:   4,        // Non-negative integer
  INT_NEG:   5,        // Negative integer
  FLOAT:     6,        // Number with decimal precision (or empty container)
  STR_FALL:  7,        // String, non-base64url (UTF-16 code units via LEB128)
})

export const VTYPE_BITS = 3

// ── ktype space (2 bits, 0..3) ──────────────────────────────────────────
//
// The ktypes column carries one 2-bit value per kref slot, indicating
// the key's container type and how the key is encoded.
export const KTYPE = Object.freeze({
  ARRAY_INDEX:    0,   // Array slot — key is positional integer
  OBJECT_NUMERIC: 1,   // Object slot — key resolved via strmap
  OBJECT_B64:     2,   // Object slot — key in kvals as 6-bit base64url
  OBJECT_FALL:    3,   // Object slot — key in kvals as LEB128 chars
})

export const KTYPE_BITS = 2

// ── Single-payload tag space (after the leading "1" mode bit + 1-bit
//    selector + 6-bit tag) ────────────────────────────────────────────────
//
// When the 1-bit selector is 1: the next 6 bits are a positive int (or
// 63 + leb128 remainder).
// When the 1-bit selector is 0: the next 6 bits select the type per
// this table.
export const SINGLE_TAG = Object.freeze({
  NULL:                  0,
  TRUE:                  1,
  FALSE:                 2,
  EMPTY_STRING:          3,
  EMPTY_ARRAY:           4,
  EMPTY_OBJECT:          5,
  INT_NEGATIVE:          6,    // followed by uint_dc(-v)
  FLOAT_POSITIVE:        7,    // followed by uint_dc(precision), uint_dc(mantissa)
  FLOAT_NEGATIVE:        8,    // followed by uint_dc(precision), uint_dc(mantissa)

  // Tags 9..60: single character A..Z, a..z (52 chars).
  // The actual character is recovered as strmap_alphabet[tag - 9].
  CHAR_RANGE_LO:         9,
  CHAR_RANGE_HI:        60,

  CHAR_NON_ALPHA:       61,    // Single char outside [A-Za-z]; followed by leb128 charcode
  STR_BASE64URL:        62,    // Multi-char base64url string
  STR_FALLBACK:         63,    // Multi-char non-base64url string
})

// ── Splice escape (vtype 0 + 0-count short() + 1-bit selector) ──────────
//
// When the splice selector is 1, the escape carries (index, remove, type3)
// describing an array splice. The type3 of 0 means splice-delete; otherwise
// type3 is the vtype of the inserted element.
export const SPLICE = Object.freeze({
  SELECTOR_DELETE: 0,          // Standalone delete
  SELECTOR_SPLICE: 1,          // Splice with metadata
  TYPE3_DELETE:    0,          // Splice-delete (no insertion)
})

// ── Bit thresholds (Level 3 conformance values) ─────────────────────────
//
// Encoders that target byte-exact reference parity MUST use these
// thresholds.
export const THRESHOLDS = Object.freeze({
  // Number magnitude precision cap (matches IEEE 754 binary64 effective
  // decimal digits). Numbers with more than this many fractional digits
  // are rounded.
  NUM_PRECISION_MAX: 308,

  // Run-length thresholds.
  VLINK_RUN_MIN: 4,            // Use RLE form when count >= 4 in vlinks
  KLINK_RUN_MIN: 4,            // Use RLE form when count >= 4 in klinks
  NUM_RUN_MIN:   3,            // Use RLE form when count >= 3 in nums

  // String diff thresholds.
  STRDIFF_MIN_LEN: 20,         // Both strings must have length >= this
  STRDIFF_MAX_RATIO: 0.6,      // Patch size < ratio * new string length
})

// ── strmap alphabet (52 chars, [A-Za-z]) ────────────────────────────────
//
// Used for single-char string tags 9..60 and as a subset of the
// base64url alphabet for deduplicated string keys/values.
export const STRMAP_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// ── base64url alphabet (64 chars, [A-Za-z0-9-_]) ────────────────────────
//
// Used for 6-bit-per-char string encoding when all chars fall in this
// alphabet.
export const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// ── Profile identity ─────────────────────────────────────────────────────
export const PROFILE_ID = "json"
export const PROFILE_VERSION = "1.1"
