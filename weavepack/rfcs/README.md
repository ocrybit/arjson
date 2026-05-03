# Weavepack RFCs

Protocol-change proposals follow the process documented in
`weavepack/governance/01-rfc-process.md`. This directory holds the
proposals themselves, numbered sequentially.

## Index

| # | Title | Status | Affects |
|---|---|---|---|
| 0001 | [fp16 and bf16 dtype support in weavepack-tensor](./0001-tensor-fp16-bf16.md) | Discussion | weavepack-tensor |

## How to propose a new RFC

1. Read `weavepack/governance/01-rfc-process.md`
2. Check this index for the next available RFC number
3. Copy the structure of an existing RFC (or use the template
   below)
4. Open a PR placing your RFC at `weavepack/rfcs/NNNN-<short-name>.md`
5. Mark it `Draft` until ready, then `Discussion` to start the
   2-week clock
6. Update this index when status changes

## Template

```markdown
# RFC NNNN — <Title>

**Status:** Draft
**Author(s):** <names + GitHub handles>
**Created:** YYYY-MM-DD
**Affects:** weavepack-core | weavepack-<profile> | governance

## Summary

(One paragraph: what changes, who benefits.)

## Motivation

## Detailed design

## Backwards compatibility

## Reference implementation

## Test vectors

## Migration

## Alternatives considered

## Open questions
```

See `weavepack/governance/01-rfc-process.md` for the full
expected sections.
