# weavepack-wire — 02: Containers

**Status:** Draft. Phase W of the weavepack v0.3 roadmap.

## Scope

This document specifies the **container types** of weavepack-wire —
how scalar fields are grouped into messages, how sequences are expressed
as repeated fields, how key-value pairs are expressed as maps, and how
exclusive-choice fields are expressed as oneofs.

## Container type space (2 bits, 0..3)

| ctype | Name | Description |
|---|---|---|
| 0 | `message` | ordered set of field_number→value pairs |
| 1 | `repeated` | variable-length sequence of a single element type |
| 2 | `map` | key→value pairs (key: string or uint32) |
| 3 | `oneof` | exactly one field from a declared field set is present |

## message

A message is the root container (analogous to a protobuf message). It
holds zero or more fields, each identified by a field number and
carrying a value of a declared type.

### Field numbers

Field numbers are `uint32` values ≥ 1. They are the **canonical
identity** of a field in the wire format — names are a schema-layer
alias. Field numbers:

- MUST be unique within a single message type
- MAY be sparse (gaps between numbers are valid)
- SHOULD be small (1..2047 is the recommended range for single-LEB128
  encoding)

Field numbers ≥ 19000 and ≤ 19999 are reserved for use by the
weavepack implementation and MUST NOT be used by schema authors.

### Optional fields and presence

An **optional field** is absent from a payload if its value equals the
field's default (empty/zero). The encoder omits absent fields; the
decoder reconstructs them from the schema's declared default.

The field-number column lists only the field numbers present in a
given payload. A field whose number does not appear is absent.

Required fields (declared in schema) are ALWAYS emitted; their presence
is not a column entry. If a required field is absent from an encoded
message, the encoder MUST fail with `required_field_missing`.

### On-wire layout (schemaful, one message)

```
[field count]         LEB128: number of present fields
for each present field (ascending field_number order):
  [field_number]      LEB128
  [value]             encoded per type declaration
```

Fields are emitted in ascending field-number order. A decoder that
receives fields out of order MUST refuse with `field_order_violation`.

### On-wire layout (schemaless)

Without a schema, the encoder must include type information inline:

```
[field count]         LEB128: number of present fields
for each field:
  [field_number]      LEB128
  [vtype]             4 bits (scalar) or ctype marker (4 bits)
  [value]             encoded per vtype/ctype
```

Schemaless mode uses the wire envelope's extension gate to signal the
absence of a schema reference. The decoder infers types from the inline
vtype bits; field names remain unavailable.

## repeated

A repeated field is a variable-length sequence of values, all sharing
the same declared element type.

### Storage

For scalar element types, a repeated field stores:

```
[element count]       LEB128
[elements]            N × (element encoding per type)
```

The element count MAY be zero (empty sequence).

For message element types (a repeated sub-message):

```
[element count]       LEB128
for each element:
  [message payload]   as per message encoding above
```

### Packed encoding

For fixed-width scalar types (`bool`, `int32`, `uint32`, `float32`,
`float64`, `int64`, `uint64`), the encoder SHOULD use packed encoding:
all values in the repeated field are stored contiguously in the value
column without per-element type tags. This matches protobuf's packed
repeated field behavior.

Packed encoding is automatic for fixed-width scalars; the schema
declares the type once. The decoder, knowing the element type and count,
reads `count × bits_per_element` bits from the value column.

For variable-width scalars (`string`, `bytes`, `sint32`, `sint64`),
packed encoding is still used (each element's LEB128 length/value
follows the previous element immediately; no per-element tag).

### Length limit

A repeated field MAY contain up to 2^31 - 1 elements. Implementations
SHOULD refuse a `repeated_append` that would push the count beyond
their supported maximum.

## map

A map field holds a finite collection of key→value pairs. Keys are
either `string` or `uint32` (declared in schema).

### Storage

```
[entry count]         LEB128
for each entry (sorted by key, ascending):
  [key]               string: LEB128-length + UTF-8 bytes
                      uint32: LEB128
  [value]             encoded per declared value type
```

Map entries are stored in ascending key order (lexicographic for
strings, numeric for uint32). A decoder encountering out-of-order keys
MUST refuse with `map_key_order_violation`.

Key uniqueness: each key MUST appear at most once in a single map payload.
Duplicate keys MUST cause encoder refusal (`map_duplicate_key`).

An empty map (entry count = 0) is valid and equivalent to the map field
being absent. The encoder SHOULD omit the field number for an empty map.

### Nested message values

A map whose value type is a message stores each value as an inline
message payload (field count + fields). The value type tag is omitted
(known from schema).

## oneof

A oneof field declares a set of field numbers where at most one can be
present at a time. On the wire:

```
[selector field_number]   LEB128 (the active case's field number)
[value]                   encoded per the selected field's type
```

If no case is active, the selector field_number is 0. The decoder,
seeing field_number = 0, sets the oneof to the "unset" state.

Field numbers in a oneof set share the enclosing message's field-number
space. A field number MUST NOT appear in more than one oneof, and a
oneof member field_number MUST NOT also appear as a regular field.

## Nesting

Messages may nest up to 64 levels deep. A decoder MUST refuse with
`nesting_depth_exceeded` beyond this limit to prevent stack-overflow
attacks.

Repeated fields of messages, maps of messages, and oneof cases that
are messages all count toward the nesting depth.

## Column layout in the wire envelope

weavepack-wire uses the core column structure partially:

| Column | Used? | Purpose |
|---|---|---|
| `dc` | Yes | mode bit, extension gate |
| `vrefs` / `vlinks` | Yes | field-number index for each present field |
| `krefs` / `klinks` | Yes | nesting structure (message boundaries) |
| `vflags` | Partial | presence bits for optional fields |
| `kflags` | No | (field ordering is implied by vrefs) |
| `vtypes` | Yes | per-field vtype (schemaless only) |
| `ktypes` | Yes | container type per field number |
| `bools` | Yes | all bool fields packed together |
| `nums` | Yes | all fixed-width numeric fields |
| `vals` | Yes | variable-width values (strings, bytes, enums) |
| `strmap` | Yes | repeated string values dedup |
| `strdiffs` | No | (string delta is at the message level) |

Like the tensor profile, wire uses the core's bit-pack primitives and
wire envelope but bypasses some columns that don't fit its structure.

## Schema vs schemaless summary

| Feature | Schemaful | Schemaless |
|---|---|---|
| Field names | Available | Unavailable |
| Type information | From schema (omitted in payload) | Inline vtype per field |
| Presence column | Yes | Yes |
| Field ordering | By number, ascending | By number, ascending |
| Size | Smaller (no inline types) | Larger (inline types) |
| Random-access sub-message | Yes | No (sequential scan) |

## Conformance

A Level 1 decoder MUST:
- Parse message, repeated, map, and oneof containers
- Handle both schemaful and schemaless modes
- Enforce field-number ascending order within messages
- Enforce map-key ascending order within maps
- Enforce nesting depth limit (64)
- Refuse on required-field absence, field-order violation, map-key-order
  violation, map-duplicate-key, nesting-depth-exceeded

A Level 2 encoder MUST:
- Emit fields in ascending field-number order
- Emit map entries in ascending key order
- Omit absent optional fields
- Refuse on required-field absence

A Level 3 encoder MUST byte-match the reference for the same input
message + schema.

## Test vector references

Conformance test vectors live at
`weavepack/profiles/wire/test-vectors/containers/`:

- `messages.json` — nested messages, required/optional fields
- `repeated.json` — empty, single, multi-element repeated fields
- `maps.json` — string keys, uint32 keys
- `oneofs.json` — oneof switch between cases

(Populated in Stage W.3.)
