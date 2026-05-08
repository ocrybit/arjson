// weavepack-tabular encoder — snapshot frames + delta chains.
//
// Wire format (snapshot):
//   FLAG_SNAPSHOT (0x00)
//   schema_hash (32 bytes)
//   LEB128(num_rows) + LEB128(num_cols)
//   row-id block (delta-coded LEB128 uint64s)
//   column block * num_cols
//
// Wire format (delta):
//   FLAG_DELTA (0x01)
//   schema_hash (32 bytes)
//   LEB128(num_ops)
//   op * num_ops

use crate::types::{
    CellValue, Column, Frame, Op, OpColumn,
    CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
    CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8, CTYPE_STRING,
    CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32, CTYPE_UINT64, CTYPE_UINT8,
    FLAG_DELTA, FLAG_SNAPSHOT, MAX_PAYLOAD_BYTES, OP_BATCH_UPSERT, OP_COLUMN_ADD,
    OP_COLUMN_DROP, OP_COLUMN_RENAME, OP_ROW_DELETE, OP_ROW_INSERT, OP_ROW_UPDATE,
    SCHEMA_HASH_BYTES,
};

struct ByteWriter { buf: Vec<u8> }

impl ByteWriter {
    fn new() -> Self { ByteWriter { buf: Vec::new() } }

    fn write_byte(&mut self, b: u8) { self.buf.push(b); }

    fn write_bytes(&mut self, src: &[u8]) { self.buf.extend_from_slice(src); }

    fn write_leb128_u32(&mut self, mut v: u32) {
        loop {
            if v < 128 { self.buf.push(v as u8); break; }
            self.buf.push((v as u8 & 0x7F) | 0x80);
            v >>= 7;
        }
    }

    fn write_leb128_u64(&mut self, mut v: u64) {
        loop {
            if v < 128 { self.buf.push(v as u8); break; }
            self.buf.push((v as u8 & 0x7F) | 0x80);
            v >>= 7;
        }
    }

    fn into_bytes(self) -> Vec<u8> { self.buf }
}

fn write_row_id_block(w: &mut ByteWriter, row_ids: &[u64]) {
    if row_ids.is_empty() { return; }
    w.write_leb128_u64(row_ids[0]);
    for i in 1..row_ids.len() {
        let delta = row_ids[i].wrapping_sub(row_ids[i - 1]);
        w.write_leb128_u64(delta);
    }
}

fn write_value(w: &mut ByteWriter, ctype: u8, val: &CellValue) -> Result<(), String> {
    match ctype {
        CTYPE_BOOL => {
            w.write_byte(if matches!(val, CellValue::Bool(true)) { 1 } else { 0 });
        }
        CTYPE_INT8 => {
            let v = match val { CellValue::Int8(v) => *v, _ => return Err("ctype mismatch int8".into()) };
            w.write_byte(v as u8);
        }
        CTYPE_INT16 => {
            let v = match val { CellValue::Int16(v) => *v, _ => return Err("ctype mismatch int16".into()) };
            let u = v as u16;
            w.write_byte(u as u8); w.write_byte((u >> 8) as u8);
        }
        CTYPE_INT32 => {
            let v = match val { CellValue::Int32(v) => *v, _ => return Err("ctype mismatch int32".into()) };
            let b = v.to_le_bytes(); w.write_bytes(&b);
        }
        CTYPE_INT64 => {
            let v = match val { CellValue::Int64(v) => *v, _ => return Err("ctype mismatch int64".into()) };
            w.write_bytes(&v.to_le_bytes());
        }
        CTYPE_UINT8 => {
            let v = match val { CellValue::Uint8(v) => *v, _ => return Err("ctype mismatch uint8".into()) };
            w.write_byte(v);
        }
        CTYPE_UINT16 => {
            let v = match val { CellValue::Uint16(v) => *v, _ => return Err("ctype mismatch uint16".into()) };
            w.write_byte(v as u8); w.write_byte((v >> 8) as u8);
        }
        CTYPE_UINT32 => {
            let v = match val { CellValue::Uint32(v) => *v, _ => return Err("ctype mismatch uint32".into()) };
            w.write_bytes(&v.to_le_bytes());
        }
        CTYPE_UINT64 => {
            let v = match val { CellValue::Uint64(v) => *v, _ => return Err("ctype mismatch uint64".into()) };
            w.write_bytes(&v.to_le_bytes());
        }
        CTYPE_FLOAT32 => {
            let v = match val { CellValue::Float32(v) => *v, _ => return Err("ctype mismatch float32".into()) };
            w.write_bytes(&v.to_le_bytes());
        }
        CTYPE_FLOAT64 => {
            let v = match val { CellValue::Float64(v) => *v, _ => return Err("ctype mismatch float64".into()) };
            w.write_bytes(&v.to_le_bytes());
        }
        CTYPE_STRING => {
            let s = match val { CellValue::String(s) => s, _ => return Err("ctype mismatch string".into()) };
            let utf8 = s.as_bytes();
            if utf8.len() > MAX_PAYLOAD_BYTES { return Err("string exceeds 256 MiB limit".into()); }
            w.write_leb128_u32(utf8.len() as u32);
            w.write_bytes(utf8);
        }
        CTYPE_BYTES => {
            let b = match val { CellValue::Bytes(b) => b, _ => return Err("ctype mismatch bytes".into()) };
            if b.len() > MAX_PAYLOAD_BYTES { return Err("bytes exceeds 256 MiB limit".into()); }
            w.write_leb128_u32(b.len() as u32);
            w.write_bytes(b);
        }
        CTYPE_DATE32 => {
            let v = match val { CellValue::Date32(v) => *v, _ => return Err("ctype mismatch date32".into()) };
            w.write_bytes(&v.to_le_bytes());
        }
        CTYPE_TIMESTAMP64 => {
            let v = match val { CellValue::Timestamp64(v) => *v, _ => return Err("ctype mismatch timestamp64".into()) };
            w.write_bytes(&v.to_le_bytes());
        }
        _ => return Err(format!("unknown ctype {ctype}")),
    }
    Ok(())
}

fn write_bool_column(w: &mut ByteWriter, values: &[&CellValue]) {
    let n = values.len();
    let nbytes = (n + 7) / 8;
    let mut bytes = vec![0u8; nbytes];
    for (i, v) in values.iter().enumerate() {
        if matches!(v, CellValue::Bool(true)) {
            bytes[i >> 3] |= 1 << (7 - (i & 7));
        }
    }
    w.write_bytes(&bytes);
}

fn write_null_bitmap(w: &mut ByteWriter, nulls: &[bool]) {
    let nbytes = (nulls.len() + 7) / 8;
    let mut bytes = vec![0u8; nbytes];
    for (i, &is_null) in nulls.iter().enumerate() {
        if is_null { bytes[i >> 3] |= 1 << (7 - (i & 7)); }
    }
    w.write_bytes(&bytes);
}

fn write_value_column(w: &mut ByteWriter, ctype: u8, values: &[Option<CellValue>]) -> Result<(), String> {
    let non_null: Vec<&CellValue> = values.iter()
        .filter_map(|v| v.as_ref())
        .collect();
    if ctype == CTYPE_BOOL {
        write_bool_column(w, &non_null);
    } else {
        for v in non_null {
            write_value(w, ctype, v)?;
        }
    }
    Ok(())
}

fn write_column_block(w: &mut ByteWriter, col: &Column) -> Result<(), String> {
    w.write_leb128_u32(col.col_id);
    let type_byte = ((col.nullable as u8) << 4) | (col.ctype & 0x0F);
    w.write_byte(type_byte);
    if col.nullable {
        let nulls: Vec<bool> = col.values.iter().map(|v| v.is_none()).collect();
        write_null_bitmap(w, &nulls);
    }
    write_value_column(w, col.ctype, &col.values)
}

fn write_op_column(w: &mut ByteWriter, col: &OpColumn) -> Result<(), String> {
    w.write_leb128_u32(col.col_id);
    let type_byte = ((col.nullable as u8) << 4) | (col.ctype & 0x0F);
    w.write_byte(type_byte);
    if col.nullable {
        let nulls: Vec<bool> = col.values.iter().map(|v| v.is_none()).collect();
        write_null_bitmap(w, &nulls);
    }
    write_value_column(w, col.ctype, &col.values)
}

fn write_op(w: &mut ByteWriter, op: &Op) -> Result<(), String> {
    match op {
        Op::RowInsert { row_ids, columns } => {
            w.write_byte(OP_ROW_INSERT);
            w.write_leb128_u64(row_ids.len() as u64);
            write_row_id_block(w, row_ids);
            w.write_leb128_u32(columns.len() as u32);
            for col in columns { write_op_column(w, col)?; }
        }
        Op::RowUpdate { row_ids, columns } => {
            w.write_byte(OP_ROW_UPDATE);
            w.write_leb128_u64(row_ids.len() as u64);
            write_row_id_block(w, row_ids);
            w.write_leb128_u32(columns.len() as u32);
            for col in columns { write_op_column(w, col)?; }
        }
        Op::RowDelete { row_ids } => {
            w.write_byte(OP_ROW_DELETE);
            w.write_leb128_u64(row_ids.len() as u64);
            write_row_id_block(w, row_ids);
        }
        Op::ColumnAdd { col_id, ctype, nullable, has_default, default_value } => {
            w.write_byte(OP_COLUMN_ADD);
            w.write_leb128_u32(*col_id);
            let type_byte = ((*nullable as u8) << 4) | (*ctype & 0x0F);
            w.write_byte(type_byte);
            w.write_byte(*has_default as u8);
            if *has_default {
                if let Some(dv) = default_value {
                    write_value(w, *ctype, dv)?;
                }
            }
        }
        Op::ColumnDrop { col_id } => {
            w.write_byte(OP_COLUMN_DROP);
            w.write_leb128_u32(*col_id);
        }
        Op::ColumnRename { col_id, name } => {
            w.write_byte(OP_COLUMN_RENAME);
            w.write_leb128_u32(*col_id);
            let name_bytes = name.as_bytes();
            w.write_leb128_u32(name_bytes.len() as u32);
            w.write_bytes(name_bytes);
        }
        Op::BatchUpsert { row_ids, columns } => {
            w.write_byte(OP_BATCH_UPSERT);
            w.write_leb128_u64(row_ids.len() as u64);
            write_row_id_block(w, row_ids);
            w.write_leb128_u32(columns.len() as u32);
            for col in columns { write_op_column(w, col)?; }
        }
    }
    Ok(())
}

pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    w.write_byte(FLAG_SNAPSHOT);
    w.write_bytes(&frame.schema_hash);
    let num_rows = frame.row_ids.len() as u64;
    w.write_leb128_u64(num_rows);
    w.write_leb128_u32(frame.columns.len() as u32);
    write_row_id_block(&mut w, &frame.row_ids);
    for col in &frame.columns {
        write_column_block(&mut w, col)?;
    }
    Ok(w.into_bytes())
}

pub fn encode_chain(schema_hash: &[u8; SCHEMA_HASH_BYTES], ops: &[Op]) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    w.write_byte(FLAG_DELTA);
    w.write_bytes(schema_hash);
    w.write_leb128_u32(ops.len() as u32);
    for op in ops { write_op(&mut w, op)?; }
    Ok(w.into_bytes())
}
