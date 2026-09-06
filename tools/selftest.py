#!/usr/bin/env python3
"""
End-to-end check. Starts the server, feeds it real geotagged photographs,
and asserts that what comes back is what the tabs claim.

    python3 tools/selftest.py

Nothing here is mocked: the photos are written to disk by
make_demo_photos.py, uploaded over HTTP, parsed for EXIF by the backend,
matched to a spot, and turned into a growth rate. If this passes, the loop
works.
"""

import base64
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

PORT = 8731
BASE = "http://127.0.0.1:%d" % PORT

PASSED, FAILED = [], []


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    print("  %s  %s%s" % ("PASS" if condition else "FAIL", label,
                          ("  — " + str(detail)) if detail else ""))


def call(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data,
                                     headers={"Content-Type": "application/json"})
    if method:
        request.get_method = lambda: method
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def read_gray_png(path):
    """Decode the grayscale PNGs this project writes: filter 0, 8-bit, no interlace."""
    raw = open(path, "rb").read()
    i, width, height, idat = 8, 0, 0, b""
    while i + 8 <= len(raw):
        length = struct.unpack(">I", raw[i:i + 4])[0]
        kind = raw[i + 4:i + 8]
        payload = raw[i + 8:i + 8 + length]
        if kind == b"IHDR":
            width, height = struct.unpack(">II", payload[:8])
        elif kind == b"IDAT":
            idat += payload
        elif kind == b"IEND":
            break
        i += 12 + length
    flat = zlib.decompress(idat)
    rows = [flat[y * (width + 1) + 1:(y + 1) * (width + 1)] for y in range(height)]
    return rows, width, height


def luma32(rows, width, height):
    """The 32x32 grid the browser would send, computed the same way."""
    grid = []
    for gy in range(32):
        y = min(height - 1, gy * height // 32)
        for gx in range(32):
            x = min(width - 1, gx * width // 32)
            grid.append(rows[y][x])
    return grid


def measure_crack(rows, width, height, threshold=110):
    """
    A stand-in for the browser's detector: count the dark pixels and turn
    them into an arc length. Crude on purpose — this test is about the
    backend, not about the detector.
    """
    dark = sum(1 for row in rows for value in row if value < threshold)
    rows_with_crack = sum(1 for row in rows if any(v < threshold for v in row))
    return float(rows_with_crack), float(dark)


def main():
    print("\n  RAAHI self-test\n  " + "-" * 60)
    workdir = tempfile.mkdtemp(prefix="raahi-selftest-")
    photo_dir = os.path.join(workdir, "photos")
    data_dir = os.path.join(workdir, "data")

    subprocess.run([sys.executable, os.path.join(HERE, "make_demo_photos.py"),
                    "--out", photo_dir, "--passes", "4"],
                   check=True, capture_output=True)
    photos = sorted(os.listdir(photo_dir))
    check("demo photos written", len(photos) == 4, "%d files" % len(photos))

    env = dict(os.environ, RAAHI_PORT=str(PORT), RAAHI_DATA=data_dir,
               RAAHI_NO_BROWSER="1", RAAHI_QUIET="1")
    server = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")],
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                call("/api/state")
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.25)
        else:
            check("server started", False, "never answered on %s" % BASE)
            return

        state = call("/api/state")
        check("server started", True)
        check("starts with an empty record", state["sites"] == 0 and state["observations"] == 0)

        quality = call("/api/metrics/detection")
        check("detection quality is honestly empty", quality["evaluated"] is False)

        # --- upload the four passes --------------------------------------
        results = []
        for name in photos:
            path = os.path.join(photo_dir, name)
            rows, width, height = read_gray_png(path)
            arc_px, _ = measure_crack(rows, width, height)
            payload = call("/api/observations", {
                "photo_b64": base64.b64encode(open(path, "rb").read()).decode(),
                "filename": name,
                "luma32": luma32(rows, width, height),
                "detection": {"arc_px": arc_px, "span_px": arc_px, "image_width": 760},
                "distance_mm": 1200,
                "label": name.split("_")[0] + " " + name.split("_")[1],
            })
            results.append(payload)

        first, last = results[0], results[-1]
        check("GPS read out of the photo itself", first["position"]["source"] == "exif",
              first["position"]["text"])
        check("heading recovered from EXIF", first["position"]["heading_deg"] is not None,
              first["position"]["heading_deg"])
        check("capture date taken from EXIF, not upload time",
              first["exif"]["taken_at"] is not None, first["exif"]["taken_at"])
        check("first photo opens a new spot", first["revisit"] is False)
        check("later photos land on the same spot",
              all(r["revisit"] for r in results[1:]),
              [r["match"]["why"] for r in results[1:]][0])
        check("all four readings on one spot", last["site"]["observations"] == 4)
        check("scale worked out without any calibration",
              last["scale"]["mm_per_px"] is not None and "optics" in (last["scale"]["source"] or ""),
              last["scale"]["source"])
        check("a fingerprint was computed", bool(first["fingerprint"]), first["fingerprint"])

        growth = last["site"]["growth"]
        check("growth rate is positive", (growth["mm_per_day"] or 0) > 0, growth["mm_per_day"])
        check("lead time is reported in days", growth["lead_time_days"] is not None,
              growth["lead_time_days"])
        check("baseline and latest both carry a photo",
              growth["baseline"]["photo_sha"] and growth["latest"]["photo_sha"])
        check("every pass is in the series", len(growth["series"]) == 4)

        # --- a photo from far away must not join that spot ---------------
        rows, width, height = read_gray_png(os.path.join(photo_dir, photos[0]))
        elsewhere = call("/api/observations", {
            "luma32": luma32(rows, width, height),
            "detection": {"arc_px": 120.0, "span_px": 110.0, "image_width": 760},
            "manual_gps": {"lat": 28.7041, "lon": 77.1025},      # 12 km away
            "label": "different road",
        })
        check("a spot 12 km away is a different spot", elsewhere["revisit"] is False,
              elsewhere["match"]["why"])

        # --- the seal list ------------------------------------------------
        schedule = call("/api/schedule")
        check("seal list is built from real readings", len(schedule["rows"]) == 2)
        check("fleet lead time is summarised",
              schedule["lead_time"]["sites_with_lead_time"] >= 1, schedule["lead_time"])
        check("a one-photo spot gets no invented date",
              any(r["days_remaining"] is None for r in schedule["rows"]))

        # --- detection scoring --------------------------------------------
        published = call("/api/metrics/detection", {
            "split": "sample-4-images",
            "model": "worked example",
            "ground_truth": os.path.join(ROOT, "tools/sample_eval/ground_truth.json"),
            "predictions": os.path.join(ROOT, "tools/sample_eval/predictions.json"),
        })
        check("mAP published per class", published["evaluated"] is True
              and len(published["per_class"]) == 4, published.get("map"))
        check("sample size travels with the score",
              published["sample"]["ground_truth_instances"] == 6
              and published["sample"]["images_with_ground_truth"] == 4)

        try:
            call("/api/metrics/detection", {"split": "", "ground_truth": [], "predictions": []})
            check("an unnamed split is refused", False)
        except urllib.error.HTTPError as err:
            check("an unnamed split is refused", err.code == 400)

        # --- calibration overrides the optics -----------------------------
        call("/api/calibration", {"scope": "global", "ref_mm": 100, "ref_px": 250,
                                  "image_width": 760, "note": "selftest"})
        rows, width, height = read_gray_png(os.path.join(photo_dir, photos[0]))
        calibrated = call("/api/observations", {
            "photo_b64": base64.b64encode(open(os.path.join(photo_dir, photos[0]), "rb").read()).decode(),
            "filename": photos[0],
            "luma32": luma32(rows, width, height),
            "detection": {"arc_px": 250.0, "span_px": 250.0, "image_width": 760},
            "distance_mm": 1200,
        })
        check("calibration beats the lens estimate",
              "calibration" in (calibrated["scale"]["source"] or ""),
              calibrated["scale"]["source"])
        check("100 mm reference measures 100 mm",
              abs(calibrated["scale"]["length_mm"] - 100.0) < 0.5,
              calibrated["scale"]["length_mm"])

        # --- a photo with no scale is not the same as no photo ------------
        no_scale = call("/api/observations", {
            "luma32": luma32(rows, width, height),
            "detection": {"arc_px": 90.0, "span_px": 88.0, "image_width": 760},
            "manual_gps": {"lat": 19.0760, "lon": 72.8777},     # another city
            "site_name": "unscaled spot",
        })
        # The global calibration set above applies to everything, so clear the
        # scale question by checking the wording only when there is none.
        check("a spot photographed once gets no invented rate",
              no_scale["site"]["growth"]["mm_per_day"] is None,
              no_scale["site"]["growth"]["verdict"])

        # --- deletion cleans up -------------------------------------------
        site_id = last["site"]["id"]
        call("/api/sites/" + site_id, method="DELETE")
        after = call("/api/sites")
        check("deleting a spot removes it", all(s["id"] != site_id for s in after["sites"]))

        # A deleted id must never be handed to a different spot: the readings
        # already filed under it would silently join the new one.
        surviving = {s["id"] for s in after["sites"]}
        fresh = call("/api/observations", {
            "luma32": luma32(rows, width, height),
            "detection": {"arc_px": 100.0, "span_px": 95.0, "image_width": 760},
            "manual_gps": {"lat": 13.0827, "lon": 80.2707},     # a third city
            "site_name": "after the delete",
        })
        check("a new spot can still be made after a delete", fresh["revisit"] is False,
              fresh["site"]["id"])
        check("a deleted id is never reissued",
              fresh["site"]["id"] not in surviving and fresh["site"]["id"] != site_id,
              fresh["site"]["id"])

    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(workdir, ignore_errors=True)

    print("  " + "-" * 60)
    print("  %d passed, %d failed\n" % (len(PASSED), len(FAILED)))
    if FAILED:
        for name in FAILED:
            print("    failed: %s" % name)
        print()
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
