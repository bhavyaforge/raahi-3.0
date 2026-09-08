"""
Rainfall — the middle term of the formula.

    priority = growth rate  ×  rainfall forecast  ×  traffic

Water is what turns a crack into a pothole. It enters the crack, reaches
the base course, the base loses support, and the surface collapses under
the next axle. So a crack growing at the same rate is worth sealing sooner
where the rain is coming and later where it is not, and that is the whole
argument for sealing *before* the monsoon rather than patching after it.

WHERE THE NUMBERS COME FROM

This build ships an offline table of monthly normal rainfall for Indian
stations, because the app is meant to run on a laptop at a depot with no
internet and nothing installed. Normals are not a forecast: they say what a
fortnight in July usually brings at that place, not what next fortnight
will bring. That distinction is reported in every answer, in the `basis`
field, and it never says "forecast" when it means "normal".

Three sources, best first:

    1. a real forecast handed to us          basis = "forecast"
       (POST /api/rainfall, or a site override — an IMD district bulletin,
        a departmental feed, anything the municipality already trusts)
    2. observed rainfall recorded for the spot  basis = "observed"
    3. the bundled monthly normals            basis = "normal"

The bundled figures are approximate published climatological normals,
rounded to the nearest millimetre, and they are a stand-in — good enough to
rank one ward against another, not good enough to quote in a report. Drop a
CSV of real normals next to the data folder and they are used instead:

    data/rainfall_normals.csv
    name,lat,lon,jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec
"""

import csv
import math
import os
from datetime import datetime, timedelta, timezone

# Days of rain ahead that a sealing decision actually turns on. A crew
# scheduled a fortnight out is a crew that can still be re-scheduled.
DEFAULT_WINDOW_DAYS = 14

# A fortnight bringing this much rain doubles the factor. It is a chosen
# constant, not a measured one: 60 mm is an ordinary wet fortnight over most
# of the country. Once enough spots have been photographed through a monsoon
# it should be re-fitted against measured growth, and until then it is
# reported as an assumption rather than buried.
REFERENCE_MM = 60.0
MAX_FACTOR = 5.0

MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep",
          "oct", "nov", "dec")

# name, lat, lon, monthly normal rainfall in mm, January to December.
# Approximate published normals — see the note above.
NORMALS = [
    ("New Delhi",           28.61,  77.21, [19, 20, 15, 12, 21, 71, 211, 173, 150, 31, 5, 10]),
    ("Chandigarh",          30.73,  76.78, [37, 38, 28, 17, 32, 118, 290, 300, 150, 25, 8, 17]),
    ("Amritsar",            31.63,  74.87, [24, 32, 24, 15, 17, 49, 180, 158, 80, 10, 5, 12]),
    ("Ludhiana",            30.90,  75.86, [25, 28, 22, 12, 18, 55, 215, 190, 105, 12, 4, 10]),
    ("Dehradun",            30.32,  78.03, [50, 52, 50, 25, 55, 230, 640, 610, 300, 45, 8, 20]),
    ("Shimla",              31.10,  77.17, [60, 65, 60, 45, 60, 150, 410, 390, 175, 35, 10, 30]),
    ("Srinagar",            34.08,  74.80, [55, 60, 90, 85, 60, 35, 60, 60, 35, 30, 20, 35]),
    ("Leh",                 34.15,  77.58, [10, 8, 10, 7, 7, 5, 15, 20, 10, 7, 4, 8]),
    ("Jaipur",              26.91,  75.79, [8, 10, 6, 5, 15, 58, 204, 214, 79, 17, 4, 4]),
    ("Jodhpur",             26.24,  73.02, [4, 4, 2, 2, 7, 32, 110, 110, 45, 7, 3, 2]),
    ("Agra",                27.18,  78.02, [12, 12, 7, 5, 13, 60, 215, 220, 120, 20, 4, 5]),
    ("Gwalior",             26.22,  78.18, [12, 10, 6, 4, 10, 75, 270, 250, 140, 20, 4, 5]),
    ("Lucknow",             26.85,  80.95, [20, 17, 8, 6, 17, 102, 300, 290, 196, 36, 6, 7]),
    ("Kanpur",              26.45,  80.33, [15, 15, 8, 5, 15, 95, 285, 270, 175, 35, 5, 7]),
    ("Varanasi",            25.32,  82.97, [18, 17, 10, 7, 15, 105, 310, 290, 220, 50, 7, 5]),
    ("Patna",               25.59,  85.14, [15, 14, 8, 10, 36, 144, 318, 300, 232, 73, 5, 3]),
    ("Ranchi",              23.35,  85.33, [18, 25, 20, 20, 45, 205, 330, 325, 235, 80, 10, 5]),
    ("Kolkata",             22.54,  88.34, [12, 25, 30, 50, 131, 289, 372, 343, 314, 157, 18, 6]),
    ("Bhubaneswar",         20.30,  85.82, [12, 25, 25, 30, 70, 215, 340, 350, 255, 175, 45, 8]),
    ("Guwahati",            26.14,  91.74, [10, 20, 50, 160, 270, 320, 340, 270, 200, 105, 15, 7]),
    ("Dibrugarh",           27.48,  95.00, [20, 35, 90, 215, 330, 470, 510, 395, 275, 140, 25, 10]),
    ("Shillong",            25.57,  91.88, [15, 30, 90, 300, 470, 610, 555, 450, 375, 210, 45, 10]),
    ("Imphal",              24.82,  93.94, [15, 25, 60, 110, 225, 290, 265, 240, 190, 120, 25, 10]),
    ("Aizawl",              23.73,  92.72, [15, 30, 90, 250, 395, 470, 395, 375, 325, 225, 55, 10]),
    ("Bhopal",              23.26,  77.41, [12, 8, 7, 4, 11, 137, 376, 364, 199, 42, 17, 8]),
    ("Indore",              22.72,  75.86, [7, 3, 3, 3, 10, 130, 330, 290, 180, 40, 20, 8]),
    ("Jabalpur",            23.18,  79.99, [20, 20, 15, 8, 12, 145, 420, 400, 215, 50, 20, 10]),
    ("Raipur",              21.25,  81.63, [12, 20, 20, 10, 20, 190, 380, 370, 215, 55, 15, 6]),
    ("Nagpur",              21.15,  79.09, [14, 20, 15, 9, 12, 181, 373, 299, 178, 58, 17, 10]),
    ("Ahmedabad",           23.03,  72.58, [2, 1, 1, 2, 7, 101, 296, 231, 133, 20, 7, 2]),
    ("Rajkot",              22.30,  70.80, [1, 1, 1, 1, 4, 90, 275, 180, 115, 20, 7, 2]),
    ("Surat",               21.17,  72.83, [1, 0, 0, 1, 3, 215, 410, 265, 185, 35, 15, 3]),
    ("Mumbai",              19.09,  72.87, [1, 0, 0, 1, 12, 527, 840, 585, 332, 89, 17, 3]),
    ("Nashik",              19.99,  73.79, [1, 1, 2, 5, 20, 145, 215, 155, 140, 70, 25, 5]),
    ("Pune",                18.52,  73.86, [1, 1, 2, 11, 32, 145, 187, 106, 145, 86, 32, 7]),
    ("Panaji",              15.50,  73.83, [1, 0, 3, 15, 85, 880, 995, 585, 285, 120, 30, 20]),
    ("Hyderabad",           17.38,  78.47, [8, 10, 13, 24, 30, 110, 165, 180, 166, 86, 26, 6]),
    ("Visakhapatnam",       17.69,  83.22, [10, 15, 10, 20, 55, 100, 140, 145, 175, 215, 105, 20]),
    ("Vijayawada",          16.51,  80.65, [7, 10, 10, 20, 55, 95, 145, 160, 180, 175, 90, 20]),
    ("Bengaluru",           12.97,  77.59, [2, 7, 12, 45, 110, 86, 111, 148, 196, 166, 58, 20]),
    ("Mysuru",              12.30,  76.64, [3, 5, 12, 55, 120, 65, 75, 90, 140, 175, 70, 20]),
    ("Chennai",             13.08,  80.27, [23, 7, 5, 15, 52, 53, 84, 120, 118, 268, 309, 140]),
    ("Coimbatore",          11.02,  76.96, [10, 10, 20, 60, 80, 40, 50, 45, 50, 155, 120, 45]),
    ("Madurai",              9.93,  78.12, [25, 15, 15, 45, 60, 35, 50, 80, 105, 170, 145, 60]),
    ("Kochi",                9.93,  76.27, [20, 25, 50, 120, 300, 700, 595, 385, 255, 335, 175, 45]),
    ("Thiruvananthapuram",   8.52,  76.94, [20, 20, 45, 120, 240, 330, 215, 165, 145, 270, 200, 70]),
    ("Port Blair",          11.62,  92.73, [40, 20, 10, 60, 355, 485, 400, 425, 480, 290, 235, 175]),
]

# Which months the south-west monsoon owns, for the phase label only.
MONSOON_MONTHS = (6, 7, 8, 9)
PRE_MONSOON_MONTHS = (4, 5)

_loaded_from = "built-in table"
_table = None


def _normals():
    global _table
    if _table is None:
        _table = list(NORMALS)
    return _table


def load_csv(path):
    """
    Replace the built-in normals with a real table.

    Columns: name,lat,lon,jan..dec. Anything unparseable is skipped rather
    than silently zeroed — a station with no rainfall would quietly rank a
    ward as safe.
    """
    global _table, _loaded_from
    rows = []
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            try:
                monthly = [float(row[m]) for m in MONTHS]
                rows.append((row["name"].strip(), float(row["lat"]),
                             float(row["lon"]), monthly))
            except (KeyError, TypeError, ValueError):
                continue
    if not rows:
        raise ValueError("No usable rows in %s" % path)
    _table, _loaded_from = rows, os.path.basename(path)
    return len(rows)


def try_load(data_dir):
    """Pick up data/rainfall_normals.csv if somebody has put one there."""
    path = os.path.join(data_dir, "rainfall_normals.csv")
    if os.path.isfile(path):
        try:
            return load_csv(path)
        except (OSError, ValueError):
            return 0
    return 0


def nearest_station(lat, lon):
    """
    The closest station in the table, with the distance stated.

    Distance is reported because it is the honest measure of how much the
    number is worth: a station 400 km away is a different climate, and the
    caller is told so rather than left to assume otherwise.
    """
    if lat is None or lon is None:
        return None
    best, best_km = None, None
    for name, slat, slon, monthly in _normals():
        # Equirectangular is plenty for picking a nearest station.
        dx = math.radians(lon - slon) * math.cos(math.radians((lat + slat) / 2))
        dy = math.radians(lat - slat)
        km = 6371.0 * math.hypot(dx, dy)
        if best_km is None or km < best_km:
            best, best_km = (name, slat, slon, monthly), km
    name, slat, slon, monthly = best
    return {"name": name, "lat": slat, "lon": slon, "monthly_mm": monthly,
            "distance_km": round(best_km, 1), "table": _loaded_from}


def normal_mm_over(station, start, days):
    """
    Normal rainfall across a window, apportioned by day.

    A fortnight that straddles the end of June and the start of July takes
    part of each month's normal, in proportion to the days it covers.
    """
    total = 0.0
    daily = []
    for offset in range(int(days)):
        day = start + timedelta(days=offset)
        month_days = _days_in_month(day.year, day.month)
        share = station["monthly_mm"][day.month - 1] / float(month_days)
        total += share
        daily.append({"date": day.date().isoformat(), "mm": round(share, 2)})
    return round(total, 1), daily


def _days_in_month(year, month):
    if month == 12:
        return 31
    return (datetime(year, month + 1, 1) - datetime(year, month, 1)).days


def phase_for(month):
    if month in MONSOON_MONTHS:
        return "monsoon"
    if month in PRE_MONSOON_MONTHS:
        return "pre-monsoon"
    if month in (10, 11):
        return "post-monsoon"
    return "dry"


def factor_for_mm(expected_mm):
    """
    Millimetres of rain -> the multiplier in the formula.

        factor = 1 + expected_mm / 60,  capped at 5

    One when the fortnight is dry, so a dry-season priority is exactly the
    growth rate times the traffic and nothing is invented. The cap exists
    because a fortnight of 900 mm does not make a crack fifteen times more
    urgent than a dry one — past a point the crack is simply saturated.
    """
    if expected_mm is None:
        return 1.0
    return round(min(MAX_FACTOR, 1.0 + max(0.0, float(expected_mm)) / REFERENCE_MM), 3)


def forecast(lat, lon, start=None, days=DEFAULT_WINDOW_DAYS,
             override_mm=None, override_basis="forecast", override_note=""):
    """
    What rain is expected over the next `days` at this spot, and the factor.

    `override_mm` is a real figure somebody has supplied — an IMD district
    bulletin, a rain gauge at the depot. When it is present the normals are
    not consulted at all, and `basis` says which of the two answered.
    """
    start = start or datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    days = max(1, int(days))

    if isinstance(override_mm, (int, float)):
        expected = round(float(override_mm), 1)
        return {
            "expected_mm": expected, "window_days": days,
            "window_from": start.date().isoformat(),
            "window_to": (start + timedelta(days=days - 1)).date().isoformat(),
            "factor": factor_for_mm(expected),
            "basis": override_basis,
            "station": None, "distance_km": None,
            "phase": phase_for(start.month),
            "daily": [],
            "note": override_note or "Supplied figure, not the built-in normals.",
        }

    station = nearest_station(lat, lon)
    if station is None:
        return {
            "expected_mm": None, "window_days": days,
            "window_from": start.date().isoformat(),
            "window_to": (start + timedelta(days=days - 1)).date().isoformat(),
            "factor": 1.0, "basis": "none", "station": None, "distance_km": None,
            "phase": phase_for(start.month), "daily": [],
            "note": ("This photo has no position, so no rainfall can be looked up. "
                     "The rain term is left at 1.0 — it neither raises nor lowers "
                     "the priority."),
        }

    expected, daily = normal_mm_over(station, start, days)
    far = station["distance_km"] > 150
    note = ("Monthly normal for %s, %.0f km away, apportioned across the %d days. "
            "A normal is what a fortnight like this usually brings, not a forecast. "
            "Post a real forecast to /api/rainfall and it is used instead."
            % (station["name"], station["distance_km"], days))
    if far:
        note += (" That station is a long way off — treat this as a climate band, "
                 "not a local figure.")
    return {
        "expected_mm": expected, "window_days": days,
        "window_from": start.date().isoformat(),
        "window_to": (start + timedelta(days=days - 1)).date().isoformat(),
        "factor": factor_for_mm(expected),
        "basis": "normal",
        "station": station["name"], "distance_km": station["distance_km"],
        "source_table": station["table"],
        "phase": phase_for(start.month),
        "daily": daily,
        "note": note,
    }
