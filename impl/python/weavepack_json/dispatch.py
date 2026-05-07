"""weavepack v1.2 wire envelope dispatch.

See weavepack/rfcs/0002-explicit-profile-id.md

The 4-byte v1.2 magic header (prepended to every v1.2 payload):
  [0] 0x57  'W'
  [1] 0x50  'P'
  [2] 0x12   version byte: high nibble = major 1, low nibble = minor 2
  [3] <pid>  profile-id (PID["JSON"] = 0x00, PID["TENSOR"] = 0x01)

v1.x payloads (no header) remain valid — peek_header returns None for them;
callers treat absent headers as implicit JSON (RFC 0002 fallback rule).
"""

PID = {"JSON": 0x00, "TENSOR": 0x01}

_MAGIC_0 = 0x57  # 'W'
_MAGIC_1 = 0x50  # 'P'
VERSION_12 = 0x12


def wrap_payload(payload: bytes, profile_id: int) -> bytes:
    """Prepend the 4-byte v1.2 header to a profile-specific payload.

    Returns a new bytes object; the original payload is not modified.
    """
    return bytes([_MAGIC_0, _MAGIC_1, VERSION_12, profile_id]) + payload


def peek_header(data: bytes) -> dict | None:
    """Inspect raw bytes for a v1.2 magic header.

    Returns a dict {version, profile_id, payload} when the header is present.
    Returns None when there is no magic header (v1.x payload — caller should
    treat it as an implicit JSON payload per the RFC 0002 fallback rule).
    Raises ValueError when the magic bytes are present but the major version
    is unrecognised (anything other than 1 in the high nibble of byte 2).
    """
    if len(data) < 4 or data[0] != _MAGIC_0 or data[1] != _MAGIC_1:
        return None  # v1.x payload — no header
    version = data[2]
    major = version >> 4
    if major != 1:
        raise ValueError(f"unsupported weavepack major version {major}")
    profile_id = data[3]
    return {"version": version, "profile_id": profile_id, "payload": data[4:]}
