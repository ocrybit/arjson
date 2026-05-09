// weavepack-log decoder — event batches + stream headers + delta chains.

use crate::types::{
    AppendColumn, Batch, CellValue, Column, Op, StreamHeader, UpdateField,
    CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
    CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8, CTYPE_LEVEL,
    CTYPE_STRING, CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32,
    CTYPE_UINT64, CTYPE_UINT8, FRAME_DELTA, FRAME_SNAPSHOT, FRAME_STREAM_HEADER,
    MAX_PAYLOAD_BYTES, OP_CURSOR_CHECKPOINT, OP_EVENT_APPEND, OP_EVENT_EXPIRE,
    OP_FIELD_UPDATE, OP_SCHEMA_EVOLVE, SCHEMA_HASH_BYTES, STREAM_ID_BYTES,
    SUB_COLUMN_ADD, SUB_COLUMN_DROP, SUB_COLUMN_RENAME,
};

struct ByteReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    fn new(buf: &'a [u8]) -> Self { ByteReader { buf, pos: 0 } }

    fn read_byte(&mut self) -> Result<u8, String> {
        if self.pos >= self.buf.len() { return Err("unexpected end of input".into()); }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.buf.len() { return Err("unexpected end of input".into()); }
        let slice = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn read_leb128_u32(&mut self) -> Result<u32, String> {
        let mut result = 0u32;
        let mut shift = 0u32;
        loop {
            let b = self.read_byte()?;
            result |= ((b & 0x7F) as u32) << shift;
            shift += 7;
            if (b & 0x80) == 0 { break; }
            if shift >= 35 { return Err("LEB128 overflow for uint32".into()); }
        }
        Ok(result)
    }

    fn read_leb128_u64(&mut self) -> Result<u64, String> {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let b = self.read_byte()?;
            result |= ((b & 0x7F) as u64) << shift;
            shift += 7;
            if (b & 0x80) == 0 { break; }
            if shift >= 70 { return Err("LEB128 overflow for uint64".into()); }
        }
        Ok(result)
    }

    // Decode a zigzag-encoded sint64: read LEB128 u64, then decode zigzag.
    fn read_zigzag64(&mut self) -> Result<i64, String> {
        let enc = self.read_leb128_u64()?;
        let v = ((enc >> 1) as i64) ^ -((enc & 1) as i64);
        Ok(v)
    }
}

fn read_seq_block(r: &mut ByteReader, num_events: usize) -> Result<Vec<u64>, String> {
    if num_events == 0 { return Ok(vec![]); }
    let first = r.read_leb128_u64()?;
    let mut seqs = vec![first];
    let mut prev = first;
    for _ in 1..num_events {
        let delta = r.read_leb128_u64()?;
        if delta < 1 { return Err("duplicate_seq: seq delta must be ≥1".into()); }
        prev = prev.wrapping_add(delta);
        seqs.push(prev);
    }
    Ok(seqs)
}

fn read_ts_block(r: &mut ByteReader, num_events: usize) -> Result<Vec<i64>, String> {
    if num_events == 0 { return Ok(vec![]); }
    let first = r.read_zigzag64()?;
    let mut tss = vec![first];
    let mut prev = first;
    for _ in 1..num_events {
        let delta = r.read_leb128_u64()?;
        prev = prev.wrapping_add(delta as i64);
        tss.push(prev);
    }
    Ok(tss)
}

fn read_value(r: &mut ByteReader, ctype: u8) -> Result<CellValue, String> {
    match ctype {
        CTYPE_BOOL => Ok(CellValue::Bool(r.read_byte()? != 0)),
        CTYPE_INT8 => {
            Ok(CellValue::Int8(r.read_byte()? as i8))
        }
        CTYPE_INT16 => {
            let b = r.read_bytes(2)?;
            Ok(CellValue::Int16(i16::from_le_bytes([b[0], b[1]])))
        }
        CTYPE_INT32 => {
            let b = r.read_bytes(4)?;
            Ok(CellValue::Int32(i32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_INT64 => {
            let b = r.read_bytes(8)?;
            Ok(CellValue::Int64(i64::from_le_bytes(b.try_into().unwrap())))
        }
        CTYPE_UINT8 => Ok(CellValue::Uint8(r.read_byte()?)),
        CTYPE_UINT16 => {
            let b = r.read_bytes(2)?;
            Ok(CellValue::Uint16(u16::from_le_bytes([b[0], b[1]])))
        }
        CTYPE_UINT32 => {
            let b = r.read_bytes(4)?;
            Ok(CellValue::Uint32(u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_UINT64 => {
            let b = r.read_bytes(8)?;
            Ok(CellValue::Uint64(u64::from_le_bytes(b.try_into().unwrap())))
        }
        CTYPE_FLOAT32 => {
            let b = r.read_bytes(4)?;
            Ok(CellValue::Float32(f32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_FLOAT64 => {
            let b = r.read_bytes(8)?;
            Ok(CellValue::Float64(f64::from_le_bytes(b.try_into().unwrap())))
        }
        CTYPE_STRING => {
            let len = r.read_leb128_u32()? as usize;
            if len > MAX_PAYLOAD_BYTES { return Err("string exceeds 256 MiB limit".into()); }
            let bytes = r.read_bytes(len)?;
            let s = std::str::from_utf8(bytes)
                .map_err(|_| "invalid_utf8: string column contains invalid UTF-8")?
                .to_owned();
            Ok(CellValue::String(s))
        }
        CTYPE_BYTES => {
            let len = r.read_leb128_u32()? as usize;
            if len > MAX_PAYLOAD_BYTES { return Err("bytes exceeds 256 MiB limit".into()); }
            let bytes = r.read_bytes(len)?;
            Ok(CellValue::Bytes(bytes.to_vec()))
        }
        CTYPE_DATE32 => {
            let b = r.read_bytes(4)?;
            Ok(CellValue::Date32(i32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_TIMESTAMP64 => {
            let b = r.read_bytes(8)?;
            Ok(CellValue::Timestamp64(i64::from_le_bytes(b.try_into().unwrap())))
        }
        CTYPE_LEVEL => {
            // Single level value in field_update: 1 byte.
            let v = r.read_byte()?;
            if v > 5 { return Err(format!("unknown_level: level value {v} is reserved")); }
            Ok(CellValue::Level(v))
        }
        _ => Err(format!("unknown_ctype {ctype}")),
    }
}

fn read_bool_column(r: &mut ByteReader, count: usize) -> Result<Vec<CellValue>, String> {
    let nbytes = (count + 7) / 8;
    let bytes = r.read_bytes(nbytes)?;
    let mut values = Vec::with_capacity(count);
    for i in 0..count {
        let bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
        values.push(CellValue::Bool(bit == 1));
    }
    Ok(values)
}

fn read_level_column(r: &mut ByteReader, count: usize) -> Result<Vec<CellValue>, String> {
    let nbytes = (count * 3 + 7) / 8;
    let bytes = r.read_bytes(nbytes)?;
    let mut values = Vec::with_capacity(count);
    for i in 0..count {
        let bit_base = i * 3;
        let mut v = 0u8;
        for b in 0..3usize {
            let pos = bit_base + b;
            if (bytes[pos >> 3] >> (pos & 7)) & 1 == 1 {
                v |= 1 << b;
            }
        }
        if v >= 6 { return Err(format!("unknown_level: level value {v} is reserved")); }
        values.push(CellValue::Level(v));
    }
    // Validate padding bits in the final byte are zero.
    let total_bits = count * 3;
    let used_in_last = total_bits & 7;
    if used_in_last != 0 && !bytes.is_empty() {
        let last = bytes[nbytes - 1];
        let mask = 0xFF_u8 << used_in_last;
        if last & mask != 0 {
            return Err("invalid_level_padding: padding bits must be zero".into());
        }
    }
    Ok(values)
}

fn read_null_bitmap(r: &mut ByteReader, num_events: usize) -> Result<Vec<bool>, String> {
    let nbytes = (num_events + 7) / 8;
    let bytes = r.read_bytes(nbytes)?;

    // Validate padding bits in the final byte are zero.
    let rem = num_events & 7;
    if rem != 0 {
        let last = bytes[nbytes - 1];
        let mask = 0xFF_u8 >> rem;
        if last & mask != 0 {
            return Err("invalid_null_bitmap: padding bits must be zero".into());
        }
    }

    let mut nulls = Vec::with_capacity(num_events);
    for i in 0..num_events {
        nulls.push((bytes[i >> 3] >> (7 - (i & 7))) & 1 == 1);
    }
    Ok(nulls)
}

fn read_value_column(r: &mut ByteReader, ctype: u8, count: usize) -> Result<Vec<CellValue>, String> {
    match ctype {
        CTYPE_BOOL  => read_bool_column(r, count),
        CTYPE_LEVEL => read_level_column(r, count),
        _ => {
            let mut values = Vec::with_capacity(count);
            for _ in 0..count { values.push(read_value(r, ctype)?); }
            Ok(values)
        }
    }
}

// Read a column block. Returns (col_id, ctype, nullable, values).
// type_byte = (nullable << 5) | (ctype & 0x1F)
fn read_column_block(r: &mut ByteReader, num_events: usize) -> Result<Column, String> {
    let col_id = r.read_leb128_u32()?;
    if col_id < 2 { return Err(format!("reserved_col_id: col_id {col_id} is reserved (must be ≥ 2)")); }
    let type_byte = r.read_byte()?;
    let ctype    = type_byte & 0x1F;
    let nullable = ((type_byte >> 5) & 1) == 1;
    if ctype > 16 { return Err(format!("unknown_ctype: ctype {ctype} ≥ 17 is reserved")); }

    let values = if nullable {
        let nulls = read_null_bitmap(r, num_events)?;
        let non_null_count = nulls.iter().filter(|&&b| !b).count();
        let raw = read_value_column(r, ctype, non_null_count)?;
        let mut vi = 0;
        let mut out = Vec::with_capacity(num_events);
        for is_null in &nulls {
            if *is_null {
                out.push(None);
            } else {
                out.push(Some(raw[vi].clone()));
                vi += 1;
            }
        }
        out
    } else {
        read_value_column(r, ctype, num_events)?
            .into_iter().map(Some).collect()
    };

    Ok(Column { col_id, ctype, nullable, values })
}

// ── Public: decode event batch (snapshot frame) ───────────────────────────────────────────────

pub fn decode_batch(bytes: &[u8]) -> Result<Batch, String> {
    let mut r = ByteReader::new(bytes);
    let flag = r.read_byte()?;
    if flag == FRAME_DELTA {
        return Err("expected event batch (0x00), got delta chain (0x01)".into());
    }
    if flag == FRAME_STREAM_HEADER {
        return Err("expected event batch (0x00), got stream header (0x02)".into());
    }
    if flag != FRAME_SNAPSHOT {
        return Err(format!("unknown frame flag 0x{flag:02x}"));
    }

    let hash_bytes = r.read_bytes(SCHEMA_HASH_BYTES)?;
    let schema_hash: [u8; SCHEMA_HASH_BYTES] = hash_bytes.try_into().unwrap();

    let num_events = r.read_leb128_u64()? as usize;
    let seqs = read_seq_block(&mut r, num_events)?;
    let tss  = read_ts_block(&mut r, num_events)?;

    let num_user_cols = r.read_leb128_u32()? as usize;
    let mut columns = Vec::with_capacity(num_user_cols);
    for _ in 0..num_user_cols {
        columns.push(read_column_block(&mut r, num_events)?);
    }

    Ok(Batch { schema_hash, seqs, tss, columns })
}

// ── Public: decode stream header ────────────────────────────────────────────────────────────────────────

pub fn decode_stream_header(bytes: &[u8]) -> Result<StreamHeader, String> {
    let mut r = ByteReader::new(bytes);
    let flag = r.read_byte()?;
    if flag != FRAME_STREAM_HEADER {
        return Err(format!("expected stream header (0x02), got 0x{flag:02x}"));
    }

    let id_bytes = r.read_bytes(STREAM_ID_BYTES)?;
    let stream_id: [u8; STREAM_ID_BYTES] = id_bytes.try_into().unwrap();

    let source_len = r.read_leb128_u32()? as usize;
    let source_bytes = r.read_bytes(source_len)?;
    let source = std::str::from_utf8(source_bytes)
        .map_err(|_| "invalid_utf8: source contains invalid UTF-8")?
        .to_owned();

    let hash_bytes = r.read_bytes(SCHEMA_HASH_BYTES)?;
    let schema_hash: [u8; SCHEMA_HASH_BYTES] = hash_bytes.try_into().unwrap();

    let seq_start = r.read_leb128_u64()?;

    Ok(StreamHeader { stream_id, source, schema_hash, seq_start })
}

// ── Op decoding ────────────────────────────────────────────────────────────────────────────────────

fn read_append_column(r: &mut ByteReader, num_events: usize) -> Result<AppendColumn, String> {
    let col = read_column_block(r, num_events)?;
    Ok(AppendColumn { col_id: col.col_id, ctype: col.ctype, nullable: col.nullable, values: col.values })
}

fn read_event_append(r: &mut ByteReader) -> Result<Op, String> {
    let num_events = r.read_leb128_u64()? as usize;
    let seqs = read_seq_block(r, num_events)?;
    let tss  = read_ts_block(r, num_events)?;
    let num_cols = r.read_leb128_u32()? as usize;
    let mut columns = Vec::with_capacity(num_cols);
    for _ in 0..num_cols { columns.push(read_append_column(r, num_events)?); }
    Ok(Op::EventAppend { seqs, tss, columns })
}

fn read_field_update(r: &mut ByteReader) -> Result<Op, String> {
    let seq = r.read_leb128_u64()?;
    let num_cols = r.read_leb128_u32()? as usize;
    let mut columns = Vec::with_capacity(num_cols);
    for _ in 0..num_cols {
        let col_id    = r.read_leb128_u32()?;
        let type_byte = r.read_byte()?;
        let ctype     = type_byte & 0x1F;
        let has_value = ((type_byte >> 5) & 1) == 1;
        if ctype > 16 { return Err(format!("unknown_ctype: ctype {ctype} ≥ 17 is reserved")); }
        let value = if has_value { Some(read_value(r, ctype)?) } else { None };
        columns.push(UpdateField { col_id, ctype, has_value, value });
    }
    Ok(Op::FieldUpdate { seq, columns })
}

fn read_event_expire(r: &mut ByteReader) -> Result<Op, String> {
    let seq_lo = r.read_leb128_u64()?;
    let seq_hi = r.read_leb128_u64()?;
    if seq_lo > seq_hi {
        return Err(format!("invalid_seq_range: seq_lo ({seq_lo}) > seq_hi ({seq_hi})"));
    }
    Ok(Op::EventExpire { seq_lo, seq_hi })
}

fn read_schema_evolve(r: &mut ByteReader) -> Result<Op, String> {
    let sub_op = r.read_byte()?;
    match sub_op {
        SUB_COLUMN_ADD => {
            let col_id    = r.read_leb128_u32()?;
            let type_byte = r.read_byte()?;
            let ctype     = type_byte & 0x1F;
            let nullable  = ((type_byte >> 5) & 1) == 1;
            if ctype > 16 { return Err(format!("unknown_ctype: ctype {ctype} ≥ 17 is reserved")); }
            let name_len = r.read_leb128_u32()? as usize;
            if name_len == 0 { return Err("invalid_col_name: empty name".into()); }
            let name_bytes = r.read_bytes(name_len)?;
            let name = std::str::from_utf8(name_bytes)
                .map_err(|_| "invalid_utf8 in column name")?
                .to_owned();
            Ok(Op::SchemaColumnAdd { col_id, ctype, nullable, name })
        }
        SUB_COLUMN_DROP => {
            let col_id = r.read_leb128_u32()?;
            Ok(Op::SchemaColumnDrop { col_id })
        }
        SUB_COLUMN_RENAME => {
            let col_id = r.read_leb128_u32()?;
            let name_len = r.read_leb128_u32()? as usize;
            if name_len == 0 { return Err("invalid_col_name: empty name".into()); }
            let name_bytes = r.read_bytes(name_len)?;
            let name = std::str::from_utf8(name_bytes)
                .map_err(|_| "invalid_utf8 in column name")?
                .to_owned();
            Ok(Op::SchemaColumnRename { col_id, name })
        }
        _ => Err(format!("unknown_schema_sub_op: sub_op {sub_op} is reserved")),
    }
}

fn read_cursor_checkpoint(r: &mut ByteReader) -> Result<Op, String> {
    let seq      = r.read_leb128_u64()?;
    let name_len = r.read_leb128_u32()? as usize;
    if name_len == 0 { return Err("invalid_cursor_name: empty cursor name".into()); }
    let name_bytes = r.read_bytes(name_len)?;
    let name = std::str::from_utf8(name_bytes)
        .map_err(|_| "invalid_utf8 in cursor name")?
        .to_owned();
    Ok(Op::CursorCheckpoint { seq, name })
}

fn read_op(r: &mut ByteReader) -> Result<Op, String> {
    let op_code = r.read_byte()?;
    match op_code {
        OP_EVENT_APPEND      => read_event_append(r),
        OP_FIELD_UPDATE      => read_field_update(r),
        OP_EVENT_EXPIRE      => read_event_expire(r),
        OP_SCHEMA_EVOLVE     => read_schema_evolve(r),
        OP_CURSOR_CHECKPOINT => read_cursor_checkpoint(r),
        _ => Err(format!("unknown_delta_op: op code {op_code} is reserved")),
    }
}

// ── Public: decode delta chain ──────────────────────────────────────────────────────────────────────────

pub fn decode_chain(bytes: &[u8]) -> Result<([u8; SCHEMA_HASH_BYTES], Vec<Op>), String> {
    let mut r = ByteReader::new(bytes);
    let flag = r.read_byte()?;
    if flag != FRAME_DELTA {
        return Err(format!("expected delta chain (flag 0x01), got 0x{flag:02x}"));
    }
    let hash_bytes = r.read_bytes(SCHEMA_HASH_BYTES)?;
    let schema_hash: [u8; SCHEMA_HASH_BYTES] = hash_bytes.try_into().unwrap();
    let num_ops = r.read_leb128_u32()? as usize;
    let mut ops = Vec::with_capacity(num_ops);
    for _ in 0..num_ops { ops.push(read_op(&mut r)?); }
    Ok((schema_hash, ops))
}
