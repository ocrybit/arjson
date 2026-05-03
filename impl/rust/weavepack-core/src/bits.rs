// weavepack-core bit primitives — normative implementation of
// weavepack/core/03-bit-encoding.md.
//
// All integers are packed most-significant-bit first, matching the JS
// reference's Encoder.add_dc / Decoder.n() behaviour.

// ── BitWriter ─────────────────────────────────────────────────────────────────

pub struct BitWriter {
    bytes: Vec<u8>,
    cur: u8,
    bits_used: u8,
}

impl BitWriter {
    pub fn new() -> Self {
        Self { bytes: Vec::new(), cur: 0, bits_used: 0 }
    }

    /// Write the `count` lowest-order bits of `val`, MSB first.
    pub fn write_bits(&mut self, val: u32, count: u8) {
        debug_assert!(count <= 32, "write_bits count > 32");
        if count == 0 {
            return;
        }
        let val = if count == 32 { val } else { val & ((1u32 << count) - 1) };
        let mut remaining = count;
        while remaining > 0 {
            let free = 8 - self.bits_used;
            if remaining <= free {
                let shift = free - remaining;
                self.cur |= (val as u8) << shift;
                self.bits_used += remaining;
                if self.bits_used == 8 {
                    self.bytes.push(self.cur);
                    self.cur = 0;
                    self.bits_used = 0;
                }
                return;
            }
            let shift = remaining - free;
            let part = (val >> shift) as u8 & ((1u8 << free) - 1);
            self.cur |= part;
            self.bytes.push(self.cur);
            self.cur = 0;
            self.bits_used = 0;
            remaining -= free;
        }
    }

    pub fn write_byte(&mut self, b: u8) {
        self.write_bits(b as u32, 8);
    }

    /// Pad with zero bits to the next byte boundary and return the bytes.
    pub fn finish(mut self) -> Vec<u8> {
        if self.bits_used > 0 {
            self.bytes.push(self.cur);
        }
        self.bytes
    }
}

// ── BitReader ─────────────────────────────────────────────────────────────────

pub struct BitReader<'a> {
    pub data: &'a [u8],
    /// Current bit position (0 = MSB of first byte).
    pub pos: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    /// Read `n` bits (MSB first) and advance `pos` by `n`.
    pub fn read(&mut self, n: usize) -> Result<u64, String> {
        debug_assert!(n <= 32, "read() called with n={n} > 32");
        if n == 0 {
            return Ok(0);
        }
        let byte_idx = self.pos >> 3;
        let bit_off = self.pos & 7;
        self.pos += n;

        // Fast path: up to 24 bits fit in a 4-byte window.
        if n <= 24 {
            let b0 = *self.data.get(byte_idx).unwrap_or(&0) as u32;
            let b1 = *self.data.get(byte_idx + 1).unwrap_or(&0) as u32;
            let b2 = *self.data.get(byte_idx + 2).unwrap_or(&0) as u32;
            let b3 = *self.data.get(byte_idx + 3).unwrap_or(&0) as u32;
            let w = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
            let shift = 32 - bit_off - n;
            return Ok(((w >> shift) & ((1u32 << n) - 1)) as u64);
        }

        // Slow path: > 24 bits.
        let mut result = 0u64;
        let start = self.pos - n;
        for i in 0..n {
            let bit_pos = start + i;
            if bit_pos / 8 < self.data.len() {
                let byte = self.data[bit_pos / 8];
                let bit = (byte >> (7 - (bit_pos & 7))) & 1;
                result = (result << 1) | (bit as u64);
            }
        }
        Ok(result)
    }

    /// Decode an unsigned LEB128 value.
    pub fn leb128(&mut self) -> Result<u64, String> {
        let mut result = 0u64;
        let mut shift = 0u64;
        loop {
            let byte = self.read(8)? as u8;
            result |= ((byte & 0x7f) as u64) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                break;
            }
            if shift > 63 {
                return Err("leb128 overflow".into());
            }
        }
        Ok(result)
    }

    /// `short()` — 2-bit prefix → 2/3/4-bit body or leb128.
    ///
    ///  prefix 00 → 2-bit value  (0..3)
    ///  prefix 01 → 3-bit value  (0..7)
    ///  prefix 10 → 4-bit value  (0..15)
    ///  prefix 11 → leb128
    pub fn short(&mut self) -> Result<u64, String> {
        let x = self.read(2)?;
        match x {
            3 => self.leb128(),
            2 => self.read(4),
            1 => self.read(3),
            _ => self.read(2),
        }
    }

    /// `uint()` — 2-bit prefix → 3/4/6-bit body or leb128.
    ///
    ///  prefix 00 → 3-bit value  (0..7)
    ///  prefix 01 → 4-bit value  (0..15)
    ///  prefix 10 → 6-bit value  (0..63)
    ///  prefix 11 → leb128
    pub fn uint(&mut self) -> Result<u64, String> {
        let x = self.read(2)?;
        match x {
            3 => self.leb128(),
            2 => self.read(6),
            1 => self.read(4),
            _ => self.read(3),
        }
    }

    /// Advance to the next byte boundary.
    pub fn align_byte(&mut self) {
        if self.pos & 7 != 0 {
            self.pos += 8 - (self.pos & 7);
        }
    }
}

// ── write helpers ─────────────────────────────────────────────────────────────

/// Raw LEB128 — 7 bits per group, continuation bit in MSB.
pub fn write_leb128(w: &mut BitWriter, mut v: u64) {
    loop {
        if v < 128 {
            w.write_bits(v as u32, 8);
            break;
        }
        w.write_bits(((v & 0x7f) | 0x80) as u32, 8);
        v >>= 7;
    }
}

/// `short()` write — 2-bit prefix + variable body.
pub fn write_short(w: &mut BitWriter, v: u64) {
    if v < 4 {
        w.write_bits(0, 2);
        w.write_bits(v as u32, 2);
    } else if v < 8 {
        w.write_bits(1, 2);
        w.write_bits(v as u32, 3);
    } else if v < 16 {
        w.write_bits(2, 2);
        w.write_bits(v as u32, 4);
    } else {
        w.write_bits(3, 2);
        write_leb128(w, v);
    }
}

/// `uint()` write — 2-bit prefix + variable body.
pub fn write_uint(w: &mut BitWriter, v: u64) {
    if v < 8 {
        w.write_bits(0, 2);
        w.write_bits(v as u32, 3);
    } else if v < 16 {
        w.write_bits(1, 2);
        w.write_bits(v as u32, 4);
    } else if v < 64 {
        w.write_bits(2, 2);
        w.write_bits(v as u32, 6);
    } else {
        w.write_bits(3, 2);
        write_leb128(w, v);
    }
}
