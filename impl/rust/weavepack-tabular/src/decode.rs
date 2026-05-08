// weavepack-tabular decoder — snapshot frames + delta chains.

use crate::types::{
    CellValue, Column, Frame, Op, OpColumn,
    CTYPE_BOOL, CTYPE_BYTES, CTYPE_DATE32, CTYPE_FLOAT32, CTYPE_FLOAT64,
    CTYPE_INT16, CTYPE_INT32, CTYPE_INT64, CTYPE_INT8, CTYPE_STRING,
    CTYPE_TIMESTAMP64, CTYPE_UINT16, CTYPE_UINT32, CTYPE_UINT64, CTYPE_UINT8,
    FLAG_DELTA, FLAG_SNAPSHOT, MAX_PAYLOAD_BYTES, OP_BATCH_UPSERT, OP_COLUMN_ADD,
    OP_COLUMN_DROP, OP_COLUMN_RENAME, OP_ROW_DELETE, OP_ROW_INSERT, OP_ROW_UPDATE,
    SCHEMA_HASH_BYTES,
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
}

fn read_row_id_block(r: &mut ByteReader, num_rows: usize) -> Result<Vec<u64>, String> {
    if num_rows == 0 { return Ok(vec![]); }
    let first = r.read_leb128_u64()?;
    let mut ids = vec![first];
    let mut prev = first;
    for _ in 1..num_rows {
        let delta = r.read_leb128_u64()?;
        if delta < 1 { return Err("duplicate_row_id: row_id delta must be ≥1".into()); }
        prev = prev.wrapping_add(delta);
        ids.push(prev);
    }
    Ok(ids)
}

fn read_value(r: &mut ByteReader, ctype: u8) -> Result<CellValue, String> {
    match ctype {
        CTYPE_BOOL => Ok(CellValue::Bool(r.read_byte()? != 0)),
        CTYPE_INT8 => {
            let b = r.read_byte()?;
            Ok(CellValue::Int8(b as i8))
        }
        CTYPE_INT16 => {
            let b = r.read_bytes(2)?;
            let v = u16::from_le_bytes([b[0], b[1]]);
            Ok(CellValue::Int16(v as i16))
        }
        CTYPE_INT32 => {
            let b = r.read_bytes(4)?;
            Ok(CellValue::Int32(i32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_INT64 => {
            let b = r.read_bytes(8)?;
            let arr: [u8; 8] = b.try_into().unwrap();
            Ok(CellValue::Int64(i64::from_le_bytes(arr)))
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
            let arr: [u8; 8] = b.try_into().unwrap();
            Ok(CellValue::Uint64(u64::from_le_bytes(arr)))
        }
        CTYPE_FLOAT32 => {
            let b = r.read_bytes(4)?;
            Ok(CellValue::Float32(f32::from_le_bytes([b[0], b[1], b[2], b[3]])))
        }
        CTYPE_FLOAT64 => {
            let b = r.read_bytes(8)?;
            let arr: [u8; 8] = b.try_into().unwrap();
            Ok(CellValue::Float64(f64::from_le_bytes(arr)))
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
            let arr: [u8; 8] = b.try_into().unwrap();
            Ok(CellValue::Timestamp64(i64::from_le_bytes(arr)))
        }
        _ => Err(format!("unknown ctype {ctype}")),
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

fn read_null_bitmap(r: &mut ByteReader, num_rows: usize) -> Result<Vec<bool>, String> {
    let nbytes = (num_rows + 7) / 8;
    let bytes = r.read_bytes(nbytes)?;

    // Validate padding bits in the final byte are zero.
    let rem = num_rows & 7;
    if rem != 0 {
        let last = bytes[nbytes - 1];
        let mask = 0xFF_u8 >> rem;
        if last & mask != 0 {
            return Err("invalid_null_bitmap: padding bits must be zero".into());
        }
    }

    let mut nulls = Vec::with_capacity(num_rows);
    for i in 0..num_rows {
        nulls.push((bytes[i >> 3] >> (7 - (i & 7))) & 1 == 1);
    }
    Ok(nulls)
}

fn read_value_column(r: &mut ByteReader, ctype: u8, count: usize) -> Result<Vec<CellValue>, String> {
    if ctype == CTYPE_BOOL {
        return read_bool_column(r, count);
    }
    let mut values = Vec::with_capacity(count);
    for _ in 0..count { values.push(read_value(r, ctype)?); }
    Ok(values)
}

fn read_column_block(r: &mut ByteReader, num_rows: usize) -> Result<Column, String> {
    let col_id = r.read_leb128_u32()?;
    let type_byte = r.read_byte()?;
    let ctype    = type_byte & 0x0F;
    let nullable = ((type_byte >> 4) & 1) == 1;

    let values = if nullable {
        let nulls = read_null_bitmap(r, num_rows)?;
        let non_null_count = nulls.iter().filter(|&&b| !b).count();
        let raw = read_value_column(r, ctype, non_null_count)?;
        let mut vi = 0;
        let mut out = Vec::with_capacity(num_rows);
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
        read_value_column(r, ctype, num_rows)?
            .into_iter().map(Some).collect()
    };

    Ok(Column { col_id, ctype, nullable, values, name: None })
}

pub fn decode_frame(bytes: &[u8]) -> Result<Frame, String> {
    let mut r = ByteReader::new(bytes);
    let flag = r.read_byte()?;
    if flag == FLAG_DELTA {
        return Err("expected snapshot frame, got delta chain".into());
    }
    if flag != FLAG_SNAPSHOT {
        return Err(format!("unknown frame flag 0x{flag:02x}"));
    }

    let hash_bytes = r.read_bytes(SCHEMA_HASH_BYTES)?;
    let schema_hash: [u8; SCHEMA_HASH_BYTES] = hash_bytes.try_into().unwrap();

    let num_rows = r.read_leb128_u64()? as usize;
    let num_cols = r.read_leb128_u32()? as usize;

    let row_ids = read_row_id_block(&mut r, num_rows)?;

    let mut columns = Vec::with_capacity(num_cols);
    for _ in 0..num_cols {
        columns.push(read_column_block(&mut r, num_rows)?);
    }

    Ok(Frame { schema_hash, row_ids, columns })
}

fn read_op_column(r: &mut ByteReader, num_rows: usize) -> Result<OpColumn, String> {
    let col = read_column_block(r, num_rows)?;
    Ok(OpColumn { col_id: col.col_id, ctype: col.ctype, nullable: col.nullable, values: col.values })
}

fn read_op(r: &mut ByteReader) -> Result<Op, String> {
    let op_code = r.read_byte()?;
    match op_code {
        OP_ROW_INSERT => {
            let num_rows = r.read_leb128_u64()? as usize;
            let row_ids = read_row_id_block(r, num_rows)?;
            let num_cols = r.read_leb128_u32()? as usize;
            let mut columns = Vec::with_capacity(num_cols);
            for _ in 0..num_cols { columns.push(read_op_column(r, num_rows)?); }
            Ok(Op::RowInsert { row_ids, columns })
        }
        OP_ROW_UPDATE => {
            let num_rows = r.read_leb128_u64()? as usize;
            let row_ids = read_row_id_block(r, num_rows)?;
            let num_cols = r.read_leb128_u32()? as usize;
            let mut columns = Vec::with_capacity(num_cols);
            for _ in 0..num_cols { columns.push(read_op_column(r, num_rows)?); }
            Ok(Op::RowUpdate { row_ids, columns })
        }
        OP_ROW_DELETE => {
            let num_rows = r.read_leb128_u64()? as usize;
            let row_ids = read_row_id_block(r, num_rows)?;
            Ok(Op::RowDelete { row_ids })
        }
        OP_COLUMN_ADD => {
            let col_id = r.read_leb128_u32()?;
            let type_byte = r.read_byte()?;
            let ctype    = type_byte & 0x0F;
            let nullable = ((type_byte >> 4) & 1) == 1;
            let has_default = r.read_byte()? == 1;
            let default_value = if has_default {
                Some(read_value(r, ctype)?)
            } else {
                None
            };
            Ok(Op::ColumnAdd { col_id, ctype, nullable, has_default, default_value })
        }
        OP_COLUMN_DROP => {
            let col_id = r.read_leb128_u32()?;
            Ok(Op::ColumnDrop { col_id })
        }
        OP_COLUMN_RENAME => {
            let col_id = r.read_leb128_u32()?;
            let name_len = r.read_leb128_u32()? as usize;
            if name_len == 0 { return Err("invalid_col_name: empty name".into()); }
            let name_bytes = r.read_bytes(name_len)?;
            let name = std::str::from_utf8(name_bytes)
                .map_err(|_| "invalid_utf8 in column name")?
                .to_owned();
            Ok(Op::ColumnRename { col_id, name })
        }
        OP_BATCH_UPSERT => {
            let num_rows = r.read_leb128_u64()? as usize;
            let row_ids = read_row_id_block(r, num_rows)?;
            let num_cols = r.read_leb128_u32()? as usize;
            let mut columns = Vec::with_capacity(num_cols);
            for _ in 0..num_cols { columns.push(read_op_column(r, num_rows)?); }
            Ok(Op::BatchUpsert { row_ids, columns })
        }
        7 => Err("unknown_delta_op: op code 7 is reserved".into()),
        _ => Err(format!("unknown_delta_op: op code {op_code}")),
    }
}

pub fn decode_chain(bytes: &[u8]) -> Result<(Vec<u8>, Vec<Op>), String> {
    let mut r = ByteReader::new(bytes);
    let flag = r.read_byte()?;
    if flag != FLAG_DELTA {
        return Err(format!("expected delta chain (flag 0x01), got 0x{flag:02x}"));
    }
    let hash_bytes = r.read_bytes(SCHEMA_HASH_BYTES)?;
    let schema_hash: Vec<u8> = hash_bytes.to_vec();
    let num_ops = r.read_leb128_u32()? as usize;
    let mut ops = Vec::with_capacity(num_ops);
    for _ in 0..num_ops { ops.push(read_op(&mut r)?); }
    Ok((schema_hash, ops))
}
