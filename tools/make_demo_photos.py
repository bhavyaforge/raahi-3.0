#!/usr/bin/env python3
"""
Make geotagged demo photographs, so the whole loop can be shown indoors.

    python3 tools/make_demo_photos.py --out demo_photos

Writes eighteen PNG files — one a day, day 1 to day 18 — of a synthetic
crack that grows a little each morning. Each file carries a real EXIF block
— GPS position, capture date, camera heading, focal length — written the
way a phone writes it, with the position jittered by a few metres exactly
as a real GPS fix would be.

Eighteen days is the length of the deck's baseline: three weeks of
collection rounds is what it takes before a growth rate is worth a date.

Upload them on the CAPTURE tab in date order. The app has no idea they are
synthetic: it reads their EXIF, works out that they are the same spot, and
builds the growth curve and the lead time from them. Nothing is preloaded
into the database, so what you see on screen came from these files.

Pure standard library — PNG is written by hand, EXIF assembled byte by byte.
"""

import argparse
import math
import os
import random
import struct
import zlib
from datetime import datetime, timedelta

# --- EXIF assembly ---------------------------------------------------------
ASCII, SHORT, LONG, RATIONAL, BYTE = 2, 3, 4, 5, 1


def _rational(value, denominator=1000):
    return struct.pack("<II", int(round(value * denominator)), denominator)


def _dms(value):
    value = abs(value)
    degrees = int(value)
    minutes = int((value - degrees) * 60)
    seconds = (value - degrees - minutes / 60.0) * 3600
    return (struct.pack("<II", degrees, 1) + struct.pack("<II", minutes, 1)
            + struct.pack("<II", int(round(seconds * 10000)), 10000))


def _build_ifd(entries, ifd_offset, data_offset):
    """entries: [(tag, fmt, count, payload_bytes)] -> (ifd_bytes, data_bytes)."""
    body = struct.pack("<H", len(entries))
    pool = b""
    cursor = data_offset
    for tag, fmt, count, payload in sorted(entries, key=lambda e: e[0]):
        if len(payload) <= 4:
            value = payload + b"\x00" * (4 - len(payload))
        else:
            value = struct.pack("<I", cursor)
            pool += payload
            cursor += len(payload)
        body += struct.pack("<HHI", tag, fmt, count) + value
    body += struct.pack("<I", 0)          # no next IFD
    return body, pool


def build_exif(lat, lon, taken, heading, focal_35mm=80, make="RAAHI", model="Demo Round"):
    """Return a TIFF block: IFD0 -> Exif IFD + GPS IFD, little-endian."""
    make_b = make.encode() + b"\x00"
    model_b = model.encode() + b"\x00"
    date_b = taken.strftime("%Y:%m:%d %H:%M:%S").encode() + b"\x00"

    # Sizes are fixed by entry counts, so the offsets can be computed up front.
    ifd0_entries = 4
    exif_entries = 3
    gps_entries = 7
    ifd0_at = 8
    ifd0_size = 2 + 12 * ifd0_entries + 4
    ifd0_data_at = ifd0_at + ifd0_size
    ifd0_data_size = len(make_b) + len(model_b)
    exif_at = ifd0_data_at + ifd0_data_size
    exif_size = 2 + 12 * exif_entries + 4
    exif_data_at = exif_at + exif_size
    exif_data_size = len(date_b) + 8            # date + one rational
    gps_at = exif_data_at + exif_data_size
    gps_size = 2 + 12 * gps_entries + 4
    gps_data_at = gps_at + gps_size

    ifd0, ifd0_pool = _build_ifd([
        (0x010F, ASCII, len(make_b), make_b),
        (0x0110, ASCII, len(model_b), model_b),
        (0x8769, LONG, 1, struct.pack("<I", exif_at)),
        (0x8825, LONG, 1, struct.pack("<I", gps_at)),
    ], ifd0_at, ifd0_data_at)

    exif_ifd, exif_pool = _build_ifd([
        (0x9003, ASCII, len(date_b), date_b),
        (0xA405, SHORT, 1, struct.pack("<H", int(focal_35mm))),
        (0x920A, RATIONAL, 1, _rational(focal_35mm / 7.5, 100)),
    ], exif_at, exif_data_at)

    gps_ifd, gps_pool = _build_ifd([
        (0x0001, ASCII, 2, (b"N" if lat >= 0 else b"S") + b"\x00"),
        (0x0002, RATIONAL, 3, _dms(lat)),
        (0x0003, ASCII, 2, (b"E" if lon >= 0 else b"W") + b"\x00"),
        (0x0004, RATIONAL, 3, _dms(lon)),
        (0x0010, ASCII, 2, b"T\x00"),
        (0x0011, RATIONAL, 1, _rational(heading % 360.0, 100)),
        (0x001F, RATIONAL, 1, _rational(4.5, 10)),      # 4.5 m stated accuracy
    ], gps_at, gps_data_at)

    return (b"II" + struct.pack("<HI", 42, ifd0_at)
            + ifd0 + ifd0_pool + exif_ifd + exif_pool + gps_ifd + gps_pool)


# --- PNG writing -----------------------------------------------------------
def _chunk(kind, payload):
    return (struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))


def write_png(path, pixels, width, height, exif_block=None):
    """8-bit grayscale PNG, with the EXIF block in an eXIf chunk."""
    raw = b"".join(b"\x00" + bytes(pixels[y * width:(y + 1) * width]) for y in range(height))
    out = [b"\x89PNG\r\n\x1a\n",
           _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))]
    if exif_block:
        out.append(_chunk(b"eXIf", exif_block))
    out.append(_chunk(b"IDAT", zlib.compress(raw, 9)))
    out.append(_chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(b"".join(out))


# --- the picture itself ----------------------------------------------------
def draw_crack(width, height, length_px, seed):
    """
    Asphalt-ish noise with one dark, wandering crack down the middle.

    The road texture is drawn from a fixed seed, because the same stretch of
    tarmac looks like itself on Tuesday. Only the exposure drifts between
    passes, which is exactly the variation the scene fingerprint is built to
    ignore — and exactly the variation that would break a naive pixel diff.
    """
    surface = random.Random(20260101)
    light = random.Random(seed)
    exposure = light.uniform(-14, 14)          # morning sun versus overcast
    pixels = bytearray(width * height)
    for i in range(width * height):
        pixels[i] = max(0, min(255, int(surface.gauss(148, 13) + exposure)))

    # The crack always starts at the same place and grows downward, because a
    # crack that moved between passes would be a different crack.
    walk = random.Random(4242)
    x = width / 2.0
    y0 = (height - length_px) / 2.0
    for step in range(int(length_px)):
        y = y0 + step
        x += walk.gauss(0, 0.55)
        x = max(6.0, min(width - 7.0, x))
        # A real crack is a solid dark line that narrows and widens along its
        # length. It never breaks into dots — and if this drawing did, both
        # the app's detector and the self-test's would measure the fragments
        # rather than the crack, so the core is kept opaque and only the
        # edges are allowed to feather.
        thickness = 2.4 + 1.1 * math.sin(step / 17.0)
        for dx in range(-4, 5):
            px = int(round(x)) + dx
            if 0 <= px < width and 0 <= int(y) < height:
                falloff = max(0.0, min(1.0, (thickness - abs(dx) + 0.5) / 1.6))
                if falloff > 0:
                    index = int(y) * width + px
                    pixels[index] = int(pixels[index] * (1 - falloff) + 22 * falloff)
    return pixels


def main():
    parser = argparse.ArgumentParser(description="Geotagged demo photos of a growing crack.")
    parser.add_argument("--out", default="demo_photos", help="folder to write into")
    parser.add_argument("--passes", type=int, default=18, help="how many days to photograph")
    parser.add_argument("--lat", type=float, default=28.613939, help="latitude of the spot")
    parser.add_argument("--lon", type=float, default=77.209023, help="longitude of the spot")
    parser.add_argument("--growth-px", type=float, default=2.2,
                        help="pixels the crack gains each day")
    parser.add_argument("--start-px", type=float, default=195.0, help="length on day one")
    parser.add_argument("--days-apart", type=int, default=1, help="days between passes")
    parser.add_argument("--focal-35mm", type=float, default=80.0,
                        help="35 mm-equivalent focal length written into the EXIF")
    args = parser.parse_args()

    # The app works millimetres out from focal length and shooting distance,
    # after resizing the photo to 760 px wide for analysis. 80 mm equivalent
    # at the app's default 1.2 m puts this crack in the 120-150 mm band,
    # which is where a 150 mm seal threshold is worth having — the series
    # closes just short of the line, so the app has to predict the crossing
    # instead of merely reporting it. Real photos carry their real focal
    # length and none of this applies to them.
    analysis_width = 760.0
    mm_per_px = (36.0 * 1200.0) / (args.focal_35mm * analysis_width)

    os.makedirs(args.out, exist_ok=True)
    width, height = 900, 640
    span = args.days_apart * (args.passes - 1)
    first_day = datetime.now() - timedelta(days=span)
    jitter = random.Random(7)

    print()
    print("  day  file                         taken            position                 length")
    print("  " + "-" * 88)
    for index in range(args.passes):
        day = index + 1
        # 7 a.m. give or take: a collection round leaves the depot at first
        # light, and the app must not mistake a different hour for a
        # different day.
        taken = (first_day + timedelta(days=args.days_apart * index)
                 ).replace(hour=7, minute=0, second=0, microsecond=0) \
                + timedelta(minutes=int(jitter.uniform(-25, 25)))
        length = args.start_px + args.growth_px * index * args.days_apart
        # A real GPS fix wanders a few metres between visits. 1e-5 deg is ~1.1 m.
        lat = args.lat + jitter.gauss(0, 0.000035)
        lon = args.lon + jitter.gauss(0, 0.000035)
        heading = 92 + jitter.gauss(0, 6)

        pixels = draw_crack(width, height, min(length, height - 20), seed=index)
        exif_block = build_exif(lat, lon, taken, heading, focal_35mm=args.focal_35mm)
        # The day number is in the file name as well as the EXIF date, so a
        # folder of these can be uploaded even after the dates are stripped.
        name = "day%02d_%s.png" % (day, taken.strftime("%Y%m%d"))
        write_png(os.path.join(args.out, name), pixels, width, height, exif_block)
        measured_mm = length * (analysis_width / width) * mm_per_px
        print("  %3d  %-28s %s   %.6f, %.6f   %5.0f px  %5.1f mm"
              % (day, name, taken.strftime("%d %b %H:%M"), lat, lon, length, measured_mm))

    total = ((args.start_px + args.growth_px * span) - args.start_px) \
        * (analysis_width / width) * mm_per_px
    print()
    print("  %d photos in %s/ — %d days, growing %.2f mm a day, %.1f mm in total."
          % (args.passes, args.out, span + 1,
             (total / span) if span else 0.0, total))
    print("  Upload the whole folder at once on the CAPTURE tab. The app reads their GPS,")
    print("  works out they are the same spot, and builds the growth curve itself.")
    print("  Nothing is written into the database ahead of time.")
    print()


if __name__ == "__main__":
    main()
