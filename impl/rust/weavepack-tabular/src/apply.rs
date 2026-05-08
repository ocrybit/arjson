// weavepack-tabular — delta application (apply_chain, apply_op).
//
// Operates on decoded Frame state (same representation as decode_frame returns).

use crate::types::{CellValue, Column, Frame, Op, OpColumn, SCHEMA_HASH_BYTES};

fn find_col_idx(columns: &[Column], col_id: u32) -> Option<usize> {
    columns.iter().position(|c| c.col_id == col_id)
}

fn build_row_index(row_ids: &[u64]) -> std::collections::HashMap<u64, usize> {
    row_ids.iter().enumerate().map(|(i, &id)| (id, i)).collect()
}

fn clone_frame(frame: &Frame) -> Frame {
    Frame {
        schema_hash: frame.schema_hash,
        row_ids: frame.row_ids.clone(),
        columns: frame.columns.iter().map(|c| Column {
            col_id:   c.col_id,
            ctype:    c.ctype,
            nullable: c.nullable,
            values:   c.values.clone(),
            name:     c.name.clone(),
        }).collect(),
    }
}

pub fn apply_op(frame: Frame, op: &Op) -> Result<Frame, String> {
    let mut frame = clone_frame(&frame);

    match op {
        Op::RowInsert { row_ids, columns } => {
            let existing = build_row_index(&frame.row_ids);
            for &rid in row_ids {
                if existing.contains_key(&rid) {
                    return Err(format!("duplicate_row_id: row_id {rid} already exists"));
                }
            }

            // Merge new rows into sorted order.
            let col_data_map: std::collections::HashMap<u32, &OpColumn> =
                columns.iter().map(|c| (c.col_id, c)).collect();

            let mut all_ids: Vec<u64> = frame.row_ids.iter().chain(row_ids.iter()).cloned().collect();
            all_ids.sort_unstable();

            let old_idx = build_row_index(&frame.row_ids);
            let insert_idx = build_row_index(row_ids);

            let new_columns: Vec<Column> = frame.columns.iter().map(|col| {
                let insert_col = col_data_map.get(&col.col_id);
                let new_values = all_ids.iter().map(|&rid| {
                    if let Some(&oi) = old_idx.get(&rid) {
                        col.values[oi].clone()
                    } else if let Some(ic) = insert_col {
                        if let Some(&ii) = insert_idx.get(&rid) {
                            ic.values[ii].clone()
                        } else { None }
                    } else { None }
                }).collect();
                Column { col_id: col.col_id, ctype: col.ctype, nullable: col.nullable,
                         values: new_values, name: col.name.clone() }
            }).collect();

            frame.row_ids = all_ids;
            frame.columns = new_columns;
        }

        Op::RowUpdate { row_ids, columns } => {
            let row_idx = build_row_index(&frame.row_ids);
            for &rid in row_ids {
                if !row_idx.contains_key(&rid) {
                    return Err(format!("unknown_row_id: row_id {rid} not found"));
                }
            }
            let _update_idx = build_row_index(row_ids);
            for update_col in columns {
                let ci = find_col_idx(&frame.columns, update_col.col_id)
                    .ok_or_else(|| format!("unknown_col_id: col_id {} not found", update_col.col_id))?;
                if frame.columns[ci].ctype != update_col.ctype {
                    return Err(format!("ctype_mismatch: col_id {}", update_col.col_id));
                }
                let mut new_values = frame.columns[ci].values.clone();
                for (i, &rid) in row_ids.iter().enumerate() {
                    let ri = row_idx[&rid];
                    new_values[ri] = update_col.values[i].clone();
                }
                frame.columns[ci].values = new_values;
            }
        }

        Op::RowDelete { row_ids } => {
            let row_idx = build_row_index(&frame.row_ids);
            for &rid in row_ids {
                if !row_idx.contains_key(&rid) {
                    return Err(format!("unknown_row_id: row_id {rid} not found"));
                }
            }
            let delete_set: std::collections::HashSet<u64> = row_ids.iter().cloned().collect();
            let keep: Vec<bool> = frame.row_ids.iter().map(|rid| !delete_set.contains(rid)).collect();
            frame.row_ids = frame.row_ids.iter().enumerate()
                .filter(|&(i, _)| keep[i]).map(|(_, &id)| id).collect();
            for col in &mut frame.columns {
                col.values = col.values.iter().enumerate()
                    .filter(|&(i, _)| keep[i]).map(|(_, v)| v.clone()).collect();
            }
        }

        Op::ColumnAdd { col_id, ctype, nullable, has_default, default_value } => {
            if find_col_idx(&frame.columns, *col_id).is_some() {
                return Err(format!("duplicate_col_id: col_id {col_id} already exists"));
            }
            if !nullable && !has_default && !frame.row_ids.is_empty() {
                return Err("column_add malformed: non-nullable column with no default cannot be added to non-empty table".into());
            }
            let default_val: Option<CellValue> = if *has_default { default_value.clone() } else { None };
            let values = frame.row_ids.iter().map(|_| default_val.clone()).collect();
            frame.columns.push(Column {
                col_id: *col_id, ctype: *ctype, nullable: *nullable,
                values, name: None,
            });
        }

        Op::ColumnDrop { col_id } => {
            let ci = find_col_idx(&frame.columns, *col_id)
                .ok_or_else(|| format!("unknown_col_id: col_id {col_id} not found"))?;
            frame.columns.remove(ci);
        }

        Op::ColumnRename { col_id, name } => {
            if name.is_empty() { return Err("invalid_col_name: empty name".into()); }
            // Check for duplicate name.
            let ci = find_col_idx(&frame.columns, *col_id)
                .ok_or_else(|| format!("unknown_col_id: col_id {col_id} not found"))?;
            for (i, col) in frame.columns.iter().enumerate() {
                if i != ci && col.name.as_deref() == Some(name.as_str()) {
                    return Err(format!("duplicate_col_name: name \"{name}\" already in use"));
                }
            }
            frame.columns[ci].name = Some(name.clone());
        }

        Op::BatchUpsert { row_ids, columns } => {
            let row_idx = build_row_index(&frame.row_ids);
            let mut to_update: Vec<usize> = Vec::new();
            let mut to_insert: Vec<usize> = Vec::new();
            for (i, &rid) in row_ids.iter().enumerate() {
                if row_idx.contains_key(&rid) { to_update.push(i); }
                else { to_insert.push(i); }
            }

            if !to_update.is_empty() {
                let update_row_ids: Vec<u64> = to_update.iter().map(|&i| row_ids[i]).collect();
                let update_cols: Vec<OpColumn> = columns.iter().map(|col| {
                    OpColumn {
                        col_id: col.col_id, ctype: col.ctype, nullable: col.nullable,
                        values: to_update.iter().map(|&i| col.values[i].clone()).collect(),
                    }
                }).collect();
                frame = apply_op(frame, &Op::RowUpdate { row_ids: update_row_ids, columns: update_cols })?;
            }
            if !to_insert.is_empty() {
                let insert_row_ids: Vec<u64> = to_insert.iter().map(|&i| row_ids[i]).collect();
                let insert_cols: Vec<OpColumn> = columns.iter().map(|col| {
                    OpColumn {
                        col_id: col.col_id, ctype: col.ctype, nullable: col.nullable,
                        values: to_insert.iter().map(|&i| col.values[i].clone()).collect(),
                    }
                }).collect();
                frame = apply_op(frame, &Op::RowInsert { row_ids: insert_row_ids, columns: insert_cols })?;
            }
        }
    }

    Ok(frame)
}

pub fn apply_chain(frame: Frame, ops: &[Op]) -> Result<Frame, String> {
    let mut state = frame;
    for op in ops { state = apply_op(state, op)?; }
    Ok(state)
}

// Null-schema (all-zero) hash constant.
pub const NULL_SCHEMA_HASH: [u8; SCHEMA_HASH_BYTES] = [0u8; SCHEMA_HASH_BYTES];
