// MSB-first bit reader matching the JS Decoder.n() behaviour.
//
// Bits are numbered from 0 (MSB of byte 0). Reading N bits starting at
// position `pos` extracts bits pos..pos+N in that left-to-right order.

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

    /// `short()`: 2-bit selector → 2/3/4-bit value or leb128.
    ///   selector 0 → 2 bits  (values 0..3)
    ///   selector 1 → 3 bits  (values 0..7)
    ///   selector 2 → 4 bits  (values 0..15)
    ///   selector 3 → leb128
    pub fn short(&mut self) -> Result<u64, String> {
        let x = self.read(2)?;
        match x {
            3 => self.leb128(),
            2 => self.read(4),
            1 => self.read(3),
            _ => self.read(2),
        }
    }

    /// `uint()`: 2-bit selector → 3/4/6-bit value or leb128.
    ///   selector 0 → 3 bits  (values 0..7)
    ///   selector 1 → 4 bits  (values 0..15)
    ///   selector 2 → 6 bits  (values 0..63)
    ///   selector 3 → leb128
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

// ── strmap alphabet: A-Za-z (52 chars) ─────────────────────────────────────
// strmap_rev[i] = char at index i.  Matches JS `strmap_rev`.
pub const STRMAP_CHARS: &[u8; 52] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ── base64url reverse table: index → char byte ─────────────────────────────
// Alphabet: A-Za-z0-9-_  (64 entries).  Matches JS `base64_rev_byte`.
pub fn base64url_char(idx: u64) -> u8 {
    const ALPHA: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    ALPHA[idx as usize]
}
