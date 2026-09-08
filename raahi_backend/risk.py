"""
The risk engine. This is the formula the deck is built on:

    priority  =  growth rate  ×  rainfall forecast  ×  traffic

    mm/day       how fast this crack is actually getting longer, measured
    × factor     how much rain is coming to get into it
    × factor     how much load is going to work it open

Everything on the left is measured. Everything on the right is a stated
multiplier with its own module, its own reference value and its own note
saying where it came from. The product has units of millimetres per day —
it is the growth rate this crack would have if rain and traffic were doing
their worst — and that is what the seal list is sorted by.

Three rules this module keeps:

  * A spot with one photograph has no rate, so it has no priority. It is
    returned as NO RATE YET and sorted to the bottom. Multiplying an
    invented growth rate by two real factors would produce a confident
    number with nothing underneath it.

  * The working is always returned with the answer. `formula` is the
    sentence a ward engineer can check by hand:
    "0.42 mm/day × 3.1 rain × 1.8 traffic = 2.34 mm/day effective".

  * The rain term never silently changes the measured growth. `mm_per_day`
    stays what the readings said. The monsoon-adjusted date is reported
    beside the dry-fit one, both labelled.
"""

import math
from datetime import datetime, timedelta, timezone

from . import rainfall, traffic

# The 0-100 scale the seal list is sorted by.
#
# The product spans orders of magnitude: a hairline creeping at 0.05 mm a day
# on a dry residential lane against a crack running at 1.5 mm a day on a
# monsoon-season arterial, which is 4.0 x 2.6 = ten times more again. A
# straight-line score across that range saturates — everything worth looking
# at pins to 100 and the ranking stops ranking. So the scale is logarithmic
# between a floor and a ceiling, both stated:
#
#   0.05 mm/day effective  ->   0     nothing is happening here
#   0.5                    ->  43     a season away from the threshold
#   2.2                    ->  70     URGENT begins
#   10 mm/day effective    -> 100     this is a pothole forming
#
SCORE_FLOOR = 0.05
SCORE_CEILING = 10.0

BANDS = (
    (70, "URGENT", "Schedule before the next rain."),
    (40, "HIGH", "Into this fortnight's sealing list."),
    (15, "MEDIUM", "Next round of the ward programme."),
    (0, "LOW", "Keep photographing it. Nothing to send a crew for yet."),
)


def band_for(score):
    for floor, name, action in BANDS:
        if score >= floor:
            return name, action
    return "LOW", BANDS[-1][2]


def score_from(effective_mm_per_day):
    """
    Effective mm/day -> 0-100.

    Logarithmic between the floor and the ceiling above, so a spot four
    times worse than another reads as clearly worse rather than both
    reading 100. The two constants are chosen, not fitted, and both are
    returned with every answer so nobody has to read this file to check
    what a score of 78 means.
    """
    if effective_mm_per_day is None:
        return None
    value = max(0.0, float(effective_mm_per_day))
    if value <= SCORE_FLOOR:
        return 0
    fraction = (math.log10(value / SCORE_FLOOR)
                / math.log10(SCORE_CEILING / SCORE_FLOOR))
    return int(round(100 * min(1.0, fraction)))


def assess(site, report, now=None, window_days=rainfall.DEFAULT_WINDOW_DAYS,
           rain_override_mm=None):
    """
    Put one spot through the formula.

    `site` is the stored row — position, road class, traffic count. `report`
    is what growth.analyse() said about its readings. Returns the three
    terms, the product, the score, the band, and the dates.
    """
    now = now or datetime.now(timezone.utc)

    rain = rainfall.forecast(site.get("lat"), site.get("lon"), start=now,
                             days=window_days, override_mm=rain_override_mm)
    road = traffic.describe(site.get("road_class"),
                            site.get("commercial_vehicles_per_day"))

    growth_rate = report.get("mm_per_day")
    threshold = report.get("threshold_mm")
    latest = (report.get("latest") or {}).get("length_mm")

    out = {
        "site_id": site.get("id"),
        "name": site.get("name"),
        "growth": {
            "mm_per_day": growth_rate,
            "mm_per_week": report.get("mm_per_week"),
            "fit_r2": report.get("fit_r2"),
            "readings": report.get("readings"),
            "basis": "least-squares fit over the readings stored for this spot",
        },
        "rain": rain,
        "traffic": road,
        "window_days": window_days,
        "score_scale": {"floor_mm_per_day": SCORE_FLOOR,
                        "ceiling_mm_per_day": SCORE_CEILING,
                        "shape": "logarithmic between the two"},
        "effective_mm_per_day": None,
        "score": None,
        "band": "NO RATE YET",
        "action": "Photograph this spot on another day. One reading is a defect, not a trend.",
        "formula": None,
        "monsoon_cross_date": None,
        "monsoon_days_remaining": None,
        "dry_cross_date": report.get("predicted_cross_date"),
        "dry_days_remaining": report.get("days_remaining"),
        "days_bought_by_rain": None,
        "verdict": report.get("verdict"),
    }

    if not isinstance(growth_rate, (int, float)):
        out["formula"] = ("No growth rate yet, so no priority. "
                          "The formula needs a measured mm/day before rain and "
                          "traffic have anything to multiply.")
        return out

    if growth_rate <= 0:
        out["effective_mm_per_day"] = 0.0
        out["score"] = 0
        out["band"] = "STABLE"
        out["action"] = "Not growing. Keep it on the round."
        out["formula"] = ("%.3f mm/day measured — not growing, so rain and traffic "
                          "have nothing to accelerate." % growth_rate)
        return out

    effective = growth_rate * rain["factor"] * road["factor"]
    out["effective_mm_per_day"] = round(effective, 3)
    out["score"] = score_from(effective)
    out["band"], out["action"] = band_for(out["score"])
    out["formula"] = ("%.3f mm/day × %.2f rain × %.2f traffic = %.3f mm/day effective"
                      % (growth_rate, rain["factor"], road["factor"], effective))

    # The date the rain moves. Growth measured in a dry fortnight understates
    # what the same crack does with water in it, so the seal-by date is
    # recomputed at the effective rate — and reported next to the dry one,
    # never in place of it.
    if isinstance(threshold, (int, float)) and isinstance(latest, (int, float)):
        remaining_mm = threshold - latest
        if remaining_mm <= 0:
            out["monsoon_cross_date"] = report.get("predicted_cross_date")
            out["monsoon_days_remaining"] = 0
            out["days_bought_by_rain"] = 0
        elif effective > 0:
            days = remaining_mm / effective
            last_at = (report.get("latest") or {}).get("at")
            base = _parse(last_at) or now
            cross = base + timedelta(days=days)
            out["monsoon_cross_date"] = cross.isoformat()
            out["monsoon_days_remaining"] = round((cross - now).total_seconds() / 86400.0, 1)
            dry = out["dry_days_remaining"]
            if isinstance(dry, (int, float)):
                out["days_bought_by_rain"] = round(dry - out["monsoon_days_remaining"], 1)

    return out


def _parse(text):
    if not text:
        return None
    try:
        stamp = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def rank(assessments):
    """
    Sort the spots into the order a crew should be sent in.

    Scored spots first, worst effective growth at the top. Spots with no
    rate yet fall to the bottom in one block rather than being interleaved
    with real ones — the list must never imply a spot was considered and
    found safe when it was simply never re-photographed.
    """
    scored = [a for a in assessments if isinstance(a.get("score"), int)]
    unscored = [a for a in assessments if not isinstance(a.get("score"), int)]
    scored.sort(key=lambda a: (-(a["score"] or 0),
                               a["monsoon_days_remaining"]
                               if isinstance(a.get("monsoon_days_remaining"), (int, float))
                               else 1e9))
    for index, item in enumerate(scored, 1):
        item["rank"] = index
    for item in unscored:
        item["rank"] = None
    return scored + unscored


def summary(assessments):
    """The fleet-level numbers the seal list prints above the table."""
    scored = [a for a in assessments if isinstance(a.get("score"), int)]
    urgent = [a for a in scored if a["band"] == "URGENT"]
    high = [a for a in scored if a["band"] == "HIGH"]
    soonest = None
    for item in scored:
        days = item.get("monsoon_days_remaining")
        if isinstance(days, (int, float)) and (soonest is None or days < soonest):
            soonest = days
    rains = [a["rain"]["expected_mm"] for a in assessments
             if isinstance(a.get("rain", {}).get("expected_mm"), (int, float))]
    return {
        "sites": len(assessments),
        "scored": len(scored),
        "urgent": len(urgent),
        "high": len(high),
        "no_rate_yet": len(assessments) - len(scored),
        "soonest_crossing_days": soonest,
        "window_days": assessments[0]["window_days"] if assessments else None,
        "rain_window_mm": round(sum(rains) / len(rains), 1) if rains else None,
        "formula": "priority = growth rate (mm/day) × rainfall factor × traffic factor",
    }
