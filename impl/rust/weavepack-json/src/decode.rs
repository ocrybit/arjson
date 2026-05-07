// weavepack-json decoder — Level 1 + Level 2 conformance + delta chain.
//
// Wire layout (structured mode):
//   [0-bit] [short:rcount] vflags vlinks kflags klinks
//   keys(+kvals) vtypes bools nums vals strdiffs

use std::collections::HashMap;
use serde_json::{Map, Value};
use crate::bits::{base64url_char, BitReader, STRMAP_CHARS};

// ── pow10 table ──────────────────────────────────────────────────────────────

fn pow10(n: i64) -> f64 {
    static TABLE: std::sync::OnceLock<Vec<f64>> = std::sync::OnceLock::new();
    let t = TABLE.get_or_init(|| (0i32..=310).map(|i| 10f64.powi(i)).collect());
    if n >= 0 && n <= 310 { t[n as usize] } else { 10f64.powi(n as i32) }
}

// ── public entry point ───────────────────────────────────────────────────────

pub fn decode_snapshot(data: &[u8]) -> Result<Value, String> {
    let mut r = BitReader::new(data);
    if r.read(1)? == 1 { decode_single(&mut r) } else { decode_structured(&mut r) }
}

// ── single-payload mode ──────────────────────────────────────────────────────

fn decode_single(r: &mut BitReader<'_>) -> Result<Value, String> {
    if r.read(1)? == 1 {
        // Positive integer.
        let n = r.read(6)?;
        return if n < 63 { Ok(n.into()) } else { Ok((63 + r.leb128()?).into()) };
    }
    let code = r.read(6)?;
    Ok(match code {
        0 => Value::Null,
        1 => Value::Bool(true),
        2 => Value::Bool(false),
        3 => Value::String(String::new()),
        4 => Value::Array(Vec::new()),
        5 => Value::Object(Map::new()),
        6 => { let m = r.uint()?; Value::Number((-(m as i64)).into()) }
        7 => { // positive float
            let moved = r.uint()?;
            let mant  = r.uint()?;
            make_float((mant as f64) / pow10(moved as i64))
        }
        8 => { // negative float
            let moved = r.uint()?;
            let mant  = r.uint()?;
            make_float(-((mant as f64) / pow10(moved as i64)))
        }
        9..=60 => Value::String((STRMAP_CHARS[(code - 9) as usize] as char).to_string()),
        61 => {
            let cp = r.leb128()?;
            Value::String(char::from_u32(cp as u32)
                .ok_or_else(|| format!("bad codepoint {cp}"))?.to_string())
        }
        62 => { let n = r.short()? as usize; Value::String(read_b64_str(r, n)?) }
        63 => { let n = r.short()? as usize; Value::String(read_leb_str(r, n)?) }
        _  => unreachable!(),
    })
}

// ── structured mode ──────────────────────────────────────────────────────────

fn decode_structured(r: &mut BitReader<'_>) -> Result<Value, String> {
    let rcount = r.short()? as usize;

    let vflags          = read_flag_col(r, rcount)?;
    let (vrefs, klen)   = read_vrefs(r, &vflags)?;
    let kflag_n         = if klen > 1 { (klen - 1) as usize } else { 0 };
    let kflags          = read_flag_col(r, kflag_n)?;
    let krefs           = read_krefs(r, &kflags)?;

    // Guard: no ktypes when there are no krefs AND rcount==0.
    let ktype_n = if krefs.is_empty() && rcount == 0 { 0 } else { krefs.len() + 1 };
    let ktypes  = read_ktypes(r, ktype_n)?;
    let keys    = read_keys(r, &ktypes)?;

    let vtype_n = vrefs.len().max(1);
    let vtypes  = read_vtypes(r, vtype_n)?;

    let bools   = read_bools(r, &vtypes)?;
    let nums    = read_nums(r, &vtypes)?;
    let strs    = read_strs(r, &vtypes)?;

    // Skip strdiff payloads (only present in delta payloads, not snapshots).
    let diff_count = strs.iter().filter(|s| matches!(s, StrEntry::StrDiffRef(_))).count();
    for _ in 0..diff_count {
        let bits = r.leb128()?;
        r.pos += ((bits + 7) / 8) as usize * 8; // advance past strdiff bytes
    }

    let mut cols = Cols { vrefs, krefs, ktypes, keys, vtypes, bools, nums, strs,
                          strmap: HashMap::new() };
    build_strmap(&mut cols);
    build_tree(&cols)
}

// ── column types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum VType { Undefined, Null, StrB64, Bool, IntPos, IntNeg, Float, StrFall,
             DeleteDelta, MergeDelta,
             SpliceReplace { index: u64, remove: u64, typ: u8 },
             SpliceDel { index: u64, remove: u64 } }

#[derive(Debug, Clone)]
enum KeyEntry { ArrIdx(u64), ObjMarker(u64), StrKey(String), StrmapRef(u64) }

#[derive(Debug, Clone)]
enum StrEntry { Literal(String), StrmapRef(u64), StrDiffRef(usize) }

struct Cols {
    vrefs:  Vec<u64>,
    krefs:  Vec<u64>,
    ktypes: Vec<(u8, u64)>,
    keys:   Vec<KeyEntry>,
    vtypes: Vec<VType>,
    bools:  Vec<bool>,
    nums:   Vec<Value>,
    strs:   Vec<StrEntry>,
    strmap: HashMap<usize, String>,
}

// ── flag column ──────────────────────────────────────────────────────────────

fn read_flag_col(r: &mut BitReader<'_>, len: usize) -> Result<Vec<u8>, String> {
    if len == 0 { return Ok(Vec::new()); }
    let mode = r.read(2)?;
    match mode {
        0 => Ok(vec![0; len]),
        1 => Ok(vec![1; len]),
        2 => { let mut v = Vec::with_capacity(len);
               for _ in 0..len { v.push(r.read(1)? as u8); } Ok(v) }
        _ => Err(format!("invalid flag mode {mode}")),
    }
}

// ── vlinks → vrefs ───────────────────────────────────────────────────────────

fn read_vrefs(r: &mut BitReader<'_>, vflags: &[u8]) -> Result<(Vec<u64>, u64), String> {
    let mut vrefs     = Vec::with_capacity(vflags.len());
    let mut key_len   = 0u64;
    let mut prev      = 0u64;
    let mut cbits     = 1usize; // current absolute bit-width
    let mut i         = 0;

    while i < vflags.len() {
        let diff = vflags[i] == 1;
        if diff {
            let raw = r.read(3)?;
            if raw == 0 {
                // RLE: run of repeated vlinks.
                let run = r.short()? as usize;
                let rv  = r.read(3)?;
                if run > vflags.len() - i {
                    return Err("vrefs run-length exceeds remaining flags".into());
                }
                let run_start = i;
                for j in 0..run {
                    let d = vflags[run_start + j] == 1;
                    let (v, np) = apply_vlink(d, rv, prev);
                    prev = np; vrefs.push(v);
                    if v > key_len { key_len = v; }
                    i += 1;
                }
            } else {
                let (v, np) = apply_vlink(true, raw, prev);
                prev = np; vrefs.push(v);
                if v > key_len { key_len = v; }
                i += 1;
            }
        } else {
            let mut raw = 0u64;
            loop { raw = r.read(cbits)?; if raw != 0 { break; } cbits += 1; }
            let (v, np) = apply_vlink(false, raw, prev);
            prev = np; vrefs.push(v);
            if v > key_len { key_len = v; }
            i += 1;
        }
    }
    Ok((vrefs, key_len))
}

#[inline]
fn apply_vlink(diff: bool, raw: u64, prev: u64) -> (u64, u64) {
    let val = raw.wrapping_sub(1);
    let v = if diff {
        if val > 3 { prev.wrapping_sub(val - 3) } else { prev.wrapping_add(val) }
    } else { val };
    (v, v)
}

// ── klinks → krefs ───────────────────────────────────────────────────────────

fn read_krefs(r: &mut BitReader<'_>, kflags: &[u8]) -> Result<Vec<u64>, String> {
    let mut krefs = Vec::with_capacity(kflags.len());
    let mut prev  = 0u64;
    let mut cbits = 1usize;
    let mut i     = 0;

    while i < kflags.len() {
        let diff = kflags[i] == 1;
        if diff {
            let raw = r.read(3)?;
            if raw == 0 {
                let run = r.short()? as usize;
                let rv  = r.read(3)?;
                if run > kflags.len() - i {
                    return Err("krefs run-length exceeds remaining flags".into());
                }
                let run_start = i;
                for j in 0..run {
                    let d = kflags[run_start + j] == 1;
                    let (v, np) = apply_vlink(d, rv, prev);
                    prev = np; krefs.push(v); i += 1;
                }
            } else {
                let (v, np) = apply_vlink(true, raw, prev);
                prev = np; krefs.push(v); i += 1;
            }
        } else {
            let mut raw = 0u64;
            loop { raw = r.read(cbits)?; if raw != 0 { break; } cbits += 1; }
            let (v, np) = apply_vlink(false, raw, prev);
            prev = np; krefs.push(v); i += 1;
        }
    }
    Ok(krefs)
}

// ── ktypes ───────────────────────────────────────────────────────────────────

fn read_ktypes(r: &mut BitReader<'_>, count: usize) -> Result<Vec<(u8, u64)>, String> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let t = r.read(2)? as u8;
        let len = if t < 2 { 0 } else { r.short()? };
        out.push((t, len));
    }
    Ok(out)
}

// ── keys ─────────────────────────────────────────────────────────────────────

fn read_keys(r: &mut BitReader<'_>, ktypes: &[(u8, u64)]) -> Result<Vec<KeyEntry>, String> {
    let mut keys    = Vec::with_capacity(ktypes.len());
    let mut arr_idx = 0u64;
    let mut obj_idx = 0u64;

    for &(t, len) in ktypes {
        match t {
            0 => { keys.push(KeyEntry::ArrIdx(arr_idx)); arr_idx += 1; }
            1 => { keys.push(KeyEntry::ObjMarker(obj_idx)); obj_idx += 1; }
            2 => if len == 0 {
                keys.push(KeyEntry::StrmapRef(r.short()?));
            } else {
                keys.push(KeyEntry::StrKey(read_b64_str(r, (len - 1) as usize)?));
            },
            3 => if len <= 1 {
                keys.push(KeyEntry::StrKey(String::new()));
            } else {
                keys.push(KeyEntry::StrKey(read_leb_str(r, (len - 1) as usize)?));
            },
            _ => return Err(format!("bad ktype {t}")),
        }
    }
    Ok(keys)
}

// ── vtypes ───────────────────────────────────────────────────────────────────

fn read_vtypes(r: &mut BitReader<'_>, count: usize) -> Result<Vec<VType>, String> {
    let mut vtypes = Vec::with_capacity(count);
    let mut i = 0;
    while i < count {
        let raw = r.read(3)?;
        if raw == 0 {
            let cnt = r.short()?;
            if cnt == 0 {
                let sel = r.read(1)?;
                if sel == 1 {
                    let index  = r.short()?;
                    let remove = r.short()?;
                    let typ    = r.read(3)? as u8;
                    vtypes.push(if typ == 0 {
                        VType::SpliceDel { index, remove }
                    } else {
                        VType::SpliceReplace { index, remove, typ }
                    });
                } else {
                    vtypes.push(VType::DeleteDelta);
                }
                i += 1;
            } else {
                let cnt = cnt as usize;
                if cnt > count - i { return Err("vtype run overflow".into()); }
                let vt = u3_to_vtype(r.read(3)?);
                for _ in 0..cnt { vtypes.push(vt.clone()); }
                i += cnt;
            }
        } else {
            vtypes.push(u3_to_vtype(raw));
            i += 1;
        }
    }
    Ok(vtypes)
}

fn u3_to_vtype(v: u64) -> VType {
    match v {
        0 => VType::Undefined, 1 => VType::Null, 2 => VType::StrB64,
        3 => VType::Bool,      4 => VType::IntPos, 5 => VType::IntNeg,
        6 => VType::Float,     7 => VType::StrFall, _ => VType::Undefined,
    }
}

// ── bools ─────────────────────────────────────────────────────────────────────

fn read_bools(r: &mut BitReader<'_>, vtypes: &[VType]) -> Result<Vec<bool>, String> {
    let n = vtypes.iter().filter(|v| matches!(v, VType::Bool)).count();
    if n == 0 { return Ok(Vec::new()); }
    let mode = r.read(2)?;
    match mode {
        0 => Ok(vec![false; n]),
        1 => Ok(vec![true; n]),
        2 => { let mut v = Vec::with_capacity(n);
               for _ in 0..n { v.push(r.read(1)? == 1); } Ok(v) }
        _ => Err(format!("invalid bools mode {mode}")),
    }
}

// ── nums (with RLE cache) ─────────────────────────────────────────────────────

fn read_nums(r: &mut BitReader<'_>, vtypes: &[VType]) -> Result<Vec<Value>, String> {
    let mut nums  = Vec::new();
    let mut prev  = 0i64;
    // RLE cache: (remaining count, delta, is_diff)
    let mut cache: Option<(usize, i64, bool)> = None;

    for vt in vtypes {
        let tag = vt_num_tag(vt);
        if tag == 0 { continue; }

        let n = read_dint(r, prev, &mut cache)?;
        prev = n;

        match tag {
            4 => nums.push(Value::Number((n as u64).into())),
            5 => nums.push(Value::Number((-n).into())),
            6 => {
                if n == 0 || n == 4 {
                    // Full float encoding.
                    let moved    = read_dint(r, prev, &mut cache)?;
                    prev = moved;
                    let mantissa = read_dint(r, prev, &mut cache)?;
                    prev = mantissa;
                    let sign = if n == 4 { -1f64 } else { 1f64 };
                    let val  = (mantissa as f64) / pow10(moved - 1) * sign;
                    nums.push(make_float(val));
                } else {
                    // Short float: n encodes sign+moved.
                    let moved = if n > 4 { n - 4 } else { n };
                    let sign  = if n > 4 { -1f64 } else { 1f64 };
                    if moved == 1 {
                        // Empty container placeholder.
                        nums.push(if sign < 0.0 { Value::Object(Map::new()) } else { Value::Array(Vec::new()) });
                    } else {
                        let mantissa = read_dint(r, prev, &mut cache)?;
                        prev = mantissa;
                        let val = (mantissa as f64) / pow10(moved - 1) * sign;
                        nums.push(make_float(val));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(nums)
}

fn vt_num_tag(vt: &VType) -> u8 {
    match vt {
        VType::IntPos => 4,
        VType::IntNeg => 5,
        VType::Float  => 6,
        VType::SpliceReplace { typ, .. } if *typ == 4 || *typ == 5 || *typ == 6 => *typ,
        _ => 0,
    }
}

/// Read one dint value, consulting/updating the RLE cache.
fn read_dint(
    r:     &mut BitReader<'_>,
    prev:  i64,
    cache: &mut Option<(usize, i64, bool)>,
) -> Result<i64, String> {
    // Drain cache first.
    if let Some((ref mut rem, delta, is_diff)) = *cache {
        let val = if is_diff { prev.wrapping_add(delta) } else { delta };
        *rem -= 1;
        if *rem == 0 { *cache = None; }
        return Ok(val);
    }

    let x    = r.read(2)?;
    let diff = x == 0;
    let n: i64 = if x == 3 {
        r.leb128()? as i64
    } else {
        let bits = if x == 2 { 6 } else if x == 1 { 4 } else { 3 };
        r.read(bits)? as i64
    };

    // RLE trigger: diff=true AND n=7.
    if diff && n == 7 {
        let count = r.short()? as usize;
        let x2    = r.read(2)?;
        let diff2 = x2 == 0;
        let base: i64 = if x2 == 3 {
            r.leb128()? as i64
        } else {
            let bits = if x2 == 0 { 3 } else if x2 == 1 { 4 } else { 6 };
            r.read(bits)? as i64
        };
        let (delta, first) = if diff2 {
            let d = if base > 3 { -(base - 3) } else { base };
            (d, prev.wrapping_add(d))
        } else {
            (base, base)
        };
        if count > 1 { *cache = Some((count - 1, delta, diff2)); }
        return Ok(first);
    }

    if diff {
        let d = if n > 3 { -(n - 3) } else { n };
        Ok(prev.wrapping_add(d))
    } else {
        Ok(n)
    }
}

// ── vals (string values) ─────────────────────────────────────────────────────

fn read_strs(r: &mut BitReader<'_>, vtypes: &[VType]) -> Result<Vec<StrEntry>, String> {
    let mut strs = Vec::new();
    let mut dc   = 0usize;

    for vt in vtypes {
        let t = vt_str_type(vt);
        if t == 0 { continue; }
        let len = r.short()?;
        if t == 2 && len == 0 {
            if r.read(1)? == 0 {
                strs.push(StrEntry::StrmapRef(r.short()?));
            } else {
                strs.push(StrEntry::StrDiffRef(dc)); dc += 1;
            }
        } else {
            let n = len as usize;
            strs.push(StrEntry::Literal(if t == 7 { read_leb_str(r, n)? } else { read_b64_str(r, n)? }));
        }
    }
    Ok(strs)
}

fn vt_str_type(vt: &VType) -> u8 {
    match vt {
        VType::StrB64  => 2,
        VType::StrFall => 7,
        VType::SpliceReplace { typ, .. } => *typ,
        _ => 0,
    }
}

// ── string helpers ────────────────────────────────────────────────────────────

fn read_b64_str(r: &mut BitReader<'_>, len: usize) -> Result<String, String> {
    let mut s = String::with_capacity(len);
    for _ in 0..len { s.push(base64url_char(r.read(6)?) as char); }
    Ok(s)
}

fn read_leb_str(r: &mut BitReader<'_>, len: usize) -> Result<String, String> {
    let mut s = String::with_capacity(len);
    let mut i = 0;
    while i < len {
        let cu = r.leb128()? as u32;
        i += 1;
        // Handle UTF-16 surrogate pairs emitted by the JS encoder.
        if (0xD800..0xDC00).contains(&cu) {
            let low = r.leb128()? as u32;
            i += 1;
            let cp = 0x10000 + ((cu - 0xD800) << 10) + (low - 0xDC00);
            s.push(char::from_u32(cp).ok_or_else(|| format!("bad surrogate pair {cu:#x}+{low:#x}"))?);
        } else {
            s.push(char::from_u32(cu).ok_or_else(|| format!("bad cp {cu}"))?);
        }
    }
    Ok(s)
}

// ── build strmap ──────────────────────────────────────────────────────────────
//
// Walk every vref's kref chain (root-to-leaf) and add string keys and string
// values to strmap in encounter order.  Matches JS buildStrMap() with
// initial_count=0 (plus2=1, offset=2).

fn build_strmap(cols: &mut Cols) {
    // Traversal: [(is_kref, index)] where index is 0-based into krefs/vrefs.
    let mut trav: Vec<(bool, usize)> = Vec::new();
    let mut seen  = vec![false; cols.krefs.len()];
    let mut stack = Vec::new();

    for vi in 0..cols.vrefs.len() {
        let v = cols.vrefs[vi];
        // kref-array index = node_value - 2
        let mut kid = v.checked_sub(2).map(|x| x as usize).unwrap_or(usize::MAX);
        stack.clear();
        while kid < cols.krefs.len() && !seen[kid] {
            seen[kid] = true;
            stack.push(kid);
            let parent_val = cols.krefs[kid];
            kid = parent_val.checked_sub(2).map(|x| x as usize).unwrap_or(usize::MAX);
        }
        for &k in stack.iter().rev() { trav.push((true, k)); }
        trav.push((false, vi));
    }

    let mut next_idx: usize = 0;
    let mut str_rev:  HashMap<String, usize> = HashMap::new();
    let mut sc = 0usize;

    let to_map = |s: &str,
                  strmap: &mut HashMap<usize, String>,
                  str_rev: &mut HashMap<String, usize>,
                  next_idx: &mut usize|
    {
        if !str_rev.contains_key(s) {
            str_rev.insert(s.to_string(), *next_idx);
            strmap.insert(*next_idx, s.to_string());
            *next_idx += 1;
        }
    };

    for (is_kref, idx) in &trav {
        if *is_kref {
            // keys[kref_node_value - 1] = keys[(idx+2) - 1] = keys[idx + 1]
            if let Some(KeyEntry::StrKey(s)) = cols.keys.get(idx + 1) {
                let s = s.clone();
                to_map(&s, &mut cols.strmap, &mut str_rev, &mut next_idx);
            }
        } else {
            let t = vt_str_type(cols.vtypes.get(*idx).unwrap_or(&VType::Undefined));
            if t == 2 || t == 7 {
                if let Some(StrEntry::Literal(s)) = cols.strs.get(sc) {
                    let s = s.clone();
                    to_map(&s, &mut cols.strmap, &mut str_rev, &mut next_idx);
                }
                sc += 1;
            }
        }
    }
}

// ── build tree ────────────────────────────────────────────────────────────────

fn build_tree(cols: &Cols) -> Result<Value, String> {
    if cols.vrefs.is_empty() {
        return get_primitive(0, cols, &mut 0, &mut 0, &mut 0);
    }

    let mut root: Value = Value::Null;
    let mut arr_init: HashMap<u64, bool> = HashMap::new();
    let mut obj_init: HashMap<u64, bool> = HashMap::new();
    let mut nc = 0usize;
    let mut bc = 0usize;
    let mut sc = 0usize;

    for vi in 0..cols.vrefs.len() {
        let v   = cols.vrefs[vi];
        let val = get_primitive(vi, cols, &mut nc, &mut bc, &mut sc)?;
        let path = resolve_path(v, cols);
        nav(&mut root, &path, 0, val, cols, &mut arr_init, &mut obj_init)?;
    }
    Ok(root)
}

// ── path resolution ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Step {
    Root,
    ArrNode(u64),       // array container
    ObjNode(u64),       // object container
    StrKey(u64, String), // object string key (literal or resolved from strmap)
}

fn resolve_path(vref_val: u64, cols: &Cols) -> Vec<Step> {
    let mut chain: Vec<u64> = Vec::new();
    let mut cur = vref_val;
    loop {
        chain.push(cur);
        if cur > 1 {
            if let Some(&p) = cols.krefs.get((cur - 2) as usize) {
                if p > 0 { cur = p; continue; }
            }
        }
        break;
    }
    let mut steps = Vec::with_capacity(chain.len());
    for &ci in chain.iter().rev() {
        let key_idx = ci.saturating_sub(1) as usize;
        steps.push(match cols.keys.get(key_idx) {
            None                          => Step::Root,
            Some(KeyEntry::ArrIdx(_))     => Step::ArrNode(ci),
            Some(KeyEntry::ObjMarker(_))  => Step::ObjNode(ci),
            Some(KeyEntry::StrKey(s))     => Step::StrKey(ci, s.clone()),
            Some(KeyEntry::StrmapRef(idx)) => {
                let s = cols.strmap.get(&(*idx as usize)).cloned().unwrap_or_default();
                Step::StrKey(ci, s)
            }
        });
    }
    steps
}

// ── tree navigation/mutation ──────────────────────────────────────────────────

fn nav(
    node:     &mut Value,
    path:     &[Step],
    depth:    usize,
    val:      Value,
    cols:     &Cols,
    arr_init: &mut HashMap<u64, bool>,
    obj_init: &mut HashMap<u64, bool>,
) -> Result<(), String> {
    let total = path.len();
    if total == 0 { *node = val; return Ok(()); }

    match &path[depth] {
        Step::Root => { *node = val; }

        Step::ArrNode(ci) => {
            if !node.is_array() {
                *node = Value::Array(Vec::new());
                arr_init.insert(*ci, true);
            }
            if depth == total - 1 {
                // Container values ([] or {}) are already created by the parent
                // navigation step; arr_push skips them (mirrors JS arr_push behaviour).
                if !matches!(val, Value::Array(_) | Value::Object(_)) {
                    node.as_array_mut().unwrap().push(val);
                }
                return Ok(());
            }
            // Ensure the child container exists as the last element.
            let next_ci = next_container_id(&path[depth + 1]);
            match &path[depth + 1] {
                Step::ArrNode(child_ci) => {
                    let arr = node.as_array_mut().unwrap();
                    if arr_init.get(child_ci).is_none() {
                        arr_init.insert(*child_ci, true);
                        arr.push(Value::Array(Vec::new()));
                    }
                    let last = arr.last_mut().unwrap();
                    nav(last, path, depth + 1, val, cols, arr_init, obj_init)?;
                }
                Step::ObjNode(child_ci) => {
                    let arr = node.as_array_mut().unwrap();
                    if obj_init.get(child_ci).is_none() {
                        obj_init.insert(*child_ci, true);
                        arr.push(Value::Object(Map::new()));
                    }
                    let last = arr.last_mut().unwrap();
                    nav(last, path, depth + 1, val, cols, arr_init, obj_init)?;
                }
                Step::StrKey(_, _) => {
                    // Descend into the last object element.
                    let arr  = node.as_array_mut().unwrap();
                    let last = arr.last_mut().ok_or("no last element for StrKey")?;
                    nav(last, path, depth + 1, val, cols, arr_init, obj_init)?;
                }
                Step::Root => { node.as_array_mut().unwrap().push(val); }
                _ => {}
            }
            let _ = next_ci; // suppress unused warning
        }

        Step::ObjNode(ci) => {
            if !node.is_object() {
                *node = Value::Object(Map::new());
                obj_init.insert(*ci, true);
            }
            if depth == total - 1 {
                // Container at leaf: the value IS the container placeholder.
                *node = val;
                return Ok(());
            }
            nav(node, path, depth + 1, val, cols, arr_init, obj_init)?;
        }

        Step::StrKey(_, key) => {
            if !node.is_object() { *node = Value::Object(Map::new()); }
            if depth == total - 1 {
                node.as_object_mut().unwrap().insert(key.clone(), val);
            } else {
                ensure_child(node, key, &path[depth + 1], arr_init, obj_init);
                let child = node.as_object_mut().unwrap().get_mut(key).unwrap();
                nav(child, path, depth + 1, val, cols, arr_init, obj_init)?;
            }
        }
    }
    Ok(())
}

fn next_container_id(step: &Step) -> u64 {
    match step {
        Step::ArrNode(ci) | Step::ObjNode(ci) | Step::StrKey(ci, _) => *ci,
        _ => 0,
    }
}

fn ensure_child(
    node:     &mut Value,
    key:      &str,
    next:     &Step,
    arr_init: &mut HashMap<u64, bool>,
    obj_init: &mut HashMap<u64, bool>,
) {
    let obj = match node.as_object_mut() { Some(o) => o, None => return };
    if !obj.contains_key(key) {
        let child = match next {
            Step::ArrNode(_) => Value::Array(Vec::new()),
            _ => Value::Object(Map::new()),
        };
        obj.insert(key.to_string(), child);
        match next {
            Step::ArrNode(ci) => { arr_init.insert(*ci, true); }
            Step::ObjNode(ci) => { obj_init.insert(*ci, true); }
            _ => {}
        }
    }
}

// ── primitive value extraction ────────────────────────────────────────────────

fn get_primitive(
    vi: usize, cols: &Cols,
    nc: &mut usize, bc: &mut usize, sc: &mut usize,
) -> Result<Value, String> {
    match cols.vtypes.get(vi).unwrap_or(&VType::Undefined) {
        VType::Null | VType::Undefined | VType::DeleteDelta | VType::MergeDelta => Ok(Value::Null),
        VType::Bool => {
            let b = *cols.bools.get(*bc).ok_or("bools exhausted")?;
            *bc += 1; Ok(Value::Bool(b))
        }
        VType::IntPos | VType::IntNeg | VType::Float => {
            let v = cols.nums.get(*nc).cloned().ok_or("nums exhausted")?;
            *nc += 1; Ok(v)
        }
        VType::StrB64 | VType::StrFall => {
            let e = cols.strs.get(*sc).cloned().ok_or("strs exhausted")?;
            *sc += 1; resolve_str(e, cols)
        }
        VType::SpliceReplace { typ, .. } => {
            let t = *typ;
            if t == 2 || t == 7 {
                let e = cols.strs.get(*sc).cloned().ok_or("strs exhausted")?;
                *sc += 1; resolve_str(e, cols)
            } else {
                get_primitive_by_tag(t, cols, nc, bc, sc)
            }
        }
        VType::SpliceDel { .. } => Ok(Value::Null),
    }
}

fn get_primitive_by_tag(
    t: u8, cols: &Cols, nc: &mut usize, bc: &mut usize, sc: &mut usize,
) -> Result<Value, String> {
    match t {
        1 => Ok(Value::Null),
        3 => { let b = *cols.bools.get(*bc).ok_or("bools exhausted")?; *bc += 1; Ok(Value::Bool(b)) }
        4 | 5 | 6 => { let v = cols.nums.get(*nc).cloned().ok_or("nums exhausted")?; *nc += 1; Ok(v) }
        2 | 7 => { let e = cols.strs.get(*sc).cloned().ok_or("strs exhausted")?; *sc += 1; resolve_str(e, cols) }
        _ => Ok(Value::Null),
    }
}

fn resolve_str(entry: StrEntry, cols: &Cols) -> Result<Value, String> {
    match entry {
        StrEntry::Literal(s) => Ok(Value::String(s)),
        StrEntry::StrmapRef(idx) => cols.strmap.get(&(idx as usize))
            .map(|s| Value::String(s.clone()))
            .ok_or_else(|| format!("strmap missing {idx}")),
        StrEntry::StrDiffRef(_) => Err("strdiff in snapshot not supported".into()),
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn make_float(v: f64) -> Value {
    serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
}

// ════════════════════════════════════════════════════════════════════════════
// Delta chain decoder
// ════════════════════════════════════════════════════════════════════════════

// ── bits helper ───────────────────────────────────────────────────────────────

fn bits(n: usize) -> usize {
    if n <= 1 { 1 } else { (u32::BITS - (n as u32).leading_zeros()) as usize }
}

// ── strdiff helpers ───────────────────────────────────────────────────────────

fn leb128_encode(v: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut v = v;
    loop {
        let mut b = (v & 0x7F) as u8;
        v >>= 7;
        if v != 0 { b |= 0x80; }
        bytes.push(b);
        if v == 0 { break; }
    }
    bytes
}

fn read_strdiff_bytes(r: &mut BitReader<'_>) -> Result<Vec<u8>, String> {
    let total_bits = r.leb128()?;
    let byte_count = ((total_bits + 7) / 8) as usize;
    let mut data = leb128_encode(total_bits);
    for _ in 0..byte_count {
        data.push(r.read(8)? as u8);
    }
    Ok(data)
}

fn leb128_decode(data: &[u8], offset: &mut usize) -> u64 {
    let mut val = 0u64;
    let mut shift = 0;
    loop {
        let b = data[*offset]; *offset += 1;
        val |= ((b & 0x7F) as u64) << shift;
        shift += 7;
        if b & 0x80 == 0 { break; }
    }
    val
}

fn apply_strdiff(original: &str, data: &[u8], strmap: &HashMap<usize, String>) -> String {
    if data.is_empty() { return original.to_string(); }
    let mut offset = 0;
    // Skip LEB128 prefix bytes.
    while offset < data.len() && data[offset] & 0x80 != 0 { offset += 1; }
    if offset >= data.len() { return original.to_string(); }
    offset += 1; // last LEB128 byte
    if offset >= data.len() { return original.to_string(); }
    let op_count = data[offset] as usize; offset += 1;

    let chars: Vec<char> = original.chars().collect();
    enum Op { Delete { pos: usize, len: usize }, Insert { pos: usize, s: String } }
    let mut ops: Vec<Op> = Vec::with_capacity(op_count);

    for _ in 0..op_count {
        if offset >= data.len() { break; }
        let flags = data[offset]; offset += 1;
        let op_type = (flags >> 7) & 1;
        let has_ref = (flags >> 6) & 1;
        let pos = leb128_decode(data, &mut offset) as usize;
        if op_type == 0 {
            let len = leb128_decode(data, &mut offset) as usize;
            ops.push(Op::Delete { pos, len });
        } else if has_ref != 0 {
            let idx = leb128_decode(data, &mut offset) as usize;
            let s = strmap.get(&idx).cloned().unwrap_or_default();
            ops.push(Op::Insert { pos, s });
        } else {
            let length = leb128_decode(data, &mut offset) as usize;
            let s: String = data[offset..offset + length].iter().map(|&b| b as char).collect();
            offset += length;
            ops.push(Op::Insert { pos, s });
        }
    }
    ops.sort_by_key(|op| match op { Op::Delete { pos, .. } | Op::Insert { pos, .. } => *pos });

    let mut result: Vec<char> = Vec::with_capacity(chars.len());
    let mut orig_pos = 0usize;
    for op in &ops {
        match op {
            Op::Delete { pos, len } => {
                if *pos > orig_pos { result.extend_from_slice(&chars[orig_pos..*pos]); }
                orig_pos = pos + len;
            }
            Op::Insert { pos, s } => {
                if *pos > orig_pos { result.extend_from_slice(&chars[orig_pos..*pos]); }
                result.extend(s.chars());
                orig_pos = *pos;
            }
        }
    }
    result.extend_from_slice(&chars[orig_pos..]);
    result.into_iter().collect()
}

// ── chain context ─────────────────────────────────────────────────────────────

pub struct ChainContext {
    pub krefs:  Vec<u64>,
    pub keys:   Vec<KeyEntry>,
    pub strmap: HashMap<usize, String>,
}

// ── generalized vrefs/krefs readers (supports initial_cbits > 1) ─────────────

fn read_vrefs_cbits(
    r: &mut BitReader<'_>,
    vflags: &[u8],
    initial_cbits: usize,
) -> Result<(Vec<u64>, u64), String> {
    let mut vrefs   = Vec::with_capacity(vflags.len());
    let mut key_len = 0u64;
    let mut prev    = 0u64;
    let mut cbits   = initial_cbits;
    let mut i       = 0;
    while i < vflags.len() {
        let diff = vflags[i] == 1;
        if diff {
            let raw = r.read(3)?;
            if raw == 0 {
                let run = r.short()? as usize;
                let rv  = r.read(3)?;
                let rs  = i;
                for j in 0..run {
                    let (v, np) = apply_vlink(vflags[rs + j] == 1, rv, prev);
                    prev = np; vrefs.push(v);
                    if v > key_len { key_len = v; }
                    i += 1;
                }
            } else {
                let (v, np) = apply_vlink(true, raw, prev);
                prev = np; vrefs.push(v);
                if v > key_len { key_len = v; }
                i += 1;
            }
        } else {
            let mut raw = 0u64;
            loop { raw = r.read(cbits)?; if raw != 0 { break; } cbits += 1; }
            let (v, np) = apply_vlink(false, raw, prev);
            prev = np; vrefs.push(v);
            if v > key_len { key_len = v; }
            i += 1;
        }
    }
    Ok((vrefs, key_len))
}

fn read_krefs_cbits(
    r: &mut BitReader<'_>,
    kflags: &[u8],
    initial_cbits: usize,
) -> Result<Vec<u64>, String> {
    let mut krefs = Vec::with_capacity(kflags.len());
    let mut prev  = 0u64;
    let mut cbits = initial_cbits;
    let mut i     = 0;
    while i < kflags.len() {
        let diff = kflags[i] == 1;
        if diff {
            let raw = r.read(3)?;
            if raw == 0 {
                let run = r.short()? as usize;
                let rv  = r.read(3)?;
                let rs  = i;
                for j in 0..run {
                    let (v, np) = apply_vlink(kflags[rs + j] == 1, rv, prev);
                    prev = np; krefs.push(v); i += 1;
                }
            } else {
                let (v, np) = apply_vlink(true, raw, prev);
                prev = np; krefs.push(v); i += 1;
            }
        } else {
            let mut raw = 0u64;
            loop { raw = r.read(cbits)?; if raw != 0 { break; } cbits += 1; }
            let (v, np) = apply_vlink(false, raw, prev);
            prev = np; krefs.push(v); i += 1;
        }
    }
    Ok(krefs)
}

// ── snapshot decode with chain context ───────────────────────────────────────

fn decode_structured_with_ctx(r: &mut BitReader<'_>) -> Result<(Value, ChainContext), String> {
    let rcount = r.short()? as usize;
    let vflags          = read_flag_col(r, rcount)?;
    let (vrefs, klen)   = read_vrefs(r, &vflags)?;
    let kflag_n         = if klen > 1 { (klen - 1) as usize } else { 0 };
    let kflags          = read_flag_col(r, kflag_n)?;
    let krefs           = read_krefs(r, &kflags)?;
    let ktype_n = if krefs.is_empty() && rcount == 0 { 0 } else { krefs.len() + 1 };
    let ktypes  = read_ktypes(r, ktype_n)?;
    let keys    = read_keys(r, &ktypes)?;
    let vtype_n = vrefs.len().max(1);
    let vtypes  = read_vtypes(r, vtype_n)?;
    let bools   = read_bools(r, &vtypes)?;
    let nums    = read_nums(r, &vtypes)?;
    let strs    = read_strs(r, &vtypes)?;
    let diff_count = strs.iter().filter(|s| matches!(s, StrEntry::StrDiffRef(_))).count();
    for _ in 0..diff_count {
        let bits_count = r.leb128()?;
        r.pos += ((bits_count + 7) / 8) as usize * 8;
    }
    let mut cols = Cols { vrefs, krefs: krefs.clone(), ktypes, keys: keys.clone(),
                          vtypes, bools, nums, strs, strmap: HashMap::new() };
    build_strmap(&mut cols);
    let val = build_tree(&cols)?;
    let ctx = ChainContext { krefs, keys, strmap: cols.strmap };
    Ok((val, ctx))
}

pub fn decode_snapshot_for_chain(data: &[u8]) -> Result<(Value, ChainContext), String> {
    let mut r = BitReader::new(data);
    if r.read(1)? == 1 {
        let val = decode_single(&mut r)?;
        Ok((val, ChainContext { krefs: vec![], keys: vec![], strmap: HashMap::new() }))
    } else {
        decode_structured_with_ctx(&mut r)
    }
}

// ── delta payload decode ──────────────────────────────────────────────────────

struct DeltaCols {
    vrefs:          Vec<u64>,
    vtypes:         Vec<VType>,
    bools:          Vec<bool>,
    nums:           Vec<Value>,
    strs:           Vec<StrEntry>,
    strdiff_bytes:  Vec<Vec<u8>>,
    combined_krefs: Vec<u64>,
    combined_keys:  Vec<KeyEntry>,
    strmap:         HashMap<usize, String>,
}

fn decode_delta_cols(r: &mut BitReader<'_>, base: &ChainContext) -> Result<(DeltaCols, ChainContext), String> {
    let base_len       = base.krefs.len();
    let initial_cbits  = if base_len > 0 { bits(base_len + 2) } else { 1 };

    let rcount = r.short()? as usize;
    let vflags = read_flag_col(r, rcount)?;
    let (vrefs, klen) = if initial_cbits == 1 {
        read_vrefs(r, &vflags)?
    } else {
        read_vrefs_cbits(r, &vflags, initial_cbits)?
    };

    let new_klen  = klen as i64 - 1 - base_len as i64;
    let kflag_n   = if new_klen > 0 { new_klen as usize } else { 0 };
    let kflags    = read_flag_col(r, kflag_n)?;
    let new_krefs = if initial_cbits == 1 {
        read_krefs(r, &kflags)?
    } else {
        read_krefs_cbits(r, &kflags, initial_cbits)?
    };

    let ktype_n    = new_krefs.len(); // delta: no +1 for root
    let ktypes_raw = read_ktypes(r, ktype_n)?;
    let new_keys   = read_keys(r, &ktypes_raw)?;

    let vtype_n = vrefs.len().max(1);
    let vtypes  = read_vtypes(r, vtype_n)?;
    let bools   = read_bools(r, &vtypes)?;
    let nums    = read_nums(r, &vtypes)?;
    let strs    = read_strs(r, &vtypes)?;

    // Read strdiff payloads (skip in snapshot; save in delta).
    let mut strdiff_bytes: Vec<Vec<u8>> = Vec::new();
    for s in &strs {
        if matches!(s, StrEntry::StrDiffRef(_)) {
            strdiff_bytes.push(read_strdiff_bytes(r)?);
        }
    }

    let combined_krefs: Vec<u64>    = base.krefs.iter().cloned().chain(new_krefs.iter().cloned()).collect();
    let combined_keys: Vec<KeyEntry> = base.keys.iter().cloned().chain(new_keys.iter().cloned()).collect();

    // Build strmap for delta: base strings + new literal string values in vtypes order.
    let mut strmap = base.strmap.clone();
    let mut str_rev: HashMap<String, usize> = strmap.iter().map(|(&k, v)| (v.clone(), k)).collect();
    let mut next_idx = strmap.len();
    let mut sc = 0usize;
    for vt in &vtypes {
        let t = vt_str_type(vt);
        if t == 2 || t == 7 {
            if let Some(StrEntry::Literal(s)) = strs.get(sc) {
                if !str_rev.contains_key(s) {
                    str_rev.insert(s.clone(), next_idx);
                    strmap.insert(next_idx, s.clone());
                    next_idx += 1;
                }
            }
            sc += 1;
        }
    }

    let new_ctx = ChainContext {
        krefs:  combined_krefs.clone(),
        keys:   combined_keys.clone(),
        strmap: strmap.clone(),
    };
    Ok((DeltaCols { vrefs, vtypes, bools, nums, strs, strdiff_bytes, combined_krefs, combined_keys, strmap }, new_ctx))
}

// ── path resolution (combined krefs/keys) ────────────────────────────────────

fn resolve_path_combined(
    vref_val:      u64,
    combined_krefs: &[u64],
    combined_keys:  &[KeyEntry],
    strmap:         &HashMap<usize, String>,
) -> Vec<Step> {
    let mut chain: Vec<u64> = Vec::new();
    let mut cur = vref_val;
    loop {
        chain.push(cur);
        if cur > 1 {
            if let Some(&p) = combined_krefs.get((cur - 2) as usize) {
                if p > 0 { cur = p; continue; }
            }
        }
        break;
    }
    let mut steps = Vec::with_capacity(chain.len());
    for &ci in chain.iter().rev() {
        let key_idx = ci.saturating_sub(1) as usize;
        steps.push(match combined_keys.get(key_idx) {
            None                           => Step::Root,
            Some(KeyEntry::ArrIdx(_))      => Step::ArrNode(ci),
            Some(KeyEntry::ObjMarker(_))   => Step::ObjNode(ci),
            Some(KeyEntry::StrKey(s))      => Step::StrKey(ci, s.clone()),
            Some(KeyEntry::StrmapRef(idx)) => {
                let s = strmap.get(&(*idx as usize)).cloned().unwrap_or_default();
                Step::StrKey(ci, s)
            }
        });
    }
    steps
}

// ── delta operations ──────────────────────────────────────────────────────────

enum DeltaOp {
    Set(Value),
    Delete,
    SpliceDel  { idx: usize, rem: usize },
    SpliceRep  { idx: usize, rem: usize, val: Value },
    StrDiff    { diff_bytes: Vec<u8>, strmap: HashMap<usize, String> },
}

fn nav_apply_delta(
    node:  &mut Value,
    steps: &[Step],
    depth: usize,
    op:    DeltaOp,
) -> Result<(), String> {
    let total = steps.len();
    if depth >= total {
        apply_delta_op_here(node, op);
        return Ok(());
    }
    match &steps[depth] {
        Step::Root | Step::ObjNode(_) | Step::ArrNode(_) => {
            if depth == total - 1 {
                apply_delta_op_here(node, op);
            } else {
                nav_apply_delta(node, steps, depth + 1, op)?;
            }
        }
        Step::StrKey(_, key) => {
            if depth == total - 1 {
                apply_delta_op_at_key(node, key, op);
            } else {
                let key = key.clone();
                if let Some(obj) = node.as_object_mut() {
                    if !obj.contains_key(&key) {
                        obj.insert(key.clone(), Value::Object(Map::new()));
                    }
                    let child = obj.get_mut(&key).unwrap();
                    nav_apply_delta(child, steps, depth + 1, op)?;
                }
            }
        }
    }
    Ok(())
}

fn apply_delta_op_here(node: &mut Value, op: DeltaOp) {
    match op {
        DeltaOp::Set(val) => *node = val,
        DeltaOp::Delete   => {}
        DeltaOp::SpliceDel { idx, rem } => {
            if let Some(arr) = node.as_array_mut() {
                let end = (idx + rem).min(arr.len());
                arr.drain(idx..end);
            }
        }
        DeltaOp::SpliceRep { idx, rem, val } => {
            if let Some(arr) = node.as_array_mut() {
                let end = (idx + rem).min(arr.len());
                arr.drain(idx..end);
                arr.insert(idx, val);
            }
        }
        DeltaOp::StrDiff { diff_bytes, strmap } => {
            if let Some(s) = node.as_str().map(|s| s.to_string()) {
                *node = Value::String(apply_strdiff(&s, &diff_bytes, &strmap));
            }
        }
    }
}

fn apply_delta_op_at_key(node: &mut Value, key: &str, op: DeltaOp) {
    if !node.is_object() { *node = Value::Object(Map::new()); }
    let obj = node.as_object_mut().unwrap();
    match op {
        DeltaOp::Set(val) => { obj.insert(key.to_string(), val); }
        DeltaOp::Delete   => { obj.remove(key); }
        DeltaOp::SpliceDel { idx, rem } => {
            if let Some(arr) = obj.get_mut(key).and_then(|v| v.as_array_mut()) {
                let end = (idx + rem).min(arr.len());
                arr.drain(idx..end);
            }
        }
        DeltaOp::SpliceRep { idx, rem, val } => {
            if let Some(arr) = obj.get_mut(key).and_then(|v| v.as_array_mut()) {
                let end = (idx + rem).min(arr.len());
                arr.drain(idx..end);
                arr.insert(idx, val);
            }
        }
        DeltaOp::StrDiff { diff_bytes, strmap } => {
            let old = obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string());
            if let Some(s) = old {
                let new_s = apply_strdiff(&s, &diff_bytes, &strmap);
                obj.insert(key.to_string(), Value::String(new_s));
            }
        }
    }
}

fn get_delta_splice_val(
    typ: u8, delta: &DeltaCols, nc: &mut usize, bc: &mut usize, sc: &mut usize,
) -> Result<Value, String> {
    match typ {
        1 => Ok(Value::Null),
        2 | 7 => {
            let e = delta.strs.get(*sc).cloned().ok_or("strs exhausted")?;
            *sc += 1;
            match e {
                StrEntry::Literal(s)   => Ok(Value::String(s)),
                StrEntry::StrmapRef(i) => Ok(Value::String(delta.strmap.get(&(i as usize)).cloned().unwrap_or_default())),
                StrEntry::StrDiffRef(_) => Err("strdiff in splice_rep value".into()),
            }
        }
        3 => { let b = *delta.bools.get(*bc).ok_or("bools exhausted")?; *bc += 1; Ok(Value::Bool(b)) }
        4 | 5 | 6 => { let v = delta.nums.get(*nc).cloned().ok_or("nums exhausted")?; *nc += 1; Ok(v) }
        _ => Ok(Value::Null),
    }
}

fn apply_delta_ops(root: &mut Value, delta: &DeltaCols) -> Result<(), String> {
    let mut nc = 0usize;
    let mut bc = 0usize;
    let mut sc = 0usize;

    for (vi, &vref) in delta.vrefs.iter().enumerate() {
        let vt = delta.vtypes.get(vi).unwrap_or(&VType::Undefined).clone();
        let steps = resolve_path_combined(vref, &delta.combined_krefs, &delta.combined_keys, &delta.strmap);

        let op = match vt {
            VType::DeleteDelta => DeltaOp::Delete,
            VType::Null | VType::Undefined | VType::MergeDelta => DeltaOp::Set(Value::Null),
            VType::Bool => {
                let b = *delta.bools.get(bc).ok_or("bools exhausted")?;
                bc += 1;
                DeltaOp::Set(Value::Bool(b))
            }
            VType::IntPos | VType::IntNeg | VType::Float => {
                let v = delta.nums.get(nc).cloned().ok_or("nums exhausted")?;
                nc += 1;
                DeltaOp::Set(v)
            }
            VType::StrB64 | VType::StrFall => {
                let entry = delta.strs.get(sc).cloned().ok_or("strs exhausted")?;
                sc += 1;
                match entry {
                    StrEntry::StrDiffRef(diff_idx) => {
                        let diff_bytes = delta.strdiff_bytes.get(diff_idx).cloned().unwrap_or_default();
                        DeltaOp::StrDiff { diff_bytes, strmap: delta.strmap.clone() }
                    }
                    StrEntry::Literal(s) => DeltaOp::Set(Value::String(s)),
                    StrEntry::StrmapRef(idx) => {
                        let s = delta.strmap.get(&(idx as usize)).cloned().unwrap_or_default();
                        DeltaOp::Set(Value::String(s))
                    }
                }
            }
            VType::SpliceDel { index, remove } => DeltaOp::SpliceDel {
                idx: index as usize,
                rem: remove as usize,
            },
            VType::SpliceReplace { index, remove, typ } => {
                let val = get_delta_splice_val(typ, delta, &mut nc, &mut bc, &mut sc)?;
                DeltaOp::SpliceRep { idx: index as usize, rem: remove as usize, val }
            }
        };

        nav_apply_delta(root, &steps, 0, op)?;
    }
    Ok(())
}

// ── public chain API ──────────────────────────────────────────────────────────

pub fn parse_chain(data: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut payloads = Vec::new();
    let mut offset   = 0usize;
    while offset < data.len() {
        let mut length = 0usize;
        let mut shift  = 0u32;
        loop {
            if offset >= data.len() { return Err("truncated LEB128 in chain".into()); }
            let b = data[offset]; offset += 1;
            length |= ((b & 0x7F) as usize) << shift;
            shift  += 7;
            if b & 0x80 == 0 { break; }
        }
        if offset + length > data.len() { return Err("truncated payload in chain".into()); }
        payloads.push(data[offset..offset + length].to_vec());
        offset += length;
    }
    Ok(payloads)
}

pub fn decode_chain(data: &[u8]) -> Result<Value, String> {
    let payloads = parse_chain(data)?;
    if payloads.is_empty() { return Ok(Value::Null); }

    let (mut root, mut ctx) = decode_snapshot_for_chain(&payloads[0])?;

    for payload in &payloads[1..] {
        let mut r = BitReader::new(payload);
        let is_single = r.read(1)? == 1;
        if is_single {
            // Re-anchor: single-value payload replaces the entire root.
            root = decode_single(&mut r)?;
            ctx  = ChainContext { krefs: vec![], keys: vec![], strmap: HashMap::new() };
        } else {
            let (delta, new_ctx) = decode_delta_cols(&mut r, &ctx)?;
            apply_delta_ops(&mut root, &delta)?;
            ctx = new_ctx;
        }
    }
    Ok(root)
}
