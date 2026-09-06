"""
Growth, and the number underneath it: lead time.

A crack measured once is a defect. Measured across days it has a rate, and
a rate has a date attached. Lead time is the distance between two dates:

    lead time = the day the crack is predicted to cross the seal threshold
              - the day it was first seen at all

That is the warning a ward engineer would have got, in days, if this
system had been running. Nobody in India publishes that figure today,
because nobody re-photographs the same square metre of road on a schedule.
It is the one output of this prototype that is not available anywhere else,
so it is computed honestly: from a least-squares fit over the readings
actually stored, with the fit quality reported next to it.
"""

from datetime import datetime, timedelta, timezone

DEFAULT_THRESHOLD_MM = 150.0


def _parse(ts):
    if not ts:
        return None
    text = str(ts).replace("Z", "+00:00")
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                stamp = datetime.strptime(text[:19], fmt)
                break
            except ValueError:
                continue
        else:
            return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def linear_fit(days, lengths):
    """
    Least squares through the readings: mm/day, intercept, and R-squared.

    R-squared is reported because two points always fit a line perfectly
    and that fact must not be allowed to look like confidence.
    """
    n = len(days)
    if n < 2:
        return None, None, None
    mean_x = sum(days) / n
    mean_y = sum(lengths) / n
    sxx = sum((x - mean_x) ** 2 for x in days)
    if sxx <= 1e-9:
        return None, None, None          # every reading on the same day
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(days, lengths))
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x
    sst = sum((y - mean_y) ** 2 for y in lengths)
    if sst <= 1e-9:
        r2 = 1.0 if abs(slope) < 1e-9 else 0.0
    else:
        ssr = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(days, lengths))
        r2 = max(0.0, 1.0 - ssr / sst)
    return slope, intercept, r2


def analyse(observations, threshold_mm=DEFAULT_THRESHOLD_MM, now=None):
    """
    Turn one site's readings into a verdict, a date and a lead time.

    `observations` are dicts with `captured_at` and `length_mm`, in any
    order. Readings without a length are ignored rather than guessed at.
    """
    now = now or datetime.now(timezone.utc)
    threshold = float(threshold_mm or DEFAULT_THRESHOLD_MM)

    points = []
    for o in observations:
        stamp = _parse(o.get("captured_at"))
        length = o.get("length_mm")
        if stamp and isinstance(length, (int, float)):
            points.append((stamp, float(length), o))
    points.sort(key=lambda p: p[0])

    result = {
        "readings": len(points), "threshold_mm": round(threshold, 1),
        "baseline": None, "latest": None, "observed_days": None,
        "total_growth_mm": None, "mm_per_day": None, "mm_per_week": None,
        "fit_r2": None, "predicted_cross_date": None, "lead_time_days": None,
        "days_remaining": None, "verdict": "NO DATA",
        "headline": "No readings yet.",
        "detail": "Photograph this spot to start the record.",
        "series": [],
    }
    if not points:
        # Photographs with no millimetre figure are not "no readings" — saying
        # so sends someone back out to re-photograph a spot that is already
        # covered, when what is missing is a scale.
        unmeasured = len(list(observations))
        if unmeasured:
            result["verdict"] = "NO SCALE"
            result["headline"] = ("%d photograph%s here, none of them measured."
                                  % (unmeasured, "" if unmeasured == 1 else "s"))
            result["detail"] = ("Millimetres need either a calibration or the lens data "
                                "from the photo. Set the shooting distance on the capture "
                                "tab, or calibrate once in the training tab — the readings "
                                "already stored will not be re-measured, so photograph the "
                                "spot again afterwards.")
        return result

    first_stamp, first_len, first_obs = points[0]
    last_stamp, last_len, last_obs = points[-1]
    span_days = (last_stamp - first_stamp).total_seconds() / 86400.0

    result["baseline"] = {
        "observation_id": first_obs.get("id"), "at": first_stamp.isoformat(),
        "length_mm": round(first_len, 1), "photo_sha": first_obs.get("photo_sha"),
        "label": first_obs.get("label") or "Baseline",
    }
    result["latest"] = {
        "observation_id": last_obs.get("id"), "at": last_stamp.isoformat(),
        "length_mm": round(last_len, 1), "photo_sha": last_obs.get("photo_sha"),
        "label": last_obs.get("label") or "Latest",
    }
    result["series"] = [{
        "observation_id": o.get("id"), "at": stamp.isoformat(),
        "day": round((stamp - first_stamp).total_seconds() / 86400.0, 3),
        "length_mm": round(length, 1), "photo_sha": o.get("photo_sha"),
        "label": o.get("label") or "",
        "over_threshold": length >= threshold,
    } for stamp, length, o in points]

    result["observed_days"] = round(span_days, 2)
    result["total_growth_mm"] = round(last_len - first_len, 1)

    if len(points) == 1:
        result["verdict"] = "BASELINE ONLY"
        result["headline"] = "Baseline recorded at %.0f mm." % first_len
        result["detail"] = ("One reading is a defect, not a trend. "
                            "Photograph this spot again on another day and a rate appears.")
        if first_len >= threshold:
            result["verdict"] = "SEAL NOW"
            result["headline"] = "Already past the %.0f mm threshold." % threshold
            result["detail"] = "This one is a sealing job today, before any trend is needed."
        return result

    days = [(s - first_stamp).total_seconds() / 86400.0 for s, _, _ in points]
    lengths = [l for _, l, _ in points]
    slope, intercept, r2 = linear_fit(days, lengths)

    if slope is None:
        result["verdict"] = "SAME DAY"
        result["headline"] = "%d readings, all on one day." % len(points)
        result["detail"] = ("A growth rate needs readings from different days. "
                            "Come back tomorrow morning.")
        return result

    result["mm_per_day"] = round(slope, 3)
    result["mm_per_week"] = round(slope * 7, 2)
    result["fit_r2"] = round(r2, 3)

    if last_len >= threshold:
        crossed = next((s for s, l, _ in points if l >= threshold), last_stamp)
        result["predicted_cross_date"] = crossed.isoformat()
        result["lead_time_days"] = round((crossed - first_stamp).total_seconds() / 86400.0, 1)
        result["days_remaining"] = 0
        result["verdict"] = "SEAL NOW"
        result["headline"] = "Past the %.0f mm threshold." % threshold
        result["detail"] = ("Crossed %.1f days after it was first seen, growing %.2f mm a day."
                            % (result["lead_time_days"], slope))
        return result

    if slope <= 0.0:
        result["verdict"] = "STABLE"
        result["headline"] = "Not growing."
        result["detail"] = ("%.2f mm a day over %.1f days. Keep it on the round, "
                            "but it is not a sealing job." % (slope, span_days))
        return result

    days_to_cross = (threshold - last_len) / slope
    cross_stamp = last_stamp + timedelta(days=days_to_cross)
    result["predicted_cross_date"] = cross_stamp.isoformat()
    result["lead_time_days"] = round((cross_stamp - first_stamp).total_seconds() / 86400.0, 1)
    result["days_remaining"] = round((cross_stamp - now).total_seconds() / 86400.0, 1)

    if result["days_remaining"] <= 14:
        result["verdict"] = "SEAL SOON"
    elif result["days_remaining"] <= 45:
        result["verdict"] = "MONITOR"
    else:
        result["verdict"] = "WATCH"

    result["headline"] = "Crosses %.0f mm in about %.0f days." % (threshold, max(0, result["days_remaining"]))
    result["detail"] = ("Growing %.2f mm a day (fit R-squared %.2f over %d readings). "
                        "Lead time from first sighting: %.0f days."
                        % (slope, r2, len(points), result["lead_time_days"]))
    if r2 < 0.6:
        result["detail"] += " The fit is loose — treat the date as a rough one."
    return result


def lead_time_summary(per_site):
    """
    Roll the per-site lead times into the fleet number worth quoting.

    Only sites where a threshold crossing is actually dated are counted, so
    the mean cannot be flattered by cracks that never grew.
    """
    values = [s["lead_time_days"] for s in per_site
              if isinstance(s.get("lead_time_days"), (int, float))]
    if not values:
        return {"sites_with_lead_time": 0, "mean_days": None,
                "median_days": None, "min_days": None, "max_days": None}
    values.sort()
    mid = len(values) // 2
    median = values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2
    return {
        "sites_with_lead_time": len(values),
        "mean_days": round(sum(values) / len(values), 1),
        "median_days": round(median, 1),
        "min_days": round(values[0], 1),
        "max_days": round(values[-1], 1),
    }
