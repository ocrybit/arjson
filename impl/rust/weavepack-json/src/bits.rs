// MSB-first bit writer and reader for the weavepack-tensor wire format.
//
// All integers are packed most-significant-bit first, matching the JS
// reference's Encoder.add_dc / dump() behaviour. Padding at the end of
// each payload is zero-bit aligned to the next byte boundary.

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
        // Mask to exactly `count` bits.
        let val = if count == 32 { val } else { val & ((1u32 << count) - 1) };
        let mut remaining = count;
        while remaining > 0 {
            let free = 8 - self.bits_used;
            if remaining <= free {
                // All remaining bits fit in the current byte.
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
            // Fill current byte with the top `free` bits of val.
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
            // cur already has bits in the high positions; low bits are 0.
            self.bytes.push(self.cur);
        }
        self.bytes
    }
}

// ── bit reader ────────────────────────────────────────────────────────────────

pub struct BitReader<'a> {
    data: &'a [u8],
    pub bit_pos: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, bit_pos: 0 }
    }

    pub fn read_bits(&mut self, count: u8) -> u32 {
        let mut val = 0u32;
        for _ in 0..count {
            let byte_idx = self.bit_pos >> 3;
            let bit_idx = 7 - (self.bit_pos & 7);
            let bit = ((self.data[byte_idx] >> bit_idx) & 1) as u32;
            val = (val << 1) | bit;
            self.bit_pos += 1;
        }
        val
    }

    pub fn read_byte(&mut self) -> u8 {
        self.read_bits(8) as u8
    }

    pub fn read_leb128(&mut self) -> u64 {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let byte = self.read_bits(8) as u8;
            result |= ((byte & 0x7f) as u64) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                break;
            }
        }
        result
    }

    pub fn read_short(&mut self) -> u64 {
        let prefix = self.read_bits(2);
        match prefix {
            0 => self.read_bits(2) as u64,
            1 => self.read_bits(3) as u64,
            2 => self.read_bits(4) as u64,
            _ => self.read_leb128(),
        }
    }
}

// ── common write helpers ──────────────────────────────────────────────────────

/// Raw LEB128 (no prefix) — 7 bits per group, continuation bit in MSB.
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

/// Variable-length short integer (2-bit prefix + value body).
///
///  prefix 00 → 2-bit value  (0..3)
///  prefix 01 → 3-bit value  (0..7)
///  prefix 10 → 4-bit value  (0..15)
///  prefix 11 → raw LEB128
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

/// Append the finalize trailer (1 bit + short(0)) and pad to byte boundary.
/// Must be called once after all payload bits have been written.
pub fn finalize(mut w: BitWriter) -> Vec<u8> {
    w.write_bits(0, 1); // trailer bit
    w.write_bits(0, 2); // short(0) prefix
    w.write_bits(0, 2); // short(0) value
    w.finish()
}
