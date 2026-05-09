// weavepack-graph — delta application.
//
// Builds a runtime graph state from a GraphDoc and applies Op chains.
// Mirrors the logic in sdk/src/profiles/graph/apply.js.

use std::collections::BTreeMap;

use crate::types::{Block, CellValue, EdgeBlock, GraphDoc, NodeBlock, Op, Path};

// ── Col-id key (numeric or named) ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum ColId {
    Num(u32),
    Named(String),
}

// ── Per-element property entry ─────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PropEntry {
    pub ctype: u8,
    pub value: Option<CellValue>,
}

// ── Node / edge state ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NodeState {
    pub label: Option<String>,
    pub props: BTreeMap<ColId, PropEntry>,
}

#[derive(Debug, Clone)]
pub struct EdgeState {
    pub label: Option<String>,
    pub src:   u64,
    pub dst:   u64,
    pub props: BTreeMap<ColId, PropEntry>,
}

// ── Graph state ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GraphState {
    pub schema_hash: [u8; 32],
    pub nodes:       BTreeMap<u64, NodeState>,
    pub edges:       BTreeMap<u64, EdgeState>,
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn props_from_node_block(blk: &NodeBlock, idx: usize) -> BTreeMap<ColId, PropEntry> {
    let mut props = BTreeMap::new();
    for col in &blk.columns {
        if let Some(val) = &col.values[idx] {
            props.insert(ColId::Num(col.col_id), PropEntry { ctype: col.ctype, value: Some(val.clone()) });
        }
    }
    props
}

fn props_from_edge_block(blk: &EdgeBlock, idx: usize) -> BTreeMap<ColId, PropEntry> {
    let mut props = BTreeMap::new();
    for col in &blk.columns {
        if let Some(val) = &col.values[idx] {
            props.insert(ColId::Num(col.col_id), PropEntry { ctype: col.ctype, value: Some(val.clone()) });
        }
    }
    props
}

// ── init_state ────────────────────────────────────────────────────────────

pub fn init_state(doc: &GraphDoc) -> GraphState {
    let mut state = GraphState {
        schema_hash: doc.schema_hash,
        nodes:       BTreeMap::new(),
        edges:       BTreeMap::new(),
    };
    for blk in &doc.blocks {
        match blk {
            Block::Node(nb) => {
                for (i, &nid) in nb.nids.iter().enumerate() {
                    let props = props_from_node_block(nb, i);
                    state.nodes.insert(nid, NodeState { label: nb.label.clone(), props });
                }
            }
            Block::Edge(eb) => {
                for (i, &eid) in eb.eids.iter().enumerate() {
                    let props = props_from_edge_block(eb, i);
                    state.edges.insert(eid, EdgeState {
                        label: eb.label.clone(),
                        src:   eb.srcs[i],
                        dst:   eb.dsts[i],
                        props,
                    });
                }
            }
        }
    }
    state
}

// ── apply_op ──────────────────────────────────────────────────────────────

fn apply_op(mut state: GraphState, op: &Op) -> Result<GraphState, String> {
    match op {
        Op::NodeInsert { block } => {
            for (i, &nid) in block.nids.iter().enumerate() {
                if state.nodes.contains_key(&nid) {
                    return Err(format!("duplicate_element_id: nid {nid} already exists"));
                }
                let props = props_from_node_block(block, i);
                state.nodes.insert(nid, NodeState { label: block.label.clone(), props });
            }
        }

        Op::NodeDelete { nids } => {
            for &nid in nids {
                state.nodes.remove(&nid);
                // Remove incident edges.
                state.edges.retain(|_, ev| ev.src != nid && ev.dst != nid);
            }
        }

        Op::EdgeInsert { block } => {
            for (i, &eid) in block.eids.iter().enumerate() {
                if state.edges.contains_key(&eid) {
                    return Err(format!("duplicate_element_id: eid {eid} already exists"));
                }
                let props = props_from_edge_block(block, i);
                state.edges.insert(eid, EdgeState {
                    label: block.label.clone(),
                    src:   block.srcs[i],
                    dst:   block.dsts[i],
                    props,
                });
            }
        }

        Op::EdgeDelete { eids } => {
            for &eid in eids { state.edges.remove(&eid); }
        }

        Op::PropSet { path, ctype, is_null: _, value, .. } => {
            // Mirror verify-test-vectors.js: op.isNull is not set from spec JSON,
            // so the apply always stores the value (even if null).
            match path {
                Path::NodeCol { nid, col_id } => {
                    let node = state.nodes.get_mut(nid)
                        .ok_or_else(|| format!("element_not_found: node {nid}"))?;
                    node.props.insert(ColId::Num(*col_id), PropEntry { ctype: *ctype, value: value.clone() });
                }
                Path::EdgeCol { eid, col_id } => {
                    let edge = state.edges.get_mut(eid)
                        .ok_or_else(|| format!("element_not_found: edge {eid}"))?;
                    edge.props.insert(ColId::Num(*col_id), PropEntry { ctype: *ctype, value: value.clone() });
                }
                Path::Node { nid } => {
                    let node = state.nodes.get_mut(nid)
                        .ok_or_else(|| format!("element_not_found: node {nid}"))?;
                    // No col_id; value stored as a schemaless entry — skip for state
                    let _ = node;
                }
                Path::Edge { eid } => {
                    let edge = state.edges.get_mut(eid)
                        .ok_or_else(|| format!("element_not_found: edge {eid}"))?;
                    let _ = edge;
                }
                Path::NodeProp { nid, prop } => {
                    let node = state.nodes.get_mut(nid)
                        .ok_or_else(|| format!("element_not_found: node {nid}"))?;
                    node.props.insert(ColId::Named(prop.clone()), PropEntry { ctype: *ctype, value: value.clone() });
                }
                Path::EdgeProp { eid, prop } => {
                    let edge = state.edges.get_mut(eid)
                        .ok_or_else(|| format!("element_not_found: edge {eid}"))?;
                    edge.props.insert(ColId::Named(prop.clone()), PropEntry { ctype: *ctype, value: value.clone() });
                }
                _ => {
                    return Err(format!("prop_set: unsupported path kind for element prop update"));
                }
            }
        }

        Op::SubgraphReplace { label, node_block, edge_block } => {
            // Remove nodes and edges with the matching label.
            state.nodes.retain(|_, v| v.label.as_deref() != label.as_deref());
            state.edges.retain(|_, v| v.label.as_deref() != label.as_deref());
            if let Some(nb) = node_block {
                for (i, &nid) in nb.nids.iter().enumerate() {
                    let props = props_from_node_block(nb, i);
                    state.nodes.insert(nid, NodeState { label: nb.label.clone(), props });
                }
            }
            if let Some(eb) = edge_block {
                for (i, &eid) in eb.eids.iter().enumerate() {
                    let props = props_from_edge_block(eb, i);
                    state.edges.insert(eid, EdgeState {
                        label: eb.label.clone(),
                        src:   eb.srcs[i],
                        dst:   eb.dsts[i],
                        props,
                    });
                }
            }
        }
    }
    Ok(state)
}

// ── Public ────────────────────────────────────────────────────────────────

pub fn apply_chain(state: GraphState, ops: &[Op]) -> Result<GraphState, String> {
    let mut s = state;
    for op in ops { s = apply_op(s, op)?; }
    Ok(s)
}
