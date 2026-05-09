// weavepack-log encoder — event batches + stream headers + delta chains.
//
// Wire format (snapshot / event batch):
//   FRAME_SNAPSHOT (0x00)
//   schema_hash (32 bytes)
//   LEB128(num_events)
//   seq_block: first_seq (LEB128 u64) + (N-1) deltas (each LEB128 u64, ≥1)
//   ts_block: first_ts zigzag(LEB128) + (N-1) deltas (LEB128 u64, ≥0)
//   LEB128(num_user_cols)
//   column_block * num_user_cols
//
// Wire format (stream header):
//   FRAME_STREAM_HEADER (0x02)
//   stream_id (16 bytes)
//   LEB128(source_len) + source_bytes
//   schema_hash (32 bytes)
//   LEB128(seq_start)
//
// Wire format (delta):
//   FRAME_DELTA (0x01)
//   schema_hash (32 bytes)
//   LEB128(num_ops)
//   op * num_ops
//
// Column block:
//   LEB128(col_id)
//   type_byte = (nullable << 5) | (ctype & 0x1F)
//   [null_bitmap if nullable]
//   value data
//
// See weavepack/profiles/log/02-containers.md and 04-deltas.md.

use crate::types::{
    AppendColumn, Batch, CellValue, Op, StreamHeader, UpdateField,
    CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
    CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8, CTYPE_LEVEL,
    CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32,
    CTYPE_UINT64, CTYPE_UINT8, FRAME_DELTA, FRAME_SNAPSHOT, FRAME_STREAM_HEADER,
    MAX_PAYLOAD_BYTES, OP_CURSOR_CHECKPOINT, OP_EVENT_APPEND, OP_EVENT_EXPIRE,
    OP_FIELD_UPDATE, OP_SCHEMA_EVOLVE, SCHEMA_HASH_BYTES,
    SUB_COLUMN_ADD, SUB_COLUMN_DROP, SUB_COLUMN_RENAME,
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

// Zigzag-encode a signed 64-bit integer, then write as LEB128 u64.
fn write_zigzag64(w: &mut ByteWriter, v: i64) {
    let enc = ((v << 1) ^ (v >> 63)) as u64;
    w.write_leb128_u64(enc);
}

fn write_seq_block(w: &mut ByteWriter, seqs: &[u64]) -> Result<(), String> {
    if seqs.is_empty() { return Ok(()); }
    w.write_leb128_u64(seqs[0]);
    for i in 1..seqs.len() {
        if seqs[i] <= seqs[i - 1] {
            return Err(format!("duplicate_seq: seq delta must be ≥1 at index {i}"));
        }
        let delta = seqs[i] - seqs[i - 1];
        w.write_leb128_u64(delta);
    }
    Ok(())
}

fn write_ts_block(w: &mut ByteWriter, tss: &[i64]) -> Result<(), String> {
    if tss.is_empty() { return Ok(()); }
    write_zigzag64(w, tss[0]);
    for i in 1..tss.len() {
        if tss[i] < tss[i - 1] {
            return Err(format!("non_monotone_timestamp: ts delta must be ≥0 at index {i}"));
        }
        let delta = (tss[i] - tss[i - 1]) as u64;
        w.write_leb128_u64(delta);
    }
    Ok(())
}

// Write a single scalar cell value (not column-packed).
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
            w.write_bytes(&v.to_le_bytes());
        }
        CTYPE_INT64 | CTYPE_TIMESTAMP64 => {
            let v = match val {
                CellValue::Int64(v)      => *v,
                CellValue::Timestamp64(v) => *v,
                _ => return Err(format!("ctype mismatch for ctype {ctype}")),
            };
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
        CTYPE_LEVEL => {
            // Single level value in field_update context: 1 byte.
            let v = match val { CellValue::Level(v) => *v, _ => return Err("ctype mismatch level".into()) };
            if v > 5 { return Err(format!("unknown_level: level value {v} is reserved")); }
            w.write_byte(v);
        }
        _ => return Err(format!("unknown_ctype {ctype}")),
    }
    Ok(())
}

// Write a bool column: MSB-first bit-packing.
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

// Write a level column: 3-bit LSB-first packing.
fn write_level_column(w: &mut ByteWriter, values: &[&CellValue]) -> Result<(), String> {
    let n = values.len();
    let nbytes = (n * 3 + 7) / 8;
    let mut bytes = vec![0u8; nbytes];
    for (i, v) in values.iter().enumerate() {
        let lv = match v {
            CellValue::Level(l) => *l,
            _ => return Err("ctype mismatch: expected Level value".into()),
        };
        if lv > 5 { return Err(format!("unknown_level: level value {lv} is reserved")); }
        let bit_base = i * 3;
        for b in 0..3u8 {
            if (lv >> b) & 1 == 1 {
                let pos = bit_base + b as usize;
                bytes[pos >> 3] |= 1 << (pos & 7);
            }
        }
    }
    w.write_bytes(&bytes);
    Ok(())
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
    let non_null: Vec<&CellValue> = values.iter().filter_map(|v| v.as_ref()).collect();
    match ctype {
        CTYPE_BOOL  => write_bool_column(w, &non_null),
        CTYPE_LEVEL => write_level_column(w, &non_null)?,
        _ => {
            for v in non_null { write_value(w, ctype, v)?; }
        }
    }
    Ok(())
}

// Write a column block (col_id + type_byte + optional null_bitmap + values).
// type_byte = (nullable << 5) | (ctype & 0x1F)
fn write_column_block(w: &mut ByteWriter, col_id: u32, ctype: u8, nullable: bool, values: &[Option<CellValue>]) -> Result<(), String> {
    if col_id < 2 { return Err(format!("reserved_col_id: col_id {col_id} is reserved (must be ≥ 2)")); }
    if ctype > 16 { return Err(format!("unknown_ctype: ctype {ctype} ≥ 17 is reserved")); }
    w.write_leb128_u32(col_id);
    let type_byte = ((nullable as u8) << 5) | (ctype & 0x1F);
    w.write_byte(type_byte);
    if nullable {
        let nulls: Vec<bool> = values.iter().map(|v| v.is_none()).collect();
        write_null_bitmap(w, &nulls);
    }
    write_value_column(w, ctype, values)
}

// ── Public: encode event batch (snapshot frame) ───────────────────────────────────────────────

pub fn encode_batch(batch: &Batch) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    let num_events = batch.seqs.len();

    if batch.tss.len() != num_events {
        return Err(format!("tss.len() ({}) must equal seqs.len() ({})", batch.tss.len(), num_events));
    }

    w.write_byte(FRAME_SNAPSHOT);
    w.write_bytes(&batch.schema_hash);
    w.write_leb128_u64(num_events as u64);
    write_seq_block(&mut w, &batch.seqs)?;
    write_ts_block(&mut w, &batch.tss)?;
    w.write_leb128_u32(batch.columns.len() as u32);
    for col in &batch.columns {
        if col.values.len() != num_events {
            return Err(format!("column {} has {} values but batch has {num_events} events", col.col_id, col.values.len()));
        }
        write_column_block(&mut w, col.col_id, col.ctype, col.nullable, &col.values)?;
    }
    Ok(w.into_bytes())
}

// ── Public: encode stream header ────────────────────────────────────────────────────────────────────────

pub fn encode_stream_header(hdr: &StreamHeader) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    w.write_byte(FRAME_STREAM_HEADER);
    w.write_bytes(&hdr.stream_id);
    let source_bytes = hdr.source.as_bytes();
    w.write_leb128_u32(source_bytes.len() as u32);
    w.write_bytes(source_bytes);
    w.write_bytes(&hdr.schema_hash);
    w.write_leb128_u64(hdr.seq_start);
    Ok(w.into_bytes())
}

// ── Op encoding ────────────────────────────────────────────────────────────────────────────────────

fn write_event_append(w: &mut ByteWriter, seqs: &[u64], tss: &[i64], columns: &[AppendColumn]) -> Result<(), String> {
    let num_events = seqs.len();
    w.write_leb128_u64(num_events as u64);
    write_seq_block(w, seqs)?;
    write_ts_block(w, tss)?;
    w.write_leb128_u32(columns.len() as u32);
    for col in columns {
        if col.values.len() != num_events {
            return Err(format!("event_append column {} has {} values but op has {num_events} events", col.col_id, col.values.len()));
        }
        write_column_block(w, col.col_id, col.ctype, col.nullable, &col.values)?;
    }
    Ok(())
}

fn write_field_update(w: &mut ByteWriter, seq: u64, columns: &[UpdateField]) -> Result<(), String> {
    w.write_leb128_u64(seq);
    w.write_leb128_u32(columns.len() as u32);
    for uf in columns {
        if uf.col_id < 2 { return Err(format!("reserved_col_id: col_id {} is reserved", uf.col_id)); }
        if uf.ctype > 16 { return Err(format!("unknown_ctype: ctype {} ≥ 17 is reserved", uf.ctype)); }
        w.write_leb128_u32(uf.col_id);
        let type_byte = ((uf.has_value as u8) << 5) | (uf.ctype & 0x1F);
        w.write_byte(type_byte);
        if uf.has_value {
            if let Some(val) = &uf.value {
                write_value(w, uf.ctype, val)?;
            }
        }
    }
    Ok(())
}

fn write_event_expire(w: &mut ByteWriter, seq_lo: u64, seq_hi: u64) -> Result<(), String> {
    if seq_lo > seq_hi {
        return Err(format!("invalid_seq_range: seq_lo ({seq_lo}) > seq_hi ({seq_hi})"));
    }
    w.write_leb128_u64(seq_lo);
    w.write_leb128_u64(seq_hi);
    Ok(())
}

fn write_schema_evolve(w: &mut ByteWriter, op: &Op) -> Result<(), String> {
    match op {
        Op::SchemaColumnAdd { col_id, ctype, nullable, name } => {
            if *col_id < 2 { return Err(format!("reserved_col_id: col_id {col_id} is reserved")); }
            if *ctype > 16 { return Err(format!("unknown_ctype: ctype {ctype} ≥ 17 is reserved")); }
            let name_bytes = name.as_bytes();
            if name_bytes.is_empty() { return Err("invalid_col_name: empty name".into()); }
            w.write_byte(SUB_COLUMN_ADD);
            w.write_leb128_u32(*col_id);
            let type_byte = ((*nullable as u8) << 5) | (*ctype & 0x1F);
            w.write_byte(type_byte);
            w.write_leb128_u32(name_bytes.len() as u32);
            w.write_bytes(name_bytes);
        }
        Op::SchemaColumnDrop { col_id } => {
            w.write_byte(SUB_COLUMN_DROP);
            w.write_leb128_u32(*col_id);
        }
        Op::SchemaColumnRename { col_id, name } => {
            let name_bytes = name.as_bytes();
            if name_bytes.is_empty() { return Err("invalid_col_name: empty name".into()); }
            w.write_byte(SUB_COLUMN_RENAME);
            w.write_leb128_u32(*col_id);
            w.write_leb128_u32(name_bytes.len() as u32);
            w.write_bytes(name_bytes);
        }
        _ => return Err("write_schema_evolve called with non-schema op".into()),
    }
    Ok(())
}

fn write_cursor_checkpoint(w: &mut ByteWriter, seq: u64, name: &str) -> Result<(), String> {
    let name_bytes = name.as_bytes();
    if name_bytes.is_empty() { return Err("invalid_cursor_name: empty cursor name".into()); }
    w.write_leb128_u64(seq);
    w.write_leb128_u32(name_bytes.len() as u32);
    w.write_bytes(name_bytes);
    Ok(())
}

fn write_op(w: &mut ByteWriter, op: &Op) -> Result<(), String> {
    match op {
        Op::EventAppend { seqs, tss, columns } => {
            w.write_byte(OP_EVENT_APPEND);
            write_event_append(w, seqs, tss, columns)?;
        }
        Op::FieldUpdate { seq, columns } => {
            w.write_byte(OP_FIELD_UPDATE);
            write_field_update(w, *seq, columns)?;
        }
        Op::EventExpire { seq_lo, seq_hi } => {
            w.write_byte(OP_EVENT_EXPIRE);
            write_event_expire(w, *seq_lo, *seq_hi)?;
        }
        Op::SchemaColumnAdd { .. } | Op::SchemaColumnDrop { .. } | Op::SchemaColumnRename { .. } => {
            w.write_byte(OP_SCHEMA_EVOLVE);
            write_schema_evolve(w, op)?;
        }
        Op::CursorCheckpoint { seq, name } => {
            w.write_byte(OP_CURSOR_CHECKPOINT);
            write_cursor_checkpoint(w, *seq, name)?;
        }
    }
    Ok(())
}

// ── Public: encode delta chain ──────────────────────────────────────────────────────────────────────────

pub fn encode_chain(schema_hash: &[u8; SCHEMA_HASH_BYTES], ops: &[Op]) -> Result<Vec<u8>, String> {
    let mut w = ByteWriter::new();
    w.write_byte(FRAME_DELTA);
    w.write_bytes(schema_hash);
    w.write_leb128_u32(ops.len() as u32);
    for op in ops { write_op(&mut w, op)?; }
    Ok(w.into_bytes())
}
