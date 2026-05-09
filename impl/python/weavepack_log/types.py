"""weavepack-log — type constants.

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
    EXT         = 15  # reserved
    LEVEL       = 16


class LEVEL:
    TRACE = 0
    DEBUG = 1
    INFO  = 2
    WARN  = 3
    ERROR = 4
    FATAL = 5


class OP:
    EVENT_APPEND      = 0
    FIELD_UPDATE      = 1
    EVENT_EXPIRE      = 2
    SCHEMA_EVOLVE     = 3
    CURSOR_CHECKPOINT = 4


class SCHEMA_SUB_OP:
    COLUMN_ADD    = 0
    COLUMN_DROP   = 1
    COLUMN_RENAME = 2


FRAME_SNAPSHOT      = 0x00
FRAME_DELTA         = 0x01
FRAME_STREAM_HEADER = 0x02

PROFILE_ID      = "log"
PROFILE_VERSION = "0.1"

SCHEMA_HASH_BYTES = 32
STREAM_ID_BYTES   = 16

MAX_STRING_BYTES = 256 * 1024 * 1024
MAX_FRAME_BYTES  = 2 * 1024 * 1024 * 1024


def null_bitmap_bytes(num_events: int) -> int:
    return (num_events + 7) // 8


def get_null_bit(bitmap: bytes, event_idx: int) -> bool:
    return bool((bitmap[event_idx >> 3] >> (7 - (event_idx & 7))) & 1)


def set_null_bit(bitmap: bytearray, event_idx: int):
    bitmap[event_idx >> 3] |= (1 << (7 - (event_idx & 7)))
