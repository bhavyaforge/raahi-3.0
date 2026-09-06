"""
EXIF reader — pure Python, no installs.

Pulls out the things RAAHI needs from a photo the user hands us:

    * where it was taken      (GPS latitude / longitude / altitude)
    * which way the camera was pointing (GPS image direction)
    * when the shutter fired  (DateTimeOriginal, GPS timestamp)
    * how wide the lens was   (focal length, 35 mm equivalent)

The focal length matters more than it looks. With it we can estimate
millimetres-per-pixel from the pinhole relation alone, so the person using
the app never has to calibrate anything by hand.

Handles JPEG (APP1 segment), PNG (eXIf chunk) and, by scanning for the same
Exif block, most HEIC/HEIF files that phones produce. A file with no EXIF
comes back empty rather than raising — the app then falls back to browser
geolocation.
"""

import struct
from datetime import datetime, timezone

# --- tag numbers we care about ----------------------------------------------
IFD0_TAGS = {
    0x010F: "make",
    0x0110: "model",
    0x0112: "orientation",
    0x8825: "_gps_ifd",
    0x8769: "_exif_ifd",
}

EXIF_TAGS = {
    0x9003: "taken_at_local",       # DateTimeOriginal
    0x9004: "created_at_local",     # DateTimeDigitized
    0x829A: "exposure_time",
    0x920A: "focal_length_mm",
    0xA405: "focal_length_35mm",
    0xA002: "pixel_width",
    0xA003: "pixel_height",
    0x9291: "subsec",
}

GPS_TAGS = {
    0x0000: "gps_version",
    0x0001: "_lat_ref",
    0x0002: "_lat",
    0x0003: "_lon_ref",
    0x0004: "_lon",
    0x0005: "_alt_ref",
    0x0006: "_alt",
    0x0007: "_gps_time",
    0x000B: "gps_dop",
    0x0010: "_dir_ref",
    0x0011: "_direction",
    0x001D: "_gps_date",
    0x001F: "gps_accuracy_m",       # GPSHPositioningError, metres
}

# EXIF value formats: code -> (bytes per component, struct letter)
FORMATS = {
    1: (1, "B"), 2: (1, "s"), 3: (2, "H"), 4: (4, "I"), 5: (8, "2I"),
    6: (1, "b"), 7: (1, "s"), 8: (2, "h"), 9: (4, "i"), 10: (8, "2i"),
    11: (4, "f"), 12: (8, "d"),
}


class ExifError(Exception):
    pass


def _find_tiff_block(data: bytes):
    """Return the offset of the TIFF header inside an image file, or None."""
    # Proper JPEG walk: SOI, then segment by segment until we hit APP1/Exif.
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 4 <= len(data):
            if data[i] != 0xFF:
                break
            marker = data[i + 1]
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            if marker == 0xDA:          # start of scan; no metadata past here
                break
            seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
            if marker == 0xE1 and data[i + 4:i + 10] == b"Exif\x00\x00":
                return i + 10
            i += 2 + seg_len
    # PNG keeps EXIF in an eXIf chunk, whose payload is the TIFF block itself.
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        i = 8
        while i + 8 <= len(data):
            length = struct.unpack(">I", data[i:i + 4])[0]
            kind = data[i + 4:i + 8]
            if kind == b"eXIf":
                return i + 8
            if kind == b"IDAT":       # pixel data starts; no metadata past here
                break
            i += 12 + length
        return None

    # HEIC/HEIF and anything else: the Exif block is in there somewhere.
    hit = data.find(b"Exif\x00\x00", 0, 4_000_000)
    if hit != -1:
        return hit + 6
    return None


def _read_ifd(data, tiff, offset, endian, table, out):
    """Read one IFD and drop its recognised tags into `out`."""
    if offset + 2 > len(data):
        return
    count = struct.unpack(endian + "H", data[offset:offset + 2])[0]
    for n in range(count):
        entry = offset + 2 + n * 12
        if entry + 12 > len(data):
            return
        tag, fmt, comps = struct.unpack(endian + "HHI", data[entry:entry + 8])
        if tag not in table or fmt not in FORMATS:
            continue
        size, letter = FORMATS[fmt]
        total = size * comps
        if total <= 4:
            raw = data[entry + 8:entry + 8 + total]
        else:
            ptr = struct.unpack(endian + "I", data[entry + 8:entry + 12])[0]
            raw = data[tiff + ptr:tiff + ptr + total]
        if len(raw) < total:
            continue

        name = table[tag]
        if fmt in (2, 7):                       # ASCII
            value = raw.split(b"\x00")[0].decode("utf-8", "replace").strip()
        elif fmt in (5, 10):                    # rational / signed rational
            nums = struct.unpack(endian + letter * comps, raw)
            pairs = [(nums[i], nums[i + 1]) for i in range(0, len(nums), 2)]
            vals = [(a / b) if b else 0.0 for a, b in pairs]
            value = vals[0] if comps == 1 else vals
        else:
            nums = struct.unpack(endian + letter * comps, raw)
            value = nums[0] if comps == 1 else list(nums)
        out[name] = value


def _dms_to_degrees(dms, ref):
    """[deg, min, sec] + N/S/E/W  ->  signed decimal degrees."""
    if not isinstance(dms, (list, tuple)) or len(dms) < 3:
        return None
    deg = dms[0] + dms[1] / 60.0 + dms[2] / 3600.0
    if str(ref).upper() in ("S", "W"):
        deg = -deg
    return round(deg, 8)


def _parse_exif_datetime(text):
    """EXIF writes '2026:09:06 07:41:22'. Return ISO-8601, or None."""
    if not text:
        return None
    try:
        return datetime.strptime(text.strip(), "%Y:%m:%d %H:%M:%S").isoformat()
    except ValueError:
        return None


def read(data: bytes) -> dict:
    """
    Extract what we need from raw image bytes.

    Never raises on a malformed file — a photo with no EXIF is a normal
    case, not an error, and the caller falls back to browser geolocation.
    """
    result = {
        "has_exif": False, "lat": None, "lon": None, "altitude_m": None,
        "direction_deg": None, "accuracy_m": None, "taken_at": None,
        "gps_time_utc": None, "make": None, "model": None,
        "focal_length_mm": None, "focal_length_35mm": None,
        "pixel_width": None, "pixel_height": None, "source": "none",
    }
    try:
        tiff = _find_tiff_block(data)
        if tiff is None or tiff + 8 > len(data):
            return result

        order = data[tiff:tiff + 2]
        if order == b"II":
            endian = "<"
        elif order == b"MM":
            endian = ">"
        else:
            return result

        magic, first = struct.unpack(endian + "HI", data[tiff + 2:tiff + 8])
        if magic != 42:
            return result

        flat = {}
        _read_ifd(data, tiff, tiff + first, endian, IFD0_TAGS, flat)

        if "_exif_ifd" in flat:
            _read_ifd(data, tiff, tiff + int(flat["_exif_ifd"]), endian, EXIF_TAGS, flat)
        if "_gps_ifd" in flat:
            _read_ifd(data, tiff, tiff + int(flat["_gps_ifd"]), endian, GPS_TAGS, flat)

        result["has_exif"] = True
        for key in ("make", "model", "focal_length_mm", "focal_length_35mm",
                    "pixel_width", "pixel_height", "gps_accuracy_m"):
            if key in flat:
                result[key if key != "gps_accuracy_m" else "accuracy_m"] = flat[key]

        result["taken_at"] = (_parse_exif_datetime(flat.get("taken_at_local"))
                              or _parse_exif_datetime(flat.get("created_at_local")))

        if "_lat" in flat and "_lon" in flat:
            lat = _dms_to_degrees(flat["_lat"], flat.get("_lat_ref", "N"))
            lon = _dms_to_degrees(flat["_lon"], flat.get("_lon_ref", "E"))
            if lat is not None and lon is not None and (lat, lon) != (0.0, 0.0):
                result["lat"], result["lon"] = lat, lon
                result["source"] = "exif"

        if "_alt" in flat:
            alt = flat["_alt"]
            if isinstance(alt, (int, float)):
                below_sea = int(flat.get("_alt_ref", 0) or 0) == 1
                result["altitude_m"] = round(-alt if below_sea else alt, 2)

        if "_direction" in flat and isinstance(flat["_direction"], (int, float)):
            result["direction_deg"] = round(float(flat["_direction"]) % 360.0, 2)
            result["direction_ref"] = flat.get("_dir_ref", "T")

        # GPS clock is UTC and comes in two halves: a date and a time.
        gd, gt = flat.get("_gps_date"), flat.get("_gps_time")
        if gd and isinstance(gt, (list, tuple)) and len(gt) >= 3:
            try:
                y, m, d = [int(x) for x in str(gd).split(":")]
                stamp = datetime(y, m, d, int(gt[0]), int(gt[1]), int(gt[2]),
                                 tzinfo=timezone.utc)
                result["gps_time_utc"] = stamp.isoformat()
            except (ValueError, TypeError):
                pass

        if isinstance(result["accuracy_m"], (int, float)):
            result["accuracy_m"] = round(float(result["accuracy_m"]), 2)

    except (struct.error, ValueError, IndexError, TypeError):
        # A file we cannot read is a file with no GPS. That is all.
        return result

    return result


def mm_per_pixel_from_optics(focal_35mm, image_width_px, distance_mm):
    """
    Scale straight off the lens, so the user never has to calibrate.

    A 35 mm-equivalent focal length implies a 36 mm-wide frame, so the
    ground width covered by the photo is  36 * distance / focal, and one
    pixel is that divided by the pixel width.

    Returns None when any input is missing — the caller then falls back to
    the calibration measured in the training tab.
    """
    try:
        f = float(focal_35mm)
        w = float(image_width_px)
        d = float(distance_mm)
    except (TypeError, ValueError):
        return None
    if f <= 0 or w <= 0 or d <= 0:
        return None
    return (36.0 * d) / (f * w)
