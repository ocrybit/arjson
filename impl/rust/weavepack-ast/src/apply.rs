// weavepack-ast — delta application.
//
// Mirrors the logic in sdk/src/profiles/ast/apply.js.
// Profile isolation: only imports from crate::types.

use std::collections::BTreeMap;

use crate::types::{AstDoc, Block, CellValue, Op, Path};

// ── Col-id key (numeric or named) ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum ColId {
    Num(u32),
    Named(String),
}

// ── Per-node property entry ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PropEntry {
    pub ctype: u8,
    pub value: Option<CellValue>,
}

// ── Node state ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NodeRecord {
    pub kind:        String,
    pub parent_nid:  Option<u64>,
    pub child_index: u32,
    pub props:       BTreeMap<ColId, PropEntry>,
}

// ── AST live state ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AstState {
    pub schema_hash: [u8; 32],
    pub nodes:       BTreeMap<u64, NodeRecord>,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn collect_descendants(nodes: &BTreeMap<u64, NodeRecord>, root: u64) -> Vec<u64> {
    let mut result = Vec::new();
    let mut queue  = vec![root];
    while let Some(nid) = queue.pop() {
        for (&child_nid, child) in nodes {
            if child.parent_nid == Some(nid) && !result.contains(&child_nid) {
                result.push(child_nid);
                queue.push(child_nid);
            }
        }
    }
    result
}

fn populate_nodes_from_block(nodes: &mut BTreeMap<u64, NodeRecord>, block: &Block) -> Result<(), String> {
    let (nids, parent_nids, child_indices, columns) = (
        block.nids(), block.parent_nids(), block.child_indices(), block.columns()
    );
    for i in 0..nids.len() {
        let nid = nids[i];
        if nodes.contains_key(&nid) {
            return Err(format!("duplicate_element_id: nid {nid} already exists"));
        }
        let kind = match block {
            Block::Node(b) => b.kind.clone(),
            Block::Mixed(b) => b.kinds[i].clone(),
        };
        let mut props = BTreeMap::new();
        for col in columns {
            if let Some(val) = &col.values[i] {
                props.insert(ColId::Num(col.col_id), PropEntry { ctype: col.ctype, value: Some(val.clone()) });
            }
        }
        nodes.insert(nid, NodeRecord {
            kind,
            parent_nid:  parent_nids[i],
            child_index: child_indices[i],
            props,
        });
    }
    Ok(())
}

// ── init_state ──────────────────────────────────────────────────────────────

pub fn init_state(doc: &AstDoc) -> Result<AstState, String> {
    let mut state = AstState {
        schema_hash: doc.schema_hash,
        nodes: BTreeMap::new(),
    };
    for block in &doc.blocks {
        populate_nodes_from_block(&mut state.nodes, block)?;
    }
    Ok(state)
}

// ── Op application ──────────────────────────────────────────────────────────

fn apply_op(state: &mut AstState, op: &Op) -> Result<(), String> {
    match op {
        Op::NodeInsert { block } => {
            populate_nodes_from_block(&mut state.nodes, block)?;
        }

        Op::NodeDelete { nids } => {
            for &nid in nids {
                let descendants = collect_descendants(&state.nodes, nid);
                state.nodes.remove(&nid);
                for dk in descendants {
                    state.nodes.remove(&dk);
                }
            }
        }

        Op::NodeMove { nid, new_parent_nid, new_child_index } => {
            let node = state.nodes.get_mut(nid)
                .ok_or_else(|| format!("element_not_found: node {nid} not found"))?;
            node.parent_nid  = if *new_parent_nid == 0 { None } else { Some(*new_parent_nid) };
            node.child_index = *new_child_index;
        }

        Op::PropSet { path, ctype, nullable: _, is_null: _, value } => {
            let (node_nid, col_id_key) = match path {
                Path::NodeCol { nid, col_id } => (*nid, Some(ColId::Num(*col_id))),
                Path::Node { nid }             => (*nid, None),
                Path::NodeProp { nid, prop }   => (*nid, Some(ColId::Named(prop.clone()))),
                _                              => return Ok(()),
            };
            let node = match state.nodes.get_mut(&node_nid) {
                Some(n) => n,
                None    => return Ok(()), // no-op if node not found
            };
            if let Some(key) = col_id_key {
                // Store the value (including None/null) — mirrors astSpecToOp+applyOp in JS
                // which stores null rather than deleting the prop entry.
                node.props.insert(key, PropEntry { ctype: *ctype, value: value.clone() });
            }
        }

        Op::KindRename { old_kind, new_kind } => {
            for node in state.nodes.values_mut() {
                if node.kind == *old_kind {
                    node.kind = new_kind.clone();
                }
            }
        }

        Op::SubtreeReplace { root_nid, block } => {
            // Delete all descendants of root_nid (keep root itself)
            let descendants = collect_descendants(&state.nodes, *root_nid);
            for dk in descendants {
                state.nodes.remove(&dk);
            }
            // Insert replacement subtree
            populate_nodes_from_block(&mut state.nodes, block)?;
        }
    }
    Ok(())
}

// ── apply_chain ─────────────────────────────────────────────────────────────

pub fn apply_chain(mut state: AstState, ops: &[Op]) -> Result<AstState, String> {
    for op in ops {
        apply_op(&mut state, op)?;
    }
    Ok(state)
}
