// weavepack-json structured-mode encoder.
//
// Implements the column-buffer wire format for non-empty JSON containers.
// Mirrors the JS Encoder class + _encode / pushPathStr / pushPathNum logic
// in sdk/src/encoder.js and sdk/src/profiles/json/encode.js.
//
// Wire layout (structured mode, mode-bit = 0):
//   dc: [0-bit] [short:rcount]
//   vflags  (2-bit prefix: 00=all-0, 01=all-1, 10=mixed + body)
//   vlinks
//   kflags  (same prefix scheme)
//   klinks
//   keys + kvals
//   vtypes
//   bools   (same prefix scheme)
//   nums
//   vals
//   strdiffs  (empty for snapshots)

use std::collections::HashMap;
use serde_json::{Map, Value as Json};
use crate::bits::BitWriter;
use crate::types::{base64url_index, get_precision, is_base64url};

// ── fast_bits helper ──────────────────────────────────────────────────────────
// Returns the number of bits needed to represent n (= floor(log2(n)) + 1
// for n >= 1; 1 for n == 0). Matches JS `fastBits` / `bits`.
fn fast_bits(n: u64) -> usize {
    if n == 0 { 1 } else { (64 - n.leading_zeros()) as usize }
}

// ── BitVec ────────────────────────────────────────────────────────────────────
// A bit accumulator that matches the JS Encoder's 32-bit column buffer layout.
// Bits are packed MSB-first within each 32-bit word (the first pushed bit
// occupies the highest position).  This mirrors JS `_add` exactly.
struct BitVec {
    buf: Vec<u32>,
    len: usize, // total bits accumulated
}

impl BitVec {
    fn new() -> Self { Self { buf: Vec::new(), len: 0 } }

    // Push `bits` low-order bits from `val`, MSB first.
    fn push(&mut self, val: u32, bits: usize) {
        if bits == 0 { return; }
        let val = if bits >= 32 { val } else { val & ((1u32 << bits) - 1) };
        let used = self.len & 31;
        let free = if used == 0 { 32 } else { 32 - used };
        let idx  = self.len >> 5;

        while self.buf.len() <= idx + 1 { self.buf.push(0); }

        if bits <= free {
            if used == 0 {
                self.buf[idx] = val;
            } else {
                self.buf[idx] = (self.buf[idx] << bits) | val;
            }
            self.len += bits;
            return;
        }

        // Split across two words.
        let high = val >> (bits - free);
        if used == 0 { self.buf[idx] = high; }
        else { self.buf[idx] = (self.buf[idx] << free) | high; }
        self.len += free;

        let rest = bits - free;
        let low  = val & ((1u32 << rest) - 1);
        let idx2 = self.len >> 5;
        while self.buf.len() <= idx2 { self.buf.push(0); }
        self.buf[idx2] = low;
        self.len += rest;
    }

    fn push_leb128(&mut self, mut v: u64) {
        loop {
            let byte = (v & 0x7f) as u32;
            v >>= 7;
            if v > 0 { self.push(byte | 0x80, 8); } else { self.push(byte, 8); break; }
        }
    }

    // `short` encoding (2-bit flag + variable body).  Matches JS `short_*`.
    fn push_short(&mut self, v: u64) {
        if v < 4 {
            let d = 2usize;
            self.push((d - 2) as u32, 2);
            self.push(v as u32, d);
        } else if v < 16 {
            let d = fast_bits(v);
            self.push((d - 2) as u32, 2);
            self.push(v as u32, d);
        } else {
            self.push(3, 2);
            self.push_leb128(v);
        }
    }

    // Drain into a BitWriter (used during finalize).
    fn write_to(&self, w: &mut BitWriter) {
        let mut remaining = self.len;
        for word in &self.buf {
            if remaining == 0 { break; }
            let bits_this = remaining.min(32) as u8;
            w.write_bits(*word, bits_this);
            remaining -= bits_this as usize;
        }
    }
}

// ── StructEncoder ─────────────────────────────────────────────────────────────

pub struct StructEncoder {
    // ── Column buffers ────────────────────────────────────────────────────
    vlinks:  BitVec,
    klinks:  BitVec,
    keys:    BitVec, // ktypes + keylen for each key node
    kvals:   BitVec, // actual key character bits
    vtypes:  BitVec,
    bools:   BitVec,
    nums:    BitVec,
    vals:    BitVec,

    // Flag columns (raw bit bodies — prefix written at finalize time).
    vflags: BitVec, vflags_zero: usize, vflags_one: usize,
    kflags: BitVec, kflags_zero: usize, kflags_one: usize,
    bools_zero: usize, bools_one: usize,

    // ── Counters ──────────────────────────────────────────────────────────
    rcount: u64, // number of vlinks emitted
    dcount: u64, // node counter (arrays, objects, keys)

    // ── Link state ────────────────────────────────────────────────────────
    prev_link:  Option<u64>,
    prev_klink: Option<u64>,

    // vlink RLE accumulator
    vc_v:      Option<u64>,
    vc_diffs:  Vec<bool>,
    vc_counts: Vec<u64>,
    vc_count:  usize,

    // klink RLE accumulator
    kc_v:      Option<u64>,
    kc_diffs:  Vec<bool>,
    kc_counts: Vec<u64>,
    kc_count:  usize,

    // Adaptive bit-width for absolute-mode vlinks/klinks.
    prev_bits:  usize,
    prev_kbits: usize,

    // ── Nums RLE state ────────────────────────────────────────────────────
    prev_num:  i64,
    nc_diff:   Option<bool>,
    nc_v:      i64,
    nc_count:  usize,

    // ── Vtypes accumulation ───────────────────────────────────────────────
    pt_type:   u8,   // pending vtype value
    tcount:    usize, // count of consecutive same types

    // ── String interning ──────────────────────────────────────────────────
    str_len: u64,
    strmap:  HashMap<String, u64>,
}

impl StructEncoder {
    pub fn new() -> Self {
        Self {
            vlinks: BitVec::new(), klinks: BitVec::new(),
            keys:   BitVec::new(), kvals:  BitVec::new(),
            vtypes: BitVec::new(), bools:  BitVec::new(),
            nums:   BitVec::new(), vals:   BitVec::new(),
            vflags: BitVec::new(), vflags_zero: 0, vflags_one: 0,
            kflags: BitVec::new(), kflags_zero: 0, kflags_one: 0,
            bools_zero: 0, bools_one: 0,
            rcount: 0, dcount: 0,
            prev_link: None, prev_klink: None,
            vc_v: None, vc_diffs: Vec::new(), vc_counts: Vec::new(), vc_count: 0,
            kc_v: None, kc_diffs: Vec::new(), kc_counts: Vec::new(), kc_count: 0,
            prev_bits: 1, prev_kbits: 1,
            prev_num: 0,
            nc_diff: None, nc_v: 0, nc_count: 0,
            pt_type: 0, tcount: 0,
            str_len: 0, strmap: HashMap::new(),
        }
    }

    // ── vlink emission ────────────────────────────────────────────────────

    fn push_vlink(&mut self, v: u64) {
        let (v2, is_diff) = self.encode_link(v, self.prev_link);
        self.prev_link = Some(v);

        // vflag
        let flag = if is_diff { 1u32 } else { 0 };
        self.vflags.push(flag, 1);
        if is_diff { self.vflags_one += 1; } else { self.vflags_zero += 1; }

        self._push_vlink_rle(v2, is_diff, self.dcount);
        self.rcount += 1;
    }

    fn _push_vlink_rle(&mut self, v: u64, is_diff: bool, count: u64) {
        if let Some(vc_v) = self.vc_v {
            if v == vc_v {
                self.vc_diffs.push(is_diff);
                self.vc_counts.push(count);
                self.vc_count += 1;
                return;
            }
            self.flush_vlink();
        }
        self.vc_v = Some(v);
        self.vc_diffs = vec![is_diff];
        self.vc_counts = vec![count];
        self.vc_count = 1;
    }

    fn flush_vlink(&mut self) {
        let (v, count) = match self.vc_v { Some(v) => (v, self.vc_count), None => return };
        self.vc_v = None;

        if count < 4 {
            for i in 0..count {
                let is_diff = self.vc_diffs[i];
                let cnt     = self.vc_counts[i];
                self._flush_vlink_one(v, is_diff, cnt);
            }
        } else {
            // RLE path.
            if self.vc_diffs[0] {
                self.vlinks.push(0, 3); // RLE trigger in diff mode
                self.vlinks.push_short(count as u64);
                self.vlinks.push((v + 1) as u32, 3);
            } else {
                let nb = self.set_newbits(self.vc_counts[0]);
                self.vlinks.push(0, nb); // RLE trigger in absolute mode
                self.vlinks.push_short(count as u64);
                self.vlinks.push((v + 1) as u32, nb);
            }
        }
    }

    fn _flush_vlink_one(&mut self, v: u64, is_diff: bool, count: u64) {
        if is_diff {
            self.vlinks.push((v + 1) as u32, 3);
        } else {
            let nb = self.set_newbits(count);
            self.vlinks.push((v + 1) as u32, nb);
        }
    }

    fn set_newbits(&mut self, count: u64) -> usize {
        let new_bits = fast_bits(count + 1);
        if new_bits > self.prev_bits {
            let diff = new_bits - self.prev_bits;
            for i in 0..diff {
                self.vlinks.push(0, self.prev_bits + i);
            }
            self.prev_bits = new_bits;
        }
        new_bits
    }

    // ── klink emission ────────────────────────────────────────────────────

    fn push_klink(&mut self, v: u64) {
        let (v2, is_diff) = self.encode_link(v, self.prev_klink);
        self.prev_klink = Some(v);

        let flag = if is_diff { 1u32 } else { 0 };
        self.kflags.push(flag, 1);
        if is_diff { self.kflags_one += 1; } else { self.kflags_zero += 1; }

        self._push_klink_rle(v2, is_diff, self.dcount);
    }

    fn _push_klink_rle(&mut self, v: u64, is_diff: bool, count: u64) {
        if let Some(kc_v) = self.kc_v {
            if v == kc_v {
                self.kc_diffs.push(is_diff);
                self.kc_counts.push(count);
                self.kc_count += 1;
                return;
            }
            self.flush_klink();
        }
        self.kc_v = Some(v);
        self.kc_diffs = vec![is_diff];
        self.kc_counts = vec![count];
        self.kc_count = 1;
    }

    fn flush_klink(&mut self) {
        let (v, count) = match self.kc_v { Some(v) => (v, self.kc_count), None => return };
        self.kc_v = None;

        if count < 4 {
            for i in 0..count {
                let is_diff = self.kc_diffs[i];
                let cnt     = self.kc_counts[i];
                self._flush_klink_one(v, is_diff, cnt);
            }
        } else {
            if self.kc_diffs[0] {
                self.klinks.push(0, 3);
                self.klinks.push_short(count as u64);
                self.klinks.push((v + 1) as u32, 3);
            } else {
                let nb = self.set_newbits_k(self.kc_counts[0]);
                self.klinks.push(0, nb);
                self.klinks.push_short(count as u64);
                self.klinks.push((v + 1) as u32, nb);
            }
        }
    }

    fn _flush_klink_one(&mut self, v: u64, is_diff: bool, count: u64) {
        if is_diff {
            self.klinks.push((v + 1) as u32, 3);
        } else {
            let nb = self.set_newbits_k(count);
            self.klinks.push((v + 1) as u32, nb);
        }
    }

    fn set_newbits_k(&mut self, count: u64) -> usize {
        let new_bits = fast_bits(count + 1);
        if new_bits > self.prev_kbits {
            let diff = new_bits - self.prev_kbits;
            for i in 0..diff {
                self.klinks.push(0, self.prev_kbits + i);
            }
            self.prev_kbits = new_bits;
        }
        new_bits
    }

    // ── link diff helper ──────────────────────────────────────────────────
    // Returns (encoded_value, is_diff).  Matches JS `push_vlink` diff logic.
    fn encode_link(&self, v: u64, prev: Option<u64>) -> (u64, bool) {
        let diff: i64 = match prev {
            None => v as i64,        // first link: treat as absolute diff = v
            Some(p) => v as i64 - p as i64,
        };
        if diff < 0 {
            let d = (-diff + 3) as u64;
            if d < 7 { (d, true) } else { (v, false) }
        } else {
            let d = diff as u64;
            if d < 4 { (d, true) } else { (v, false) }
        }
    }

    // ── vtypes emission ───────────────────────────────────────────────────

    // Call when the current vtype differs from the accumulated run, or at end.
    fn maybe_flush_type(&mut self, new_type: Option<u8>) {
        if self.tcount == 0 { return; }
        let v = self.pt_type;
        if self.tcount > 3 {
            // RLE: "000" + short(tcount) + type
            self.vtypes.push(0, 3);
            self.vtypes.push_short(self.tcount as u64);
            self.vtypes.push(v as u32, 3);
        } else {
            for _ in 0..self.tcount {
                self.vtypes.push(v as u32, 3);
            }
        }
        self.tcount = 0;
        if let Some(t) = new_type {
            self.pt_type = t;
            self.tcount = 1;
        }
    }

    fn push_vtype(&mut self, t: u8) {
        if self.tcount == 0 {
            self.pt_type = t;
            self.tcount = 1;
        } else if t == self.pt_type {
            self.tcount += 1;
        } else {
            self.maybe_flush_type(Some(t));
        }
    }

    // ── nums emission ─────────────────────────────────────────────────────

    fn push_int(&mut self, v: u64) {
        if v > 0xffff_ffff || self.prev_num > 0xffff_ffff as i64 {
            self.prev_num = v as i64;
            self.dint(v as i64, false);
            return;
        }
        let prev = self.prev_num;
        let diff = v as i64 - prev;
        let (v2, is_diff) = if diff < 0 {
            let d = (-diff + 3) as u64;
            if d < 7 { (d as i64, true) } else { (v as i64, false) }
        } else {
            let d = diff as u64;
            if d < 4 { (d as i64, true) } else { (v as i64, false) }
        };
        self.prev_num = v as i64;
        self.dint(v2, is_diff);
    }

    // For structured-mode float encoding.  v = moved+1 for non-integer.
    fn push_float_enc(&mut self, neg: bool, v: u64) {
        if v < 4 {
            self.push_int(if neg { 4 + v } else { v });
        } else {
            self.push_int(if neg { 4 } else { 0 });
        }
    }

    fn dint(&mut self, v: i64, is_diff: bool) {
        if let Some(nd) = self.nc_diff {
            if nd == is_diff && self.nc_v == v {
                self.nc_count += 1;
                return;
            }
            if self.nc_count == 1 {
                self._dint(self.nc_v, nd);
            } else {
                self.flush_nums();
            }
        }
        self.nc_diff = Some(is_diff);
        self.nc_v = v;
        self.nc_count = 1;
    }

    fn flush_nums(&mut self) {
        if let Some(nd) = self.nc_diff {
            let v     = self.nc_v;
            let count = self.nc_count;
            if count < 3 {
                for _ in 0..count { self._dint(v, nd); }
            } else {
                // RLE: "00"+"111" + short(count) + value
                self.nums.push(0, 2); // diff marker x=0
                self.nums.push(7, 3); // RLE trigger n=7
                self.nums.push_short(count as u64);
                if nd {
                    // diff encoding: x=0 + 3-bit delta
                    self.nums.push(0, 2);
                    self.nums.push(v as u32, 3);
                } else if v < 64 {
                    let (flag, d) = if v < 16 { (1u32, 4usize) } else { (2u32, 6usize) };
                    self.nums.push(flag, 2);
                    self.nums.push(v as u32, d);
                } else {
                    self.nums.push(3, 2);
                    self.nums.push_leb128(v as u64);
                }
            }
            self.nc_diff = None;
        }
    }

    fn _dint(&mut self, v: i64, is_diff: bool) {
        if is_diff {
            self.nums.push(0, 2); // x=0
            self.nums.push(v as u32, 3);
        } else if v < 64 {
            let (flag, d) = if v < 16 { (1u32, 4usize) } else { (2u32, 6usize) };
            self.nums.push(flag, 2);
            self.nums.push(v as u32, d);
        } else {
            self.nums.push(3, 2);
            self.nums.push_leb128(v as u64);
        }
    }

    // ── bool emission ─────────────────────────────────────────────────────

    fn push_bool(&mut self, b: bool) {
        let v = if b { 1u32 } else { 0 };
        self.bools.push(v, 1);
        if b { self.bools_one += 1; } else { self.bools_zero += 1; }
    }

    // ── key emission ──────────────────────────────────────────────────────

    // Emit an array-index (ktype=0) or object-marker (ktype=1) key node.
    // keylen: 0 = array, 1 = object.
    fn push_path_num(&mut self, parent_vlink: Option<u64>, keylen: u32) {
        if self.dcount > 0 {
            let klink_target = parent_vlink.map(|p| p + 1).unwrap_or(0);
            self.push_klink(klink_target);
        }
        self.keys.push(keylen, 2);
        self.dcount += 1;
    }

    // Emit a string key.  Handles base64url and leb128 key encodings, and
    // strmap deduplication for keys (mirrors JS pushPathStr).
    fn push_path_str(&mut self, key: &str, parent_klink: u64) {
        if self.dcount > 0 {
            self.push_klink(parent_klink + 1);
        }
        if let Some(&idx) = self.strmap.get(key) {
            // Strmap hit: ktype=2, keylen=0, then short(idx) in kvals.
            self.keys.push(2, 2);
            self.keys.push_short(0); // keylen=0 means "dedup ref"
            self.kvals.push_short(idx);
        } else {
            // New key.
            self.strmap.insert(key.to_string(), self.str_len);
            self.str_len += 1;
            let len = key.encode_utf16().count();
            if is_base64url(key) && !key.is_empty() {
                // ktype=2 (base64url), keylen = len+1.
                self.keys.push(2, 2);
                self.keys.push_short((len + 1) as u64);
                for c in key.chars() {
                    let idx = base64url_index(c).unwrap();
                    self.kvals.push(idx as u32, 6);
                }
            } else {
                // ktype=3 (leb128 / fallback), keylen = len+1.
                self.keys.push(3, 2);
                self.keys.push_short((len + 1) as u64);
                for cu in key.encode_utf16() {
                    self.kvals.push_leb128(cu as u64);
                }
            }
        }
        self.dcount += 1;
    }

    // ── string value emission (vals column) ───────────────────────────────

    fn push_str_val(&mut self, s: &str) {
        if let Some(&idx) = self.strmap.get(s) {
            // Strmap dedup: short(0) + flag-bit 0 + short(idx).
            self.vals.push_short(0);
            self.vals.push(0, 1); // flag=0 => strmap ref
            self.vals.push_short(idx);
        } else {
            self.strmap.insert(s.to_string(), self.str_len);
            self.str_len += 1;
            let len = s.encode_utf16().count();
            self.vals.push_short(len as u64);
            if is_base64url(s) && !s.is_empty() {
                // vtype=2 (StrB64): 6-bit chars.
                for c in s.chars() {
                    let idx = base64url_index(c).unwrap();
                    self.vals.push(idx as u32, 6);
                }
            } else {
                // vtype=7 (StrFall): leb128 per UTF-16 code unit.
                for cu in s.encode_utf16() {
                    self.vals.push_leb128(cu as u64);
                }
            }
        }
    }

    // ── main traversal ────────────────────────────────────────────────────

    // Encode v recursively.  `parent_vlink` is the dcount of the enclosing
    // container (None for root).  `parent_klink` is the dcount-1 of the
    // enclosing object scope (only relevant for object values).
    // Returns the vtype emitted (for type-run accumulation by the caller).
    pub fn encode_value(
        &mut self,
        v: &Json,
        parent_vlink: Option<u64>,
        parent_klink: Option<u64>,
    ) {
        match v {
            Json::Null => {
                let vlink = parent_vlink.map(|p| p + 1).unwrap_or(0);
                self.push_vlink(vlink);
                self.push_vtype(1); // Null
            }
            Json::Bool(b) => {
                let vlink = parent_vlink.map(|p| p + 1).unwrap_or(0);
                self.push_vlink(vlink);
                self.push_vtype(3); // Bool
                self.push_bool(*b);
            }
            Json::Number(n) => {
                let vlink = parent_vlink.map(|p| p + 1).unwrap_or(0);
                self.push_vlink(vlink);
                self.encode_number(n);
            }
            Json::String(s) => {
                let vlink = parent_vlink.map(|p| p + 1).unwrap_or(0);
                self.push_vlink(vlink);
                let is_b64 = is_base64url(s) && !s.is_empty();
                self.push_vtype(if is_b64 { 2 } else { 7 });
                self.push_str_val(s);
            }
            Json::Array(arr) if arr.is_empty() => {
                // Empty array as a leaf value with Float type, encoded as n=1.
                self.push_path_num(parent_vlink, 0);
                let vlink_self = self.dcount; // dcount after push_path_num
                self.push_vlink(vlink_self);
                self.push_vtype(6); // Float
                self.push_float_enc(false, 1); // push_int(1) → empty array marker
            }
            Json::Object(obj) if obj.is_empty() => {
                // Empty object as a leaf value with Float type, encoded as n=5.
                self.push_path_num(parent_vlink, 1);
                let vlink_self = self.dcount;
                self.push_vlink(vlink_self);
                self.push_vtype(6); // Float
                self.push_float_enc(true, 1); // push_int(5) → empty object marker
            }
            Json::Array(arr) => {
                let prev_dc = self.dcount;
                self.push_path_num(parent_vlink, 0);
                for item in arr.iter() {
                    self.encode_value(item, Some(prev_dc), None);
                }
            }
            Json::Object(obj) => {
                let prev_dc = self.dcount;
                self.push_path_num(parent_vlink, 1);
                let obj_dc = self.dcount; // dcount after object-marker node
                for (key, val) in obj.iter() {
                    let key_dc_before = self.dcount;
                    self.push_path_str(key, obj_dc - 1);
                    let key_dc_after = self.dcount - 1; // dcount of the key node
                    // Value's parent_vlink is the key node's dcount.
                    // parent_klink for nested objects is key_dc_after.
                    self.encode_value(val, Some(key_dc_after), Some(key_dc_after));
                    let _ = key_dc_before;
                }
                let _ = prev_dc;
            }
        }
    }

    fn encode_number(&mut self, n: &serde_json::Number) {
        if let Some(i) = n.as_i64() {
            if i >= 0 {
                self.push_vtype(4); // IntPos
                self.push_int(i as u64);
            } else {
                self.push_vtype(5); // IntNeg
                self.push_int((-i) as u64);
            }
            return;
        }
        if let Some(u) = n.as_u64() {
            self.push_vtype(4); // IntPos
            self.push_int(u);
            return;
        }
        let f = match n.as_f64() { Some(f) => f, None => return };
        if !f.is_finite() {
            self.push_vtype(1); // Null (coerce non-finite)
            return;
        }
        let limit = (1u64 << 53) as f64;
        if f.fract() == 0.0 && f >= -limit && f <= limit {
            if f >= 0.0 {
                self.push_vtype(4);
                self.push_int(f as u64);
            } else {
                self.push_vtype(5);
                self.push_int((-f) as u64);
            }
            return;
        }
        self.push_vtype(6); // Float
        let neg  = f < 0.0;
        let abs  = if neg { -f } else { f };
        let prec = get_precision(abs).min(308) as u64;
        let scale = 10f64.powi(prec as i32);
        let mant  = (abs * scale).round() as u64;
        self.push_float_enc(neg, prec + 1);
        if prec + 1 > 3 {
            self.push_int(prec + 1);
        }
        self.push_int(mant);
    }

    // ── finalize ──────────────────────────────────────────────────────────

    pub fn finalize(mut self) -> Vec<u8> {
        // Flush all RLE accumulators.
        self.flush_vlink();
        self.flush_klink();
        self.flush_nums();
        self.maybe_flush_type(None);

        // dc column: mode-bit=0 + short(rcount)
        let mut dc = BitVec::new();
        dc.push(0, 1);
        dc.push_short(self.rcount);

        // Helper: write a flag-column with 2-bit prefix.
        let write_flag_col = |w: &mut BitWriter,
                               bv: &BitVec,
                               zero: usize,
                               one:  usize|
        {
            let n = zero + one;
            if n == 0 { return; }
            if zero == n {
                w.write_bits(0, 2); // all-zeros, no body
            } else if one == n {
                w.write_bits(1, 2); // all-ones, no body
            } else {
                w.write_bits(2, 2); // mixed: prefix + body
                bv.write_to(w);
            }
        };

        // Compute total bit count.
        let vf_n   = self.vflags_zero + self.vflags_one;
        let vf_body = if vf_n > 0 && self.vflags_zero != vf_n && self.vflags_one != vf_n {
            self.vflags.len } else { 0 };
        let kf_n    = self.kflags_zero + self.kflags_one;
        let kf_body = if kf_n > 0 && self.kflags_zero != kf_n && self.kflags_one != kf_n {
            self.kflags.len } else { 0 };
        let b_n     = self.bools_zero + self.bools_one;
        let b_body  = if b_n > 0 && self.bools_zero != b_n && self.bools_one != b_n {
            self.bools.len } else { 0 };

        let vf_prefix = if vf_n > 0 { 2 } else { 0 };
        let kf_prefix = if kf_n > 0 { 2 } else { 0 };
        let b_prefix  = if b_n  > 0 { 2 } else { 0 };

        let total_bits =
            dc.len +
            vf_prefix + vf_body +
            self.vlinks.len +
            kf_prefix + kf_body +
            self.klinks.len +
            self.keys.len + self.kvals.len +
            self.vtypes.len +
            b_prefix + b_body +
            self.nums.len +
            self.vals.len;
            // strdiffs = 0 for snapshots

        let pad = (8 - total_bits % 8) % 8;
        let out_bytes = (total_bits + pad) / 8;
        let mut w = BitWriter::new();
        // Pre-allocate isn't needed; BitWriter grows dynamically.

        // Emit columns in order.
        dc.write_to(&mut w);

        write_flag_col(&mut w, &self.vflags, self.vflags_zero, self.vflags_one);
        self.vlinks.write_to(&mut w);

        write_flag_col(&mut w, &self.kflags, self.kflags_zero, self.kflags_one);
        self.klinks.write_to(&mut w);

        self.keys.write_to(&mut w);
        self.kvals.write_to(&mut w);

        self.vtypes.write_to(&mut w);

        write_flag_col(&mut w, &self.bools, self.bools_zero, self.bools_one);

        self.nums.write_to(&mut w);
        self.vals.write_to(&mut w);
        // strdiffs: empty for snapshots

        let _ = out_bytes; // used only for sanity; BitWriter pads on finish
        w.finish()
    }
}

// ── public entry point ────────────────────────────────────────────────────────

/// Encode a non-empty JSON array or object in structured mode.
pub fn encode_structured(v: &Json) -> Result<Vec<u8>, String> {
    let mut enc = StructEncoder::new();
    enc.encode_value(v, None, None);
    Ok(enc.finalize())
}
