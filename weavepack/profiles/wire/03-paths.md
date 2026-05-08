# weavepack-wire — 03: Paths

**Status:** Draft. Phase W of the weavepack v0.3 roadmap.

## Scope

This document specifies the **path grammar** of weavepack-wire. Paths
identify fields within a message for delta operations — which field to
set, which map entry to modify, which repeated-field index to update.

## Grammar

```
path             = field-path
                 | map-path
                 | repeated-path
                 | "" (empty path = root message)

field-path       = field-ref ("." field-ref)*
                 ; dot-separated chain for nested messages

field-ref        = field-number | field-name
field-number     = digit+
                 ; uint32 field number (schema-independent)
field-name       = identifier
                 ; schema-declared name (requires schema)
identifier       = [A-Za-z_][A-Za-z0-9_]*

map-path         = field-path "{" map-key "}"
map-key          = string-key | uint32-key
string-key       = '"' utf8-chars '"'
uint32-key       = digit+

repeated-path    = field-path "[" index "]"
index            = digit+
                 ; zero-based element index
```

## Examples

| Path | Refers to |
|---|---|
| `""` | The root message |
| `[1]` | Field number 1 of the root message |
| `.name` | Field named "name" (schema required) |
| `[2][0]` | Index 0 of the repeated field number 2 |
| `[3]{"user_id_123"}` | Map entry with string key "user_id_123" in field 3 |
| `[3]{42}` | Map entry with uint32 key 42 in field 3 |
| `.payload.header.version` | Nested path using field names (schema required) |
| `[5][3].title` | Field "title" of the 4th element of repeated message field 5 |
| `[7]` | The active oneof case in field 7's oneof group |

## Addressing by field number vs field name

Field numbers are the canonical on-wire identity. Field names are
schema-layer aliases.

In paths:

- **Schemaless mode**: field-name paths are forbidden. Only
  field-number paths are valid.
- **Schemaful mode**: either form is valid. The encoder converts
  field-name paths to field-number paths before emitting them on the
  wire. A decoder receiving a field-number path can resolve names from
  the schema for human-readable display.

A path MAY mix field-number and field-name components. The encoder
resolves each component via the schema before encoding.

## Map key syntax

Map keys embedded in a path use brace notation:

- String keys: `{" ... "}` with the key string quoted. Quotes within
  the key string must be backslash-escaped: `{"say \"hello\""}`.
- uint32 keys: `{42}` with no quotes.

The key type (string vs uint32) MUST match the declared key type of the
map field. A mismatch causes encoder refusal (`map_key_type_mismatch`).

## Repeated field index addressing

A repeated field element is addressed by its zero-based index:
`field[0]` is the first element, `field[N-1]` is the last.

Negative indices (last-N shorthand) are NOT supported in v0.1. Use the
explicit positive index.

Out-of-range indices cause refusal during delta application
(`repeated_index_out_of_range`).

## oneof path

A oneof group is addressed by the oneof's field number. Since only one
case is active at a time, the path `[7]` refers to whatever case is
currently active in the oneof group with field number 7 in the schema.

To target a specific oneof case, include the case's own field number:
`[7].success_body` (schemaful) or `[7].[11]` (schemaless, where 11 is
the success_body field number). When a `field_set` or `message_replace`
targets a specific oneof case, it simultaneously activates that case
and deactivates any previously active case.

## Path encoding on the wire

Paths in delta operations are encoded as a compact binary form:

### Field path component

```
component type  : 2 bits
                  00 = field number
                  01 = map entry (key follows)
                  10 = repeated index
                  11 = end-of-path marker
if 00:
  field_number  : LEB128
if 01:
  key_type      : 1 bit (0 = string, 1 = uint32)
  if 0:           LEB128-length + UTF-8 bytes
  if 1:           LEB128 uint32
if 10:
  index         : LEB128
```

The path terminates when the end-of-path marker (11) is encountered.

### Empty path (root message)

An empty path is encoded as a single `11` end-of-path marker (2 bits).
This is used by the `message_replace` op when replacing the entire
root message.

### Canonical form

The encoder MUST emit the shortest valid path for a given target:

- Use field numbers in schemaless mode; either form is acceptable in
  schemaful mode (the encoder SHOULD prefer field numbers for
  compactness).
- No redundant trailing components.
- For a repeated-field element at index 0, emit `[0]`, not `[0][:]`.

Two decoders given the same path bytes MUST resolve to the same
position in the message tree.

## Path canonicalization

A schemaful encoder normalizes all paths before emission:

1. Resolve field names to field numbers.
2. Resolve string-keys and uint32-keys to their canonical form (no
   superfluous quoting, normalized Unicode for string keys).
3. Strip redundant trailing components (e.g., `[5][0:]` → `[5][0]`).

After normalization, byte-equal path encodings identify byte-equal
targets. This invariant is required for delta composition and
compaction.

## Path validation

During delta application, the decoder validates each path component:

1. `field_number` component: the field number MUST exist in the current
   message type's schema. If schemaless, it MUST have appeared in at
   least one prior payload for this message.
2. `map_entry` component: the map key type MUST match the field's
   declared key type. The key MAY be new (map_set adds it).
3. `repeated_index` component: the index MUST be within
   `[0, length)`. Exception: `repeated_append` uses index `length`
   (one past end) as a valid target.

Validation failures MUST cause refusal with the appropriate error class
(see `04-deltas.md` error classes).

## Conformance

A conforming decoder MUST:
- Parse all path component types (field, map, index, end)
- Validate field numbers, map key types, and index bounds
- Refuse on validation failure

A conforming encoder MUST:
- Emit canonical path encodings
- Resolve field names to numbers before emission

## Test vector references

Path grammar is exercised indirectly through the delta op test vectors
at `weavepack/profiles/wire/test-vectors/deltas/`. A dedicated
`test-vectors/paths/` directory may be populated in Stage W.3 if
path canonicalization proves to be a separately-testable concern.
