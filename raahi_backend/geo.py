"""
Position maths and revisit matching.

This module answers the question the whole project rests on:

    A photo arrives today. Is it the same spot as a photo from yesterday?

GPS alone cannot answer it. A phone fixes its position to roughly 5-10 m,
and two cracks 4 m apart are different cracks. So three independent
signals are combined:

    1. distance   — how far apart the two fixes are, in metres
    2. heading    — whether the camera was pointing the same way
    3. appearance — a 64-bit fingerprint of the picture itself

Distance narrows the field. Heading throws out the case of standing in one
place and photographing two different edges of the road. Together those two
are enough to call it the same spot. Appearance is the third vote: it can
carry the decision on its own when GPS is missing entirely, and when it
disagrees with a good position fix the match is flagged rather than
silently accepted — a road looks different wet, and that must not break the
record.
"""

import math

EARTH_RADIUS_M = 6_371_008.8

# Tuned for a phone held over a crack. Documented here because a reviewer
# will ask, and because these are the numbers to argue about, not hide.
DEFAULT_RADIUS_M = 15.0      # a GPS fix is worth about this much
HEADING_TOLERANCE_DEG = 45.0  # hand-held bearing is not a survey instrument
HASH_SAME = 12                # of 64 bits; below this the scene matches
HASH_STRONG = 7               # strong enough to stand in for GPS


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance between two fixes, in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial compass bearing from the first fix to the second."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def heading_delta_deg(a, b):
    """Smallest angle between two headings, 0-180."""
    if a is None or b is None:
        return None
    d = abs((float(a) - float(b)) % 360.0)
    return d if d <= 180.0 else 360.0 - d


def mean_position(points):
    """Average of several fixes. Good enough at city scale."""
    pts = [(la, lo) for la, lo in points if la is not None and lo is not None]
    if not pts:
        return None, None
    return (round(sum(p[0] for p in pts) / len(pts), 8),
            round(sum(p[1] for p in pts) / len(pts), 8))


def circular_mean_deg(angles):
    """Average of compass headings — 350 and 10 average to 0, not 180."""
    vals = [float(a) for a in angles if a is not None]
    if not vals:
        return None
    x = sum(math.cos(math.radians(a)) for a in vals)
    y = sum(math.sin(math.radians(a)) for a in vals)
    if abs(x) < 1e-12 and abs(y) < 1e-12:
        return None
    return round((math.degrees(math.atan2(y, x)) + 360.0) % 360.0, 2)


# ---------------------------------------------------------------------------
#  Appearance fingerprint
# ---------------------------------------------------------------------------
def _resample(gray, src, dst_w, dst_h):
    """Box-average a square grayscale grid down to dst_w x dst_h."""
    out = []
    for y in range(dst_h):
        y0, y1 = y * src // dst_h, max(y * src // dst_h + 1, (y + 1) * src // dst_h)
        for x in range(dst_w):
            x0, x1 = x * src // dst_w, max(x * src // dst_w + 1, (x + 1) * src // dst_w)
            block = [gray[yy * src + xx] for yy in range(y0, y1) for xx in range(x0, x1)]
            out.append(sum(block) / len(block))
    return out


def perceptual_hash(gray, size=32):
    """
    64-bit difference hash of a grayscale grid sent by the browser.

    A dHash records whether each pixel is brighter than the one to its
    right. That makes it blind to exposure and white balance — the two
    things that change most between a 7 a.m. and a 9 a.m. pass — while
    staying sensitive to the layout of the scene.

    `gray` is a flat list of `size * size` values, 0-255.
    """
    if not gray or len(gray) != size * size:
        return None
    small = _resample(gray, size, 9, 8)
    bits = 0
    for y in range(8):
        for x in range(8):
            left = small[y * 9 + x]
            right = small[y * 9 + x + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return "%016x" % bits


def hamming(hash_a, hash_b):
    """How many of the 64 bits differ. None if either hash is missing."""
    if not hash_a or not hash_b:
        return None
    try:
        return bin(int(hash_a, 16) ^ int(hash_b, 16)).count("1")
    except ValueError:
        return None


# ---------------------------------------------------------------------------
#  Revisit decision
# ---------------------------------------------------------------------------
def score_match(observation, site, radius_m=DEFAULT_RADIUS_M):
    """
    Compare one new photo against one known site.

    Returns a dict with the distance, the heading gap, the appearance
    distance, a 0-1 confidence and a plain-English reason. The reason is
    shown to the user verbatim, because a system that says SAME SPOT
    without saying why is a system nobody trusts.
    """
    lat, lon = observation.get("lat"), observation.get("lon")
    distance = None
    if None not in (lat, lon, site.get("lat"), site.get("lon")):
        distance = round(haversine_m(lat, lon, site["lat"], site["lon"]), 2)

    gap = heading_delta_deg(observation.get("direction_deg"), site.get("direction_deg"))
    bits = hamming(observation.get("phash"), site.get("phash"))

    geo_ok = distance is not None and distance <= radius_m
    head_ok = gap is None or gap <= HEADING_TOLERANCE_DEG
    look_ok = bits is not None and bits <= HASH_SAME
    look_strong = bits is not None and bits <= HASH_STRONG

    confidence, reasons = 0.0, []
    if geo_ok:
        confidence += 0.45 * (1.0 - min(distance / radius_m, 1.0)) + 0.15
        reasons.append("%.1f m from the recorded position" % distance)
    elif distance is not None:
        reasons.append("%.0f m away — outside the %.0f m radius" % (distance, radius_m))

    if gap is not None:
        if head_ok:
            confidence += 0.15 * (1.0 - gap / HEADING_TOLERANCE_DEG)
            reasons.append("camera pointing within %.0f deg of before" % gap)
        else:
            confidence -= 0.15
            reasons.append("camera turned %.0f deg — different face of the road" % gap)

    if bits is not None:
        if look_ok:
            confidence += 0.40 * (1.0 - bits / float(HASH_SAME))
            reasons.append("scene matches (%d/64 bits differ)" % bits)
        else:
            reasons.append("scene looks different (%d/64 bits differ)" % bits)

    # Two ways to be the same spot, and either is enough:
    #
    #   position agrees and the camera was pointing the same way, or
    #   the scene is unmistakable on its own.
    #
    # The second clause is what lets a photo with no GPS at all — stripped
    # metadata, an urban canyon, a basement — still find its own history.
    same = bool((geo_ok and head_ok) or (look_strong and (geo_ok or distance is None)))

    # Agreeing on position while disagreeing on appearance is worth saying
    # out loud. Usually it is the light or a wet road; sometimes it is a
    # different crack two metres over, and the user can override the spot.
    warning = None
    if same and bits is not None and not look_ok:
        warning = ("The position matches but the scene does not. If this is a "
                   "different crack nearby, set the spot by hand before saving.")

    return {
        "site_id": site.get("id"),
        "distance_m": distance,
        "heading_delta_deg": gap,
        "hash_distance": bits,
        "confidence": round(max(0.0, min(1.0, confidence)), 3),
        "same_spot": same,
        "warning": warning,
        "why": "; ".join(reasons) or "nothing to compare against",
    }


def match_site(observation, sites, radius_m=DEFAULT_RADIUS_M):
    """
    Pick the best site for a new photo, or decide it is somewhere new.

    Returns (best_match_or_None, all_scores_sorted).
    """
    scored = [score_match(observation, s, radius_m) for s in sites]
    scored.sort(key=lambda m: (m["same_spot"], m["confidence"]), reverse=True)
    best = scored[0] if scored and scored[0]["same_spot"] else None
    return best, scored
