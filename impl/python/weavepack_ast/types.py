"""weavepack-ast — type constants.

Profile isolation: this file imports nothing from other profiles.
"""


class CTYPE:
    BOOL        = 0
    INT8        = 1
    INT16       = 2
    INT32       = 3
    INT64       = 4
    UINT8       = 5
    UINT16      = 6
    UINT32      = 7
    UINT64      = 8
    FLOAT32     = 9
    FLOAT64     = 10
    STRING      = 11
    BYTES       = 12
    DATE32      = 13
    TIMESTAMP64 = 14
    NODE_ID     = 15


class OP:
    NODE_INSERT     = 0
    NODE_DELETE     = 1
    NODE_MOVE       = 2
    PROP_SET        = 3
    KIND_RENAME     = 4
    SUBTREE_REPLACE = 5


class PATH_KIND:
    NODE           = 0
    NODE_COL       = 1
    NODE_KIND      = 2
    AT_NID         = 3
    AT_PARENT      = 4
    AT_CHILD_INDEX = 5
    AT_KIND        = 6
    NODE_PROP      = 7
    # 8–15 = reserved


BLOCK_TYPE_NODE  = 0x00
BLOCK_TYPE_MIXED = 0x01

AST_VERSION       = 1
PROFILE_NUM       = 7
SCHEMA_HASH_BYTES = 32
MAX_STRING_BYTES  = 1 * 1024 * 1024 * 1024


def null_bitmap_bytes(n: int) -> int:
    return (n + 7) // 8


def get_null_bit(bitmap: bytes, idx: int) -> bool:
    return bool((bitmap[idx >> 3] >> (7 - (idx & 7))) & 1)


def set_null_bit(bitmap: bytearray, idx: int):
    bitmap[idx >> 3] |= (1 << (7 - (idx & 7)))
