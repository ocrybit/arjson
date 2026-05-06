// weavepack-tensor Python bindings (Phase 6.4).
//
// Exposes encode/decode/delta/schema operations to Python via PyO3.
// Profile isolation: this crate imports weavepack-tensor only.
//
// Python tensor representation:
//   (name: str, {"dtype": int, "shape": [int, ...], "data": bytes})
// Schema representation:
//   {name: str -> (dtype: int, shape: [int, ...])}

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList, PyTuple};
use std::collections::BTreeMap;
use weavepack_tensor::{SchemaEntry, TensorData};

// ── conversion helpers ────────────────────────────────────────────────────────

fn py_to_tensor(obj: &Bound<'_, PyAny>) -> PyResult<TensorData> {
    let dtype: u8 = obj.get_item("dtype")?.extract()?;
    let shape: Vec<u64> = obj.get_item("shape")?.extract()?;
    let data: Vec<u8> = obj.get_item("data")?.extract::<Vec<u8>>()?;
    Ok(TensorData { dtype, shape, data })
}

fn tensor_to_py<'py>(py: Python<'py>, t: &TensorData) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("dtype", t.dtype)?;
    dict.set_item("shape", t.shape.clone())?;
    dict.set_item("data", PyBytes::new(py, &t.data))?;
    Ok(dict)
}

fn py_to_tensors(list: &Bound<'_, PyAny>) -> PyResult<Vec<(String, TensorData)>> {
    let mut tensors = Vec::new();
    for item in list.try_iter()? {
        let item = item?;
        let tuple: &Bound<'_, PyTuple> = item.cast().map_err(|_| {
            PyValueError::new_err("tensors must be a list of (name, dict) tuples")
        })?;
        let name: String = tuple.get_item(0)?.extract()?;
        let tensor = py_to_tensor(&tuple.get_item(1)?)?;
        tensors.push((name, tensor));
    }
    Ok(tensors)
}

fn tensors_to_py<'py>(
    py: Python<'py>,
    tensors: Vec<(String, TensorData)>,
) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for (name, t) in tensors {
        let tensor_dict = tensor_to_py(py, &t)?;
        let name_obj = name.into_pyobject(py)?;
        let tuple = PyTuple::new(py, [name_obj.into_any(), tensor_dict.into_any()])?;
        list.append(tuple)?;
    }
    Ok(list)
}

fn py_to_schema(obj: &Bound<'_, PyDict>) -> PyResult<BTreeMap<String, SchemaEntry>> {
    let mut map = BTreeMap::new();
    for (k, v) in obj.iter() {
        let name: String = k.extract()?;
        let entry_dict: &Bound<'_, PyDict> = v.downcast().map_err(|_| {
            PyValueError::new_err("schema values must be dicts with 'dtype' and 'shape' keys")
        })?;
        let dtype: u8 = entry_dict
            .get_item("dtype")?
            .ok_or_else(|| PyValueError::new_err("schema entry missing 'dtype'"))?
            .extract()?;
        let shape: Vec<u64> = entry_dict
            .get_item("shape")?
            .ok_or_else(|| PyValueError::new_err("schema entry missing 'shape'"))?
            .extract()?;
        let scale: Option<f64> = entry_dict
            .get_item("scale")?
            .map(|v| v.extract::<f64>())
            .transpose()?;
        let zero_point: Option<i64> = entry_dict
            .get_item("zero_point")?
            .map(|v| v.extract::<i64>())
            .transpose()?;
        map.insert(name, SchemaEntry { dtype, shape, scale, zero_point });
    }
    Ok(map)
}

// ── public functions ──────────────────────────────────────────────────────────

/// Encode a schemaless tensor document.
///
/// tensors: list of (name: str, dict(dtype=int, shape=list[int], data=bytes))
/// Returns bytes.
#[pyfunction]
fn encode<'py>(py: Python<'py>, tensors: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyBytes>> {
    let ts = py_to_tensors(tensors)?;
    let bytes = weavepack_tensor::encode::encode_document(&ts);
    Ok(PyBytes::new(py, &bytes))
}

/// Decode a schemaless tensor document.
///
/// Returns list of (name: str, dict(dtype=int, shape=list[int], data=bytes)).
#[pyfunction]
fn decode<'py>(py: Python<'py>, data: &[u8]) -> PyResult<Bound<'py, PyList>> {
    let tensors = weavepack_tensor::decode::decode_document(data)
        .map_err(|e| PyValueError::new_err(e))?;
    tensors_to_py(py, tensors)
}

/// Encode a delta between two tensor document states.
///
/// Returns bytes, or None if the documents are identical.
#[pyfunction]
fn encode_delta<'py>(
    py: Python<'py>,
    before: &Bound<'py, PyAny>,
    after: &Bound<'py, PyAny>,
) -> PyResult<Option<Bound<'py, PyBytes>>> {
    let b = py_to_tensors(before)?;
    let a = py_to_tensors(after)?;
    match weavepack_tensor::delta::encode_delta(&b, &a) {
        Some(bytes) => Ok(Some(PyBytes::new(py, &bytes))),
        None => Ok(None),
    }
}

/// Apply a delta to a base document.
///
/// base: list of (name, dict) tuples (same format as decode() output)
/// delta_bytes: bytes from encode_delta()
/// Returns updated list of (name, dict) tuples.
#[pyfunction]
fn apply_delta<'py>(
    py: Python<'py>,
    base: &Bound<'py, PyAny>,
    delta_bytes: &[u8],
) -> PyResult<Bound<'py, PyList>> {
    let b = py_to_tensors(base)?;
    let result = weavepack_tensor::delta::apply_delta(&b, delta_bytes)
        .map_err(|e| PyValueError::new_err(e))?;
    tensors_to_py(py, result)
}

/// Compute the 32-byte SHA-256 schema hash.
///
/// schema: dict mapping name: str -> {dtype: int, shape: list[int], scale?: float, zero_point?: int}
/// Returns bytes (32 bytes).
#[pyfunction]
fn schema_hash<'py>(py: Python<'py>, schema: &Bound<'py, PyDict>) -> PyResult<Bound<'py, PyBytes>> {
    let map = py_to_schema(schema)?;
    let hash = weavepack_tensor::schema::schema_hash(&map);
    Ok(PyBytes::new(py, &hash))
}

/// Compute the hex-encoded SHA-256 schema hash.
///
/// schema: dict mapping name: str -> {dtype: int, shape: list[int], scale?: float, zero_point?: int}
/// Returns str (64 hex chars).
#[pyfunction]
fn schema_hash_hex(schema: &Bound<'_, PyDict>) -> PyResult<String> {
    let map = py_to_schema(schema)?;
    Ok(weavepack_tensor::schema::schema_hash_hex(&map))
}

/// Split a chain buffer into individual length-prefixed payloads.
///
/// Returns list[bytes].  Mirrors weavepack_tensor.parse_chain in the
/// pure-Python module and chain_parse in the Rust core crate.
#[pyfunction]
fn parse_chain<'py>(py: Python<'py>, data: &[u8]) -> PyResult<Bound<'py, PyList>> {
    let segments = weavepack_tensor::chain::chain_parse(data);
    let list = PyList::empty(py);
    for seg in segments {
        list.append(PyBytes::new(py, &seg))?;
    }
    Ok(list)
}

/// Serialize an iterable of payloads into a single chain buffer.
///
/// Each input must be a bytes-like object.
#[pyfunction]
fn serialize_chain<'py>(py: Python<'py>, payloads: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyBytes>> {
    let mut segments: Vec<Vec<u8>> = Vec::new();
    for item in payloads.try_iter()? {
        let item = item?;
        let bytes: Vec<u8> = item.extract()?;
        segments.push(bytes);
    }
    let buf = weavepack_tensor::chain::chain_serialize(&segments);
    Ok(PyBytes::new(py, &buf))
}

/// Validate a chain buffer against the "single anchor + deltas" rule.
///
/// Raises ValueError if any payload past position 0 is a standalone
/// anchor (mode bit = 1) or zero-length. Returns None on success.
/// Mirrors weavepack_tensor.validate_chain (pure Python) and
/// weavepack_core::chain::chain_validate (Rust).
#[pyfunction]
fn validate_chain(data: &[u8]) -> PyResult<()> {
    weavepack_tensor::chain::chain_validate(data).map_err(PyValueError::new_err)
}

// ── module ────────────────────────────────────────────────────────────────────

#[pymodule]
fn weavepack_tensor_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(encode, m)?)?;
    m.add_function(wrap_pyfunction!(decode, m)?)?;
    m.add_function(wrap_pyfunction!(encode_delta, m)?)?;
    m.add_function(wrap_pyfunction!(apply_delta, m)?)?;
    m.add_function(wrap_pyfunction!(schema_hash, m)?)?;
    m.add_function(wrap_pyfunction!(schema_hash_hex, m)?)?;
    m.add_function(wrap_pyfunction!(parse_chain, m)?)?;
    m.add_function(wrap_pyfunction!(serialize_chain, m)?)?;
    m.add_function(wrap_pyfunction!(validate_chain, m)?)?;
    m.add("__version__", "0.1.0")?;
    Ok(())
}
