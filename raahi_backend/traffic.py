"""
Traffic — the third term of the formula.

    priority = growth rate  ×  rainfall forecast  ×  traffic

Two cracks growing at the same rate under the same sky are not equally
urgent. The one on a road that carries loaded trucks fails sooner and hurts
more people when it does, and pavement engineering has always said so: it
is axle load, not vehicle count, that breaks a road, which is why the
figure used here is *commercial* vehicles per day rather than total AADT.

WHAT THIS MODULE WILL NOT DO

It will not invent a count for a specific road. What it holds is a table of
class defaults — what a residential lane, a district road or a national
highway typically carries — so that a spot with no survey behind it still
gets ranked sensibly against its neighbours. Every answer says which of the
two it used:

    basis = "counted"    a real figure for this spot, given to us
    basis = "class"      the default for its road class
    basis = "assumed"    nothing known; treated as a residential lane

A municipality that has traffic counts should put them in. Set the class
and, if you have it, the count:

    POST /api/sites/SITE-001/context
    {"road_class": "urban_arterial", "commercial_vehicles_per_day": 1850}
"""

# The reference road: an ordinary residential lane on a collection round.
# Its factor is exactly 1.0, so priority on a quiet street is the growth
# rate times the rain and nothing else.
REFERENCE_CVPD = 300.0

MIN_FACTOR, MAX_FACTOR = 0.5, 4.0

# class key -> (label, typical commercial vehicles/day, what it means)
CLASSES = {
    "national_highway": ("National highway", 6000,
                         "Through freight. Heaviest axle loads on the network."),
    "state_highway": ("State highway", 2500,
                      "Inter-district traffic, mixed freight."),
    "major_district_road": ("Major district road", 1200,
                            "Feeds the highway network; loaded local freight."),
    "urban_arterial": ("Urban arterial", 2000,
                       "City spine — buses, tippers, delivery trucks all day."),
    "urban_collector": ("Urban collector", 700,
                        "Ward road feeding the arterials."),
    "residential_lane": ("Residential lane", 300,
                         "The reference road. Waste truck, autos, two-wheelers."),
    "service_road": ("Service road", 150,
                     "Frontage or approach road, light traffic."),
}

DEFAULT_CLASS = "residential_lane"


def factor_for_cvpd(cvpd):
    """
    Commercial vehicles per day -> the multiplier in the formula.

        factor = sqrt(cvpd / 300),  clamped to 0.5 - 4

    The square root is deliberate and worth arguing about. Pavement design
    uses a fourth-power law for *structural* damage from axle load, which
    would put a highway two hundred times above a lane and drown the other
    two terms entirely. What is being ranked here is how much sooner a crack
    that is already growing needs sealing, and for that a gentler curve
    keeps growth rate — the thing actually measured — in charge of the
    ranking. The exponent is an assumption, stated as one, and it is the
    first thing to re-fit once a season of readings exists.
    """
    try:
        value = float(cvpd)
    except (TypeError, ValueError):
        return 1.0
    if value <= 0:
        return MIN_FACTOR
    raw = (value / REFERENCE_CVPD) ** 0.5
    return round(max(MIN_FACTOR, min(MAX_FACTOR, raw)), 3)


def describe(road_class=None, cvpd=None):
    """
    Work out the traffic term for one spot, and say where it came from.

    Returns a dict with the factor, the count behind it, the class label and
    a plain sentence for the report.
    """
    key = (road_class or "").strip().lower() or None
    if key and key not in CLASSES:
        key = None

    if isinstance(cvpd, (int, float)) and cvpd > 0:
        count, basis = float(cvpd), "counted"
    elif key:
        count, basis = float(CLASSES[key][1]), "class"
    else:
        count, basis = REFERENCE_CVPD, "assumed"

    label = CLASSES[key][0] if key else CLASSES[DEFAULT_CLASS][0]
    factor = factor_for_cvpd(count)

    if basis == "counted":
        note = ("%.0f commercial vehicles a day, counted for this spot." % count)
    elif basis == "class":
        lowered = label.lower()
        article = "an" if lowered[0] in "aeiou" else "a"
        note = ("No count for this spot. Using the class default for %s %s: "
                "%.0f commercial vehicles a day." % (article, lowered, count))
    else:
        note = ("No road class and no count. Treated as a residential lane at "
                "%.0f commercial vehicles a day, which is the reference road — "
                "the traffic term is 1.0 and changes nothing." % count)

    return {
        "road_class": key or DEFAULT_CLASS,
        "road_class_label": label,
        "commercial_vehicles_per_day": round(count),
        "factor": factor,
        "basis": basis,
        "reference_cvpd": REFERENCE_CVPD,
        "note": note,
    }


def catalogue():
    """The class list, for a dropdown and for the report's own footnotes."""
    return [{"key": key, "label": label, "cvpd": cvpd, "about": about,
             "factor": factor_for_cvpd(cvpd)}
            for key, (label, cvpd, about) in CLASSES.items()]
