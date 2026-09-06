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

Pure standard library — the PNG is written by hand here, and the EXIF block
comes from raahi_backend.geotag, the same writer the app uses when the
shutter fires on a live camera frame.
"""

import argparse
import math
import os
import random
import struct
import sys
import zlib
from datetime import datetime, timedelta, timezone

# --- EXIF -----------------------------------------------------------------
#
# The block is built by raahi_backend.geotag — the same code the app uses to
# stamp a live camera frame at the shutter. Writing a second EXIF assembler
# here would mean the demo photographs could pass a reader that real ones
# fail, or the reverse, and nobody would find out until a demo day.
try:
    from raahi_backend import geotag
except ImportError:                     # run straight out of tools/
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from raahi_backend import geotag


def build_exif(lat, lon, taken, heading, focal_35mm=80, make="RAAHI", model="Demo Round"):
    """A phone's EXIF block for one demo frame."""
    return geotag.build_exif(
        lat, lon, taken=taken.replace(tzinfo=timezone.utc), heading=heading,
        altitude_m=216.0, accuracy_m=4.5, focal_35mm=focal_35mm,
        pixel_width=900, pixel_height=640, make=make, model=model,
        software="RAAHI demo writer")


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

    # Real tarmac has structure at a scale you can see from standing height:
    # a patch that took the sun differently, the shadow of a kerb, the seam
    # of an old repair. It matters here because the scene fingerprint is a
    # 64-bit difference hash — it compares the average brightness of one
    # coarse block against its neighbour. Over featureless noise those
    # averages are all but equal, so a couple of grey levels of exposure
    # flip bits at random and the app reports "the scene looks different"
    # about a stretch of road that has not changed. Structure is what makes
    # the fingerprint repeatable, and a road that had none would be the
    # unrealistic case, not this.
    # Small on purpose. A block average over noise wanders by well under a
    # grey level, so a handful is already enough to hold the fingerprint
    # steady — while anything approaching the crack's own darkness would
    # give the detector a second thing to find and measure.
    waves = random.Random(31337)
    field = [(waves.uniform(0.6, 2.6), waves.uniform(0.5, 2.2),
              waves.uniform(0, 6.283), waves.uniform(2.0, 5.0)) for _ in range(5)]

    pixels = bytearray(width * height)
    for y in range(height):
        v = y / float(height)
        row_base = y * width
        low = []
        for x in range(width):
            u = x / float(width)
            value = 0.0
            for fx, fy, phase, amp in field:
                value += amp * math.sin(6.283 * (fx * u + fy * v) + phase)
            low.append(value)
        for x in range(width):
            pixels[row_base + x] = max(0, min(255, int(
                surface.gauss(148, 11) + low[x] + exposure)))

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
