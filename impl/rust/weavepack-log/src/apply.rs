// weavepack-log — delta application (apply_chain, apply_op).
//
// Operates on StreamState (decoded batch + expired set + cursors + schema).
// Profile isolation: no imports from other profiles.

use crate::types::{AppendColumn, CellValue, Column, Op, SchemaCol, StreamState};

fn find_col_idx(columns: &[Column], col_id: u32) -> Option<usize> {
    columns.iter().position(|c| c.col_id == col_id)
}

fn find_seq_idx(seqs: &[u64], seq: u64) -> Option<usize> {
    seqs.iter().position(|&s| s == seq)
}

fn find_schema_idx(schema: &[SchemaCol], col_id: u32) -> Option<usize> {
    schema.iter().position(|s| s.col_id == col_id)
}

fn clone_state(state: &StreamState) -> StreamState {
    StreamState {
        schema_hash: state.schema_hash,
        seqs:        state.seqs.clone(),
        tss:         state.tss.clone(),
        columns:     state.columns.iter().map(|c| Column {
            col_id:   c.col_id,
            ctype:    c.ctype,
            nullable: c.nullable,
            values:   c.values.clone(),
        }).collect(),
        expired:     state.expired.clone(),
        cursors:     state.cursors.clone(),
        schema:      state.schema.iter().map(|s| SchemaCol {
            col_id:   s.col_id,
            ctype:    s.ctype,
            nullable: s.nullable,
            name:     s.name.clone(),
        }).collect(),
    }
}

pub fn apply_op(state: StreamState, op: &Op) -> Result<StreamState, String> {
    let mut state = clone_state(&state);

    match op {
        Op::EventAppend { seqs, tss, columns } => {
            let max_existing = state.seqs.last().copied();
            if let (Some(&first_new), Some(max)) = (seqs.first(), max_existing) {
                if first_new <= max {
                    return Err(format!(
                        "seq_not_monotone: first appended seq ({first_new}) must be > last seq ({max})"
                    ));
                }
            }

            let num_new = seqs.len();
            let col_data_map: std::collections::HashMap<u32, &AppendColumn> =
                columns.iter().map(|c| (c.col_id, c)).collect();

            // Extend existing user columns.
            for col in &mut state.columns {
                if let Some(src) = col_data_map.get(&col.col_id) {
                    if src.values.len() != num_new {
                        return Err(format!("event_append column {} has wrong value count", col.col_id));
                    }
                    col.values.extend_from_slice(&src.values);
                } else {
                    if !col.nullable {
                        return Err(format!(
                            "non_nullable_null: non-nullable col_id {} missing from event_append",
                            col.col_id
                        ));
                    }
                    col.values.extend(std::iter::repeat(None).take(num_new));
                }
            }

            // Add new columns not yet present (iterate in op order to preserve ordering).
            for src in columns {
                if find_col_idx(&state.columns, src.col_id).is_none() {
                    let back_fill_len = state.seqs.len();
                    let mut values: Vec<Option<CellValue>> = std::iter::repeat(None)
                        .take(back_fill_len)
                        .collect();
                    values.extend_from_slice(&src.values);
                    state.columns.push(Column {
                        col_id:   src.col_id,
                        ctype:    src.ctype,
                        nullable: src.nullable,
                        values,
                    });
                }
            }

            state.seqs.extend_from_slice(seqs);
            state.tss.extend_from_slice(tss);
        }

        Op::FieldUpdate { seq, columns } => {
            let row_idx = find_seq_idx(&state.seqs, *seq)
                .ok_or_else(|| format!("unknown_seq: seq {seq} not found in stream"))?;

            for uf in columns {
                let ci = find_col_idx(&state.columns, uf.col_id)
                    .ok_or_else(|| format!("unknown_col_id: col_id {} not found", uf.col_id))?;
                if state.columns[ci].ctype != uf.ctype {
                    return Err(format!(
                        "ctype_mismatch: col_id {} expected ctype {}, got {}",
                        uf.col_id, state.columns[ci].ctype, uf.ctype
                    ));
                }
                if !uf.has_value && !state.columns[ci].nullable {
                    return Err(format!("non_nullable_null: col_id {} is not nullable", uf.col_id));
                }
                state.columns[ci].values[row_idx] = uf.value.clone();
            }
        }

        Op::EventExpire { seq_lo, seq_hi } => {
            if find_seq_idx(&state.seqs, *seq_lo).is_none() {
                return Err(format!("unknown_seq: seq_lo {seq_lo} not found in stream"));
            }
            if find_seq_idx(&state.seqs, *seq_hi).is_none() {
                return Err(format!("unknown_seq: seq_hi {seq_hi} not found in stream"));
            }
            for &seq in &state.seqs {
                if seq >= *seq_lo && seq <= *seq_hi {
                    state.expired.insert(seq);
                }
            }
        }

        Op::SchemaColumnAdd { col_id, ctype, nullable, name } => {
            if find_schema_idx(&state.schema, *col_id).is_some() {
                return Err(format!("duplicate_col_id: col_id {col_id} already in schema"));
            }
            if state.schema.iter().any(|s| s.name == *name) {
                return Err(format!("duplicate_col_name: name \"{name}\" already in schema"));
            }
            state.schema.push(SchemaCol {
                col_id: *col_id,
                ctype:  *ctype,
                nullable: *nullable,
                name: name.clone(),
            });
        }

        Op::SchemaColumnDrop { col_id } => {
            let si = find_schema_idx(&state.schema, *col_id)
                .ok_or_else(|| format!("unknown_col_id: col_id {col_id} not found in schema"))?;
            state.schema.remove(si);
        }

        Op::SchemaColumnRename { col_id, name } => {
            let si = find_schema_idx(&state.schema, *col_id)
                .ok_or_else(|| format!("unknown_col_id: col_id {col_id} not found in schema"))?;
            if state.schema.iter().enumerate().any(|(i, s)| i != si && s.name == *name) {
                return Err(format!("duplicate_col_name: name \"{name}\" already in use"));
            }
            state.schema[si].name = name.clone();
        }

        Op::CursorCheckpoint { seq, name } => {
            if find_seq_idx(&state.seqs, *seq).is_none() {
                return Err(format!("unknown_seq: cursor seq {seq} not found in stream"));
            }
            state.cursors.insert(name.clone(), *seq);
        }
    }

    Ok(state)
}

pub fn init_state(batch: crate::types::Batch) -> StreamState {
    StreamState {
        schema_hash: batch.schema_hash,
        seqs:        batch.seqs,
        tss:         batch.tss,
        columns:     batch.columns,
        expired:     std::collections::HashSet::new(),
        cursors:     std::collections::HashMap::new(),
        schema:      vec![],
    }
}

pub fn apply_chain(state: StreamState, ops: &[Op]) -> Result<StreamState, String> {
    let mut s = state;
    for op in ops { s = apply_op(s, op)?; }
    Ok(s)
}
