# weavepack-graph — 00: Overview

**Status:** Draft. Phase G of the weavepack v0.6 roadmap.

## What weavepack-graph is

weavepack-graph is a profile of the weavepack universal protocol for
encoding **labeled property graphs** — directed graphs where nodes and
edges carry typed property columns and optional string labels.

It targets the same problem space as GraphML, RDF/Turtle, Neo4j CSV
exports, and JSON-LD, but adds three capabilities those formats lack:

- **Native delta chains**: a delta chain records only which nodes or
  edges were inserted, deleted, or modified. Snapshot-to-snapshot diffs
  transmit O(changed elements) bytes, not O(graph size).

- **Bit-packed columnar encoding**: nodes and edges with the same label
  are organized into typed blocks where each property occupies one
  typed column. Boolean properties cost 1 bit per node. Integer
  properties are stored at the minimum bit width required by the data
  range. Repeated property values compress to near-zero via RLE.

- **Protocol-level label interning**: node and edge labels are interned
  in the core strmap once per document, not repeated on every element.
  A label that appears on 100 000 edges is encoded once.

A weavepack-graph document is a sequence of **typed blocks** — a
`node_block` groups nodes sharing the same label; an `edge_block`
groups edges sharing the same label. Both block types use the same
typed-column machinery as weavepack-tabular and weavepack-log.

## Why it exists

Existing graph formats:

| Format | Typed props | Schema | Deltas | Column-enc | Self-desc |
|---|---|---|---|---|---|
| GraphML | ✓ | ~ | ✗ | ✗ | ✓ (XML) |
| RDF/Turtle | ~ | ~ | ✗ | ✗ | ✓ |
| Neo4j CSV | ✓ | ✗ | ✗ | ✗ | ~ |
| JSON-LD | ✓ | ~ | ✗ | ✗ | ✓ |
| Adjacency list | ✗ | ✗ | ✗ | ✗ | ✗ |
| **weavepack-graph** | **✓** | **✓** | **✓** | **✓** | **✓** |

The strategic gap is **incremental graph updates**:

- A knowledge graph pipeline receives continuous triple assertions and
  retractions (e.g., Wikidata edits). Every existing format requires
  re-encoding the full graph (or subgraph) per snapshot.
  weavepack-graph emits `edge_insert` and `edge_delete` delta frames
  containing only the changed triples — bytes proportional to the edit.

- A social graph grows by 10 000 follows per second. Existing formats
  re-export the full adjacency list per checkpoint.
  weavepack-graph accumulates `edge_insert` frames; a reader applies
  them incrementally without materializing the full graph.

- A property graph receives node attribute updates (e.g., user.country
  changes). Existing formats re-encode all properties for the entire
  node. A weavepack-graph `prop_set` delta encodes only the changed
  (node, column, value) triple.

Estimated compression advantage over GraphML + gzip for incremental
workloads: ≥10× smaller than per-snapshot GraphML + gzip for streaming
edge-insert pipelines, based on the structural delta advantage already
measured for the tabular (906×) and log (363×) profiles in their
respective streaming scenarios.

## Relationship to weavepack-core

weavepack-graph uses the same core machinery as all weavepack profiles:

- Bit-pack column buffers (`Encoder` / `BitWriter` from core)
- Wire envelope structure (mode bit + section headers)
- Delta chain framing (LEB128 length-prefixed frames)
- String interning via core strmap (labels, URI strings)
- Schema sidecar via SHA-256 hash-addressed sidecar (see 06-schemas.md)

What is graph-specific:

- **Type vocabulary**: 16 column types (tabular's 15 + `node_id`)
- **Container model**: `node_block` + `edge_block` instead of rows
  (tabular) or events (log); mandatory nid/eid/src/dst structural columns
- **Path grammar**: `node/N`, `edge/E`, `@nid`, `@src`, `@dst`, `.Label`,
  `-Label` (see 03-paths.md)
- **Delta vocabulary**: 6 ops covering node/edge insert + delete + prop
  update + subgraph replace (see 04-deltas.md)

## Relationship to RDF

RDF triples can be mapped onto weavepack-graph without loss:

| RDF concept | weavepack-graph encoding |
|---|---|
| Subject IRI | nid (URI string interned in strmap; nid = strmap index) |
| Predicate IRI | edge label (interned in strmap) |
| Object IRI | dst nid (URI interned in strmap) |
| Object literal | edge property column (typed per literal datatype) |
| Named graph | edge_block label (top-level block grouping) |
| Blank node | nid with a synthetic local identifier (not an IRI) |

RDF mode is declared in the schema sidecar (`rdf_mode: true`; see
06-schemas.md). In RDF mode, the encoder interns subject/object IRIs
into the strmap and aligns nid values with strmap indices so that
URI lookup is an O(1) strmap read.

## Scope of this specification

This specification covers:

- Column type vocabulary (01-types.md)
- Container model: node_block, edge_block, graph document (02-containers.md)
- Path grammar (03-paths.md)
- Delta operation vocabulary (04-deltas.md)
- Conformance test corpus structure (05-conformance.md)
- Schema sidecar (06-schemas.md)
- Benchmark methodology and results (07-benchmarks.md)

Out of scope:

- Graph query languages (SPARQL, Cypher, GQL) — weavepack defines the
  wire format; query execution is an application layer concern.
- Graph algorithms (shortest path, centrality, etc.)
- Hypergraphs or multigraphs (future profile extension)
- RDF-specific blank node scoping rules beyond what the RDF mode covers
