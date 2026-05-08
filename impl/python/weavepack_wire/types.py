"""weavepack-wire — type constants.

Profile isolation: this file imports nothing from other profiles.
"""


class VTYPE:
    BOOL    = 0
    INT32   = 1
    INT64   = 2
    UINT32  = 3
    UINT64  = 4
    SINT32  = 5
    SINT64  = 6
    FLOAT32 = 7
    FLOAT64 = 8
    STRING  = 9
    BYTES   = 10
    ENUM    = 11


class CTYPE:
    MESSAGE  = 0
    REPEATED = 1
    MAP      = 2
    ONEOF    = 3


class OP:
    FIELD_SET       = 0
    FIELD_DELETE    = 1
    MESSAGE_REPLACE = 2
    REPEATED_APPEND = 3
    REPEATED_SPLICE = 4
    MAP_SET         = 5
    MAP_DELETE      = 6
    ONEOF_SWITCH    = 7


class PC:
    FIELD = 0
    MAP   = 1
    INDEX = 2
    END   = 3


FLAG_SCHEMALESS = 0x00
FLAG_DELTA      = 0x01
FLAG_SCHEMAFUL  = 0x02

PROFILE_ID      = "wire"
PROFILE_VERSION = "0.1"

MAX_PAYLOAD_BYTES = 256 * 1024 * 1024


def scalar_tag(vtype: int) -> int:
    return vtype & 0x0F


def container_tag(ctype: int) -> int:
    return 0x10 | (ctype & 0x03)


def is_container(tag: int) -> bool:
    return (tag & 0x10) != 0


def get_vtype(tag: int) -> int:
    return tag & 0x0F


def get_ctype(tag: int) -> int:
    return tag & 0x03


TAG_MESSAGE  = container_tag(CTYPE.MESSAGE)
TAG_REPEATED = container_tag(CTYPE.REPEATED)
TAG_MAP      = container_tag(CTYPE.MAP)
TAG_ONEOF    = container_tag(CTYPE.ONEOF)
