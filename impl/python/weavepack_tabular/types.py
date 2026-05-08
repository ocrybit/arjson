"""weavepack-tabular — type constants.

Profile isolation: this file imports nothing from other profiles.
"""


class CTYPE:
    BOOL         = 0
    INT8         = 1
    INT16        = 2
    INT32        = 3
    INT64        = 4
    UINT8        = 5
    UINT16       = 6
    UINT32       = 7
    UINT64       = 8
    FLOAT32      = 9
    FLOAT64      = 10
    STRING       = 11
    BYTES        = 12
    DATE32       = 13
    TIMESTAMP64  = 14
    EXT          = 15


class OP:
    ROW_INSERT    = 0
    ROW_UPDATE    = 1
    ROW_DELETE    = 2
    COLUMN_ADD    = 3
    COLUMN_DROP   = 4
    COLUMN_RENAME = 5
    BATCH_UPSERT  = 6


FRAME_SNAPSHOT = 0x00
FRAME_DELTA    = 0x01

PROFILE_ID      = "tabular"
PROFILE_VERSION = "0.1"

SCHEMA_HASH_BYTES = 32

MAX_STRING_BYTES = 256 * 1024 * 1024
MAX_FRAME_BYTES  = 2 * 1024 * 1024 * 1024


def null_bitmap_bytes(num_rows: int) -> int:
    return (num_rows + 7) // 8


def get_null_bit(bitmap: bytearray, row_idx: int) -> bool:
    return bool((bitmap[row_idx >> 3] >> (7 - (row_idx & 7))) & 1)


def set_null_bit(bitmap: bytearray, row_idx: int):
    bitmap[row_idx >> 3] |= (1 << (7 - (row_idx & 7)))
