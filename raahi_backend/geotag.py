"""
The other half of EXIF: writing it.

`exif.py` reads the position out of a photograph a phone took. This module
puts one in — because the frame that comes off a webcam, or off the camera
inside the app, has no EXIF at all. A phone stamps the fix into the file at
the moment the shutter fires; a browser canvas does not, and the position
would otherwise live only in our database, detached from the pixels.

So when a crack triggers the shutter, the server writes the fix straight
into the file's own hidden metadata before storing it:

    GPSLatitude / GPSLatitudeRef      where
    GPSLongitude / GPSLongitudeRef
    GPSAltitude / GPSAltitudeRef
    GPSImgDirection                   which way the camera was pointing
    GPSTimeStamp / GPSDateStamp       when, in UTC, off the satellite clock
    GPSHPositioningError              how much to trust it, in metres
    DateTimeOriginal                  when, on the camera's own clock

After that the photograph carries its own evidence. Copy it out of
`data/photos/`, open it in any EXIF viewer, and the coordinates are there —
the record and the pixels cannot drift apart, which is the whole point of a
file a municipality may one day have to defend.

JPEG (APP1 segment) and PNG (eXIf chunk) are written. Anything else is
returned untouched and reported as untouched — never silently.

Pure standard library. The bytes are assembled by hand.
"""

import struct
from datetime import datetime, timezone

# EXIF value formats
BYTE, ASCII, SHORT, LONG, RATIONAL = 1, 2, 3, 4, 5

WRITABLE = ("jpeg", "png")


def _ascii(text):
    return str(text).encode("utf-8", "replace") + b"\x00"


def _rational(value, denominator=10000):
    """One unsigned rational. The denominator sets the precision kept."""
    return struct.pack("<II", int(round(float(value) * denominator)), denominator)


def _rationals(values, denominator=10000):
    return b"".join(_rational(v, denominator) for v in values)


def _dms(value):
    """Signed decimal degrees -> the three rationals EXIF stores."""
    value = abs(float(value))
    degrees = int(value)
    minutes = int((value - degrees) * 60)
    seconds = (value - degrees - minutes / 60.0) * 3600.0
    return (struct.pack("<II", degrees, 1)
            + struct.pack("<II", minutes, 1)
            + struct.pack("<II", int(round(seconds * 10000)), 10000))


def _pad(payload):
    """Keep every pooled value on an even offset. Some readers insist."""
    return payload if len(payload) % 2 == 0 else payload + b"\x00"


def _ifd_bytes(entries):
    """Size an IFD without building it: 2-byte count, 12 per entry, 4 for next."""
    return 2 + 12 * len(entries) + 4


def _pool_bytes(entries):
    return sum(len(_pad(p)) for _, _, _, p in entries if len(p) > 4)


def _build_ifd(entries, data_offset):
    """
    entries: [(tag, format, count, payload)] -> (ifd_bytes, pool_bytes)

    Values of four bytes or fewer live inside the entry; anything longer is
    written to the pool and the entry holds its offset. That is the whole
    of the TIFF directory format, and doing it by hand is cheaper than a
    dependency the marker cannot install.
    """
    body = struct.pack("<H", len(entries))
    pool = b""
    cursor = data_offset
    for tag, fmt, count, payload in sorted(entries, key=lambda e: e[0]):
        if len(payload) <= 4:
            value = payload + b"\x00" * (4 - len(payload))
        else:
            value = struct.pack("<I", cursor)
            padded = _pad(payload)
            pool += padded
            cursor += len(padded)
        body += struct.pack("<HHI", tag, fmt, count) + value
    body += struct.pack("<I", 0)                # no IFD1, no thumbnail
    return body, pool


def build_exif(lat, lon, taken=None, heading=None, altitude_m=None,
               accuracy_m=None, focal_35mm=None, pixel_width=None,
               pixel_height=None, make="RAAHI", model="Round camera",
               software="RAAHI 3.0"):
    """
    Assemble a complete little-endian TIFF block: IFD0 -> Exif IFD + GPS IFD.

    `lat`/`lon` may be None — the block is then written without a GPS IFD,
    which is still worth doing for the capture time and the lens data.
    """
    taken = taken or datetime.now(timezone.utc)
    if taken.tzinfo is None:
        taken = taken.replace(tzinfo=timezone.utc)
    local_stamp = _ascii(taken.strftime("%Y:%m:%d %H:%M:%S"))
    utc = taken.astimezone(timezone.utc)

    ifd0 = [
        (0x010F, ASCII, len(_ascii(make)), _ascii(make)),
        (0x0110, ASCII, len(_ascii(model)), _ascii(model)),
        (0x0131, ASCII, len(_ascii(software)), _ascii(software)),
        (0x0132, ASCII, len(local_stamp), local_stamp),
    ]

    sub = [
        (0x9003, ASCII, len(local_stamp), local_stamp),     # DateTimeOriginal
        (0x9004, ASCII, len(local_stamp), local_stamp),     # DateTimeDigitized
    ]
    if focal_35mm:
        sub.append((0xA405, SHORT, 1, struct.pack("<H", int(round(float(focal_35mm))))))
        # A phone's real focal length is roughly its 35 mm equivalent over the
        # crop factor. 7.5 is the usual figure for a phone-sized sensor, and
        # it is only ever a fallback: a real photo brings its own.
        sub.append((0x920A, RATIONAL, 1, _rational(float(focal_35mm) / 7.5, 100)))
    if pixel_width:
        sub.append((0xA002, LONG, 1, struct.pack("<I", int(pixel_width))))
    if pixel_height:
        sub.append((0xA003, LONG, 1, struct.pack("<I", int(pixel_height))))

    gps = []
    if lat is not None and lon is not None:
        gps = [
            (0x0000, BYTE, 4, b"\x02\x03\x00\x00"),         # GPSVersionID 2.3.0.0
            (0x0001, ASCII, 2, b"N\x00" if lat >= 0 else b"S\x00"),
            (0x0002, RATIONAL, 3, _dms(lat)),
            (0x0003, ASCII, 2, b"E\x00" if lon >= 0 else b"W\x00"),
            (0x0004, RATIONAL, 3, _dms(lon)),
            # The satellite clock is UTC by definition, and stored split in
            # two: a time of day, and a date beside it.
            (0x0007, RATIONAL, 3, _rationals([utc.hour, utc.minute,
                                              utc.second + utc.microsecond / 1e6], 1000)),
            (0x001D, ASCII, 11, _ascii(utc.strftime("%Y:%m:%d"))),
        ]
        if altitude_m is not None:
            below = 1 if float(altitude_m) < 0 else 0
            gps.append((0x0005, BYTE, 1, bytes([below])))
            gps.append((0x0006, RATIONAL, 1, _rational(abs(float(altitude_m)), 100)))
        if heading is not None:
            gps.append((0x0010, ASCII, 2, b"T\x00"))        # true north, not magnetic
            gps.append((0x0011, RATIONAL, 1, _rational(float(heading) % 360.0, 100)))
        if accuracy_m is not None:
            gps.append((0x001F, RATIONAL, 1, _rational(float(accuracy_m), 100)))

    # Offsets have to be known before IFD0 can point at the other two, and
    # every size here is fixed by the entry lists above, so lay it all out
    # first and build afterwards.
    ifd0_at = 8
    pointers = 1 + (1 if gps else 0)
    ifd0_size = _ifd_bytes(ifd0 + [None] * pointers)
    ifd0_pool_at = ifd0_at + ifd0_size
    sub_at = ifd0_pool_at + _pool_bytes(ifd0)
    sub_pool_at = sub_at + _ifd_bytes(sub)
    gps_at = sub_pool_at + _pool_bytes(sub)
    gps_pool_at = gps_at + _ifd_bytes(gps) if gps else gps_at

    ifd0.append((0x8769, LONG, 1, struct.pack("<I", sub_at)))
    if gps:
        ifd0.append((0x8825, LONG, 1, struct.pack("<I", gps_at)))

    ifd0_block, ifd0_pool = _build_ifd(ifd0, ifd0_pool_at)
    sub_block, sub_pool = _build_ifd(sub, sub_pool_at)
    gps_block, gps_pool = _build_ifd(gps, gps_pool_at) if gps else (b"", b"")

    return (b"II" + struct.pack("<HI", 42, ifd0_at)
            + ifd0_block + ifd0_pool + sub_block + sub_pool + gps_block + gps_pool)


# ---------------------------------------------------------------------------
#  Putting the block into a file
# ---------------------------------------------------------------------------
def kind_of(data: bytes) -> str:
    if data[:2] == b"\xff\xd8":
        return "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[4:8] == b"ftyp":
        return "heif"
    return "unknown"


def _write_jpeg(data: bytes, block: bytes) -> bytes:
    """
    Replace or insert the APP1 Exif segment, immediately after SOI.

    An existing Exif segment is dropped rather than merged: two APP1 Exif
    blocks in one file is a malformed JPEG, and the newer fix is the one we
    mean to keep.
    """
    payload = b"Exif\x00\x00" + block
    if len(payload) + 2 > 0xFFFF:
        raise ValueError("EXIF block too large for one APP1 segment")
    segment = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload

    out, i = bytearray(data[:2]), 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            break
        marker = data[i + 1]
        if marker == 0xDA:                       # start of scan: the rest is pixels
            break
        if 0xD0 <= marker <= 0xD9:
            i += 2
            continue
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        is_exif = marker == 0xE1 and data[i + 4:i + 10] == b"Exif\x00\x00"
        if not is_exif:
            out += data[i:i + 2 + seg_len]
        i += 2 + seg_len
    return bytes(out[:2]) + segment + bytes(out[2:]) + data[i:]


def _write_png(data: bytes, block: bytes) -> bytes:
    """Replace or insert the eXIf chunk, before the first IDAT."""
    import zlib

    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    out, i, inserted = bytearray(data[:8]), 8, False
    while i + 8 <= len(data):
        length = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        whole = data[i:i + 12 + length]
        if kind == b"eXIf":                      # drop the stale one
            i += 12 + length
            continue
        if kind == b"IDAT" and not inserted:
            out += chunk(b"eXIf", block)
            inserted = True
        out += whole
        i += 12 + length
    if not inserted:
        raise ValueError("PNG has no IDAT chunk")
    return bytes(out)


def geotag(data: bytes, lat, lon, taken=None, heading=None, altitude_m=None,
           accuracy_m=None, focal_35mm=None, pixel_width=None, pixel_height=None,
           make="RAAHI", model="Round camera") -> tuple:
    """
    Stamp a position into an image's own metadata.

    Returns `(bytes, note)`. On any file we cannot write — HEIC, WebP, a
    truncated JPEG — the original bytes come back with a note saying so.
    Losing the position quietly would be worse than not writing it.
    """
    kind = kind_of(data)
    if kind not in WRITABLE:
        return data, {"written": False, "format": kind,
                      "why": "%s files are stored as they arrived; "
                             "EXIF is only written into JPEG and PNG." % kind}
    if lat is None or lon is None:
        return data, {"written": False, "format": kind,
                      "why": "no position was known at the moment of capture"}
    try:
        block = build_exif(lat, lon, taken=taken, heading=heading,
                           altitude_m=altitude_m, accuracy_m=accuracy_m,
                           focal_35mm=focal_35mm, pixel_width=pixel_width,
                           pixel_height=pixel_height, make=make, model=model)
        out = _write_jpeg(data, block) if kind == "jpeg" else _write_png(data, block)
    except (ValueError, struct.error, IndexError) as err:
        return data, {"written": False, "format": kind, "why": str(err)}

    return out, {
        "written": True, "format": kind, "bytes_added": len(out) - len(data),
        "why": ("the position was written into the file's own EXIF at capture, "
                "the way a phone writes it when the shutter fires"),
        "tags": ["GPSLatitude", "GPSLongitude", "GPSImgDirection",
                 "GPSTimeStamp", "GPSDateStamp", "GPSHPositioningError",
                 "DateTimeOriginal"],
    }
