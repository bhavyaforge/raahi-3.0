"""
The JSON API. Everything the browser cannot honestly do for itself happens
here: reading GPS out of a file's EXIF, deciding whether today's photo is
yesterday's crack, keeping the record, and scoring a detector.

Every handler returns (status_code, payload_dict).
"""

import base64
import json
import os
import re
from datetime import datetime, timedelta, timezone

from . import exif, geo, geotag, growth, metrics, rainfall, risk, traffic
from .store import now_iso

MAX_PHOTO_BYTES = 24 * 1024 * 1024
DEFAULT_THRESHOLD_MM = 150.0


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status
        self.message = message


DAY_PATTERNS = (
    re.compile(r"(?:^|[^a-z0-9])day[\s_\-]?0*(\d{1,3})(?:[^0-9]|$)", re.I),
    re.compile(r"(?:^|[^a-z0-9])(?:pass|round|visit|d)[\s_\-]?0*(\d{1,3})(?:[^0-9]|$)", re.I),
)


def _day_from_name(filename):
    """
    Read a day number out of a file name, or return None.

    `day03.jpg`, `day_3.png`, `pass_12_20260906.png`, `d18.jpeg` all work.
    Anything else returns None rather than a guess: a wrong day number would
    put a reading on the wrong date and bend the growth line.
    """
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    for pattern in DAY_PATTERNS:
        found = pattern.search(stem)
        if found:
            value = int(found.group(1))
            if 1 <= value <= 999:
                return value
    return None


def _parse_time(text):
    if not text:
        return None
    try:
        stamp = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


class Api:
    def __init__(self, store):
        self.store = store

    # -- helpers -----------------------------------------------------------
    def _threshold(self):
        return float(self.store.get_setting("threshold_mm", DEFAULT_THRESHOLD_MM))

    def _scale_for(self, site_id, image_width, focal_35mm, distance_mm):
        """
        Work out millimetres-per-pixel without asking the user anything.

        Three sources, best first:

          1. a calibration measured for this exact site
          2. the global calibration from the training tab, rescaled if this
             photo is a different pixel width than the one it was measured on
          3. the lens itself — focal length and shooting distance are enough
             for the pinhole relation, no reference object required

        Returns (mm_per_px, source_label). Both None when nothing is known,
        in which case the reading is stored in pixels and clearly labelled.
        """
        site_cal = self.store.get_calibration(site_id) if site_id else None
        if site_cal:
            return site_cal["mm_per_px"], "calibration for this site"

        global_cal = self.store.get_calibration("global")
        if global_cal:
            mm_per_px = global_cal["mm_per_px"]
            ref_width = global_cal["image_width"]
            if ref_width and image_width and abs(image_width - ref_width) > 4:
                # Same framing at a different resolution: a pixel covers less
                # ground when there are more of them across the same scene.
                mm_per_px = mm_per_px * (float(ref_width) / float(image_width))
                return mm_per_px, "calibration rescaled %d px to %d px" % (ref_width, image_width)
            return mm_per_px, "calibration"

        optical = exif.mm_per_pixel_from_optics(focal_35mm, image_width, distance_mm)
        if optical:
            return optical, "lens optics (%.0f mm equiv at %.0f mm)" % (
                float(focal_35mm), float(distance_mm))
        return None, None

    def _site_summary(self, site):
        obs = self.store.observations_for(site["id"])
        report = growth.analyse(obs, site.get("threshold_mm") or self._threshold())
        out = dict(site)
        out["observations"] = len(obs)
        out["growth"] = report
        out["last_seen"] = obs[-1]["captured_at"] if obs else None
        out["first_seen"] = obs[0]["captured_at"] if obs else None
        return out

    # -- GET ---------------------------------------------------------------
    def get_state(self):
        sites = [self._site_summary(s) for s in self.store.list_sites()]
        trials = self.store.list_trials()
        mean_error = (sum(t["error_mm"] for t in trials) / len(trials)) if trials else None
        return 200, {
            "threshold_mm": self._threshold(),
            "calibration": self.store.get_calibration("global"),
            "site_calibrations": self.store.list_calibrations(),
            "sites": len(sites),
            "observations": sum(s["observations"] for s in sites),
            "lead_time": growth.lead_time_summary([s["growth"] for s in sites]),
            "trials": len(trials),
            "mean_error_mm": None if mean_error is None else round(mean_error, 2),
            "detection_evaluated": self.store.latest_eval() is not None,
            "risk": risk.summary([self._assess(s) for s in sites]) if sites else None,
            "formula": "priority = growth rate (mm/day) × rainfall factor × traffic factor",
        }

    def get_sites(self):
        return 200, {"sites": [self._site_summary(s) for s in self.store.list_sites()]}

    def get_site(self, site_id):
        site = self.store.get_site(site_id)
        if not site:
            raise ApiError("No such site: %s" % site_id, 404)
        detail = self._site_summary(site)
        detail["observation_list"] = self.store.observations_for(site_id)
        return 200, detail

    def _assess(self, summary):
        """One spot through the risk engine, using whatever context it carries."""
        return risk.assess(summary, summary["growth"],
                           rain_override_mm=summary.get("rain_mm_override"))

    def get_schedule(self):
        """
        The ranked seal list — the deck's fourth box, built from real readings.

            priority = growth rate × rainfall forecast × traffic

        Sorted by that product, worst first, so the top row is where a crew
        should be sent. Spots with no growth rate yet fall to the bottom in
        one block: they were never re-photographed, which is not the same
        thing as being safe, and the list must not imply otherwise.
        """
        rows, reports, assessed = [], [], []
        for site in self.store.list_sites():
            summary = self._site_summary(site)
            report = summary["growth"]
            reports.append(report)
            verdict = self._assess(summary)
            assessed.append(verdict)

        for verdict in risk.rank(assessed):
            site = self.store.get_site(verdict["site_id"])
            summary = self._site_summary(site)
            report = summary["growth"]
            rows.append({
                "rank": verdict["rank"],
                "site_id": site["id"], "name": site["name"],
                "lat": site["lat"], "lon": site["lon"],
                "road_class": verdict["traffic"]["road_class_label"],
                "observations": summary["observations"],
                "latest_mm": (report["latest"] or {}).get("length_mm"),
                "baseline_mm": (report["baseline"] or {}).get("length_mm"),
                "mm_per_day": report.get("mm_per_day"),
                "mm_per_week": report.get("mm_per_week"),
                "days_remaining": report.get("days_remaining"),
                "lead_time_days": report.get("lead_time_days"),
                "predicted_cross_date": report.get("predicted_cross_date"),
                "verdict": report["verdict"],
                "fit_r2": report.get("fit_r2"),
                "rain_factor": verdict["rain"]["factor"],
                "rain_mm": verdict["rain"]["expected_mm"],
                "rain_basis": verdict["rain"]["basis"],
                "traffic_factor": verdict["traffic"]["factor"],
                "priority": verdict["score"],
                "band": verdict["band"],
                "action": verdict["action"],
                "formula": verdict["formula"],
                "effective_mm_per_day": verdict["effective_mm_per_day"],
                "monsoon_cross_date": verdict["monsoon_cross_date"],
                "monsoon_days_remaining": verdict["monsoon_days_remaining"],
                "days_bought_by_rain": verdict["days_bought_by_rain"],
            })
        return 200, {"rows": rows,
                     "lead_time": growth.lead_time_summary(reports),
                     "risk": risk.summary(assessed)}

    def get_risk(self):
        """The formula's working, spot by spot, with every term named."""
        assessed = [self._assess(self._site_summary(s)) for s in self.store.list_sites()]
        return 200, {
            "sites": risk.rank(assessed),
            "summary": risk.summary(assessed),
            "terms": {
                "growth": ("Millimetres a day, from a least-squares fit over the "
                           "readings actually stored for that spot. Measured, not modelled."),
                "rain": ("1 + expected millimetres over the next %d days / %.0f, capped at %.0f. "
                         "One in a dry fortnight, so a dry-season priority is growth × traffic "
                         "and nothing invented." % (rainfall.DEFAULT_WINDOW_DAYS,
                                                    rainfall.REFERENCE_MM,
                                                    rainfall.MAX_FACTOR)),
                "traffic": ("sqrt(commercial vehicles per day / %.0f), clamped %.1f to %.1f. "
                            "A residential lane is exactly 1."
                            % (traffic.REFERENCE_CVPD, traffic.MIN_FACTOR, traffic.MAX_FACTOR)),
                "score": ("The product is an effective growth rate in mm/day, mapped "
                          "to 0-100 on a log scale: %.2f mm/day scores 0, %.0f mm/day "
                          "scores 100. Logarithmic because the product spans orders "
                          "of magnitude and a straight line would pin every spot worth "
                          "looking at to 100."
                          % (risk.SCORE_FLOOR, risk.SCORE_CEILING)),
            },
            "road_classes": traffic.catalogue(),
            "assumptions": [
                "The rainfall reference (%.0f mm a fortnight), the traffic exponent (0.5) "
                "and the score's floor and ceiling (%.2f and %.0f mm/day effective) are "
                "chosen constants, not fitted ones. They are the first thing to re-fit "
                "against a season of real readings."
                % (rainfall.REFERENCE_MM, risk.SCORE_FLOOR, risk.SCORE_CEILING),
                "Bundled rainfall figures are approximate monthly normals, not a forecast. "
                "Post a real forecast to /api/rainfall and it is used instead.",
                "Traffic counts default to a class table until a municipality supplies its own.",
            ],
        }

    def get_rainfall(self, lat=None, lon=None, days=None):
        """What rain is expected at a position, and where the figure came from."""
        try:
            lat = float(lat) if lat is not None else None
            lon = float(lon) if lon is not None else None
        except (TypeError, ValueError):
            raise ApiError("lat and lon must be numbers.")
        window = int(days or rainfall.DEFAULT_WINDOW_DAYS)
        return 200, rainfall.forecast(lat, lon, days=window)

    def get_report(self, site_id):
        """
        The whole loop for one spot, in the order the deck tells it.

            DETECT -> TRACK -> PREDICT -> SCHEDULE -> VERIFY

        Everything a ward engineer would be handed about one crack: where it
        is and how we know, every pass with its date and length, the growth
        rate and the fit behind it, the formula worked out term by term, the
        seal-by date, and whether tomorrow's pass confirmed the seal held.
        """
        site = self.store.get_site(site_id)
        if not site:
            raise ApiError("No such site: %s" % site_id, 404)

        summary = self._site_summary(site)
        report = summary["growth"]
        obs = self.store.observations_for(site_id)
        verdict = self._assess(summary)

        first = _parse_time(obs[0]["captured_at"]) if obs else None
        passes = []
        for row in obs:
            stamp = _parse_time(row["captured_at"])
            day = (round((stamp - first).total_seconds() / 86400.0) + 1) if (stamp and first) else None
            passes.append({
                "observation_id": row["id"],
                "day": row["day_index"] or day,
                "captured_at": row["captured_at"],
                "length_mm": row["length_mm"],
                "arc_px": row["arc_px"],
                "growth_since_baseline_mm": (
                    round(row["length_mm"] - obs[0]["length_mm"], 1)
                    if isinstance(row["length_mm"], (int, float))
                    and isinstance(obs[0]["length_mm"], (int, float)) else None),
                "lat": row["lat"], "lon": row["lon"],
                "gps_source": row["gps_source"],
                "accuracy_m": row["accuracy_m"],
                "heading_deg": row["direction_deg"],
                "geotag_written": bool(row["geotag_written"]),
                "auto_shutter": bool(row["auto_shutter"]),
                "photo_sha": row["photo_sha"],
                "photo_name": row["photo_name"],
                "label": row["label"],
                "scale_source": row["scale_source"],
                "match": json.loads(row["match_json"]) if row["match_json"] else None,
            })

        measured = [p for p in passes if isinstance(p["length_mm"], (int, float))]
        gps_passes = [p for p in passes if p["lat"] is not None]
        from_exif = [p for p in passes if p["gps_source"] and p["gps_source"].startswith("exif")]
        stamped = [p for p in passes if p["geotag_written"]]

        return 200, {
            "site": {
                "id": site["id"], "name": site["name"],
                "lat": site["lat"], "lon": site["lon"],
                "direction_deg": site["direction_deg"],
                "road_name": site.get("road_name"), "ward": site.get("ward"),
                "road_class": verdict["traffic"]["road_class"],
                "road_class_label": verdict["traffic"]["road_class_label"],
                "threshold_mm": site.get("threshold_mm") or self._threshold(),
                "position_text": self._position_text(site["lat"], site["lon"]),
                "position_dms": self._position_dms(site["lat"], site["lon"]),
                "map_url": ("https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=19/%.6f/%.6f"
                            % (site["lat"], site["lon"], site["lat"], site["lon"]))
                           if site["lat"] is not None else None,
            },
            "detect": {
                "passes": len(passes),
                "measured": len(measured),
                "auto_shutter": len([p for p in passes if p["auto_shutter"]]),
                "note": ("Every pass here is a photograph that was taken, measured and "
                         "stored. Nothing on this page is simulated."),
            },
            "track": {
                "days_covered": report.get("observed_days"),
                "with_position": len(gps_passes),
                "position_from_camera": len(from_exif),
                "position_written_by_us": len(stamped),
                "radius_m": geo.DEFAULT_RADIUS_M,
                "heading_tolerance_deg": geo.HEADING_TOLERANCE_DEG,
                "note": ("A photo is the same spot when position and heading agree, or "
                         "when the scene itself is unmistakable. Every match below says "
                         "which of those decided it."),
            },
            "predict": report,
            "schedule": verdict,
            "verify": self._verify(passes, report),
            "passes": passes,
            "series": report.get("series") or [],
        }

    @staticmethod
    def _verify(passes, report):
        """
        The deck's fifth box: did the seal hold?

        There is no repair record in this build, so this reports the one
        thing the readings can honestly support — whether the last pass
        continued the trend or broke it. A length that stops growing after a
        crew visited is the evidence a seal held; a length that jumps is the
        evidence it did not. It says which, and says when it cannot say.
        """
        measured = [p for p in passes if isinstance(p["length_mm"], (int, float))]
        if len(measured) < 3:
            return {"state": "NOT ENOUGH PASSES",
                    "note": ("Verification needs at least three measured passes: two to "
                             "establish the trend and one to test it against.")}
        last, previous = measured[-1], measured[-2]
        step = round(last["length_mm"] - previous["length_mm"], 1)
        rate = report.get("mm_per_day")
        gap_days = None
        a, b = _parse_time(previous["captured_at"]), _parse_time(last["captured_at"])
        if a and b:
            gap_days = round((b - a).total_seconds() / 86400.0, 2)
        expected = round(rate * gap_days, 1) if (isinstance(rate, (int, float)) and gap_days) else None

        if expected is None:
            return {"state": "NO TREND", "last_step_mm": step,
                    "note": "No rate to compare the last pass against yet."}
        if step <= 0.2 and expected > 0.5:
            state, note = "HELD", ("The last pass did not grow, and the trend said it should "
                                   "have gained %.1f mm. That is what a seal looks like in "
                                   "the readings." % expected)
        elif step > expected * 1.8:
            state, note = "WORSE THAN TREND", ("The last pass gained %.1f mm where the trend "
                                               "said %.1f. Something changed — rain, a utility "
                                               "cut, or a failed repair." % (step, expected))
        else:
            state, note = "ON TREND", ("The last pass gained %.1f mm against an expected "
                                       "%.1f. Still growing as predicted." % (step, expected))
        return {"state": state, "last_step_mm": step, "expected_step_mm": expected,
                "gap_days": gap_days, "note": note}

    def get_traffic_classes(self):
        return 200, {"classes": traffic.catalogue(),
                     "reference_cvpd": traffic.REFERENCE_CVPD,
                     "note": ("Class defaults stand in until a municipality supplies its own "
                              "counts. Set a measured figure per spot and it is used instead.")}

    def get_detection_quality(self):
        latest = self.store.latest_eval()
        if not latest:
            return 200, {
                "evaluated": False,
                "message": ("No detector has been evaluated in this build. "
                            "The prototype measures crack growth from photographs; "
                            "it does not yet classify damage. Score a model with "
                            "tools/eval_map.py and the numbers appear here, per class, "
                            "with the split named and the sample size stated."),
                "reference": {
                    "dataset": "RDD2022",
                    "images": 47420,
                    "countries": 6,
                    "note": ("Published reference point, not our result: best team F1 "
                             "0.769 at CRDDC'2022. Quoted only to say what we are "
                             "aiming at, never as our own score."),
                },
                "classes": [{"class": k, "name": v} for k, v in metrics.RDD2022_CLASSES.items()],
            }
        payload = latest["payload"]
        payload["evaluated"] = True
        payload["recorded_at"] = latest["created_at"]
        payload["history"] = [{"split": e["split"], "model": e["model"],
                               "map": e["payload"].get("map"),
                               "created_at": e["created_at"]}
                              for e in self.store.list_evals()[:10]]
        return 200, payload

    def get_trials(self):
        trials = self.store.list_trials()
        mean_error = (sum(t["error_mm"] for t in trials) / len(trials)) if trials else None
        worst = max((t["error_mm"] for t in trials), default=None)
        return 200, {
            "trials": trials, "count": len(trials),
            "mean_error_mm": None if mean_error is None else round(mean_error, 2),
            "worst_error_mm": None if worst is None else round(worst, 2),
        }

    def get_calibration(self):
        return 200, {"global": self.store.get_calibration("global"),
                     "all": self.store.list_calibrations()}

    # -- POST --------------------------------------------------------------
    def post_observation(self, body):
        """
        Take one photograph and everything the browser measured from it,
        and place it in the record.
        """
        detection = body.get("detection") or {}
        arc_px = detection.get("arc_px")
        span_px = detection.get("span_px")
        image_width = detection.get("image_width")
        image_height = detection.get("image_height")
        if not isinstance(arc_px, (int, float)) or arc_px <= 0:
            raise ApiError("No crack measurement came with this photo.")

        # --- the photo itself --------------------------------------------
        photo_name = body.get("filename") or ""
        meta = exif.read(b"")
        raw = b""
        raw_b64 = body.get("photo_b64") or ""
        if raw_b64:
            if "," in raw_b64[:64]:
                raw_b64 = raw_b64.split(",", 1)[1]
            try:
                raw = base64.b64decode(raw_b64, validate=False)
            except (ValueError, TypeError):
                raise ApiError("The photo did not decode.")
            if len(raw) > MAX_PHOTO_BYTES:
                raise ApiError("Photo is larger than %d MB." % (MAX_PHOTO_BYTES // (1024 * 1024)), 413)
            meta = exif.read(raw)

        # --- where was it taken ------------------------------------------
        browser = body.get("device_gps") or {}
        lat, lon = meta["lat"], meta["lon"]
        accuracy = meta["accuracy_m"]
        altitude = meta["altitude_m"]
        gps_source = "exif" if lat is not None else None
        if lat is None and isinstance(browser.get("lat"), (int, float)):
            lat, lon = float(browser["lat"]), float(browser["lon"])
            accuracy = browser.get("accuracy_m")
            altitude = browser.get("altitude_m")
            gps_source = "device"
        if lat is None and isinstance((body.get("manual_gps") or {}).get("lat"), (int, float)):
            manual = body["manual_gps"]
            lat, lon = float(manual["lat"]), float(manual["lon"])
            gps_source = "manual"

        heading = meta["direction_deg"]
        if heading is None and isinstance(browser.get("heading_deg"), (int, float)):
            heading = float(browser["heading_deg"]) % 360.0

        phash = geo.perceptual_hash(body.get("luma32") or [])

        # --- which spot is this ------------------------------------------
        candidate = {"lat": lat, "lon": lon, "direction_deg": heading, "phash": phash}
        sites = self.store.list_sites()
        radius = float(body.get("radius_m") or geo.DEFAULT_RADIUS_M)

        all_scores = []
        forced = body.get("site_id")
        if forced:
            site = self.store.get_site(forced)
            if not site:
                raise ApiError("No such site: %s" % forced, 404)
            match = {"site_id": site["id"], "same_spot": True, "confidence": 1.0,
                     "why": "you told us this is the same spot", "warning": None,
                     "distance_m": None, "heading_delta_deg": None, "hash_distance": None}
            revisit = True
        else:
            best, all_scores = geo.match_site(candidate, sites, radius)
            if best:
                site = self.store.get_site(best["site_id"])
                match, revisit = best, True
            else:
                site = self.store.create_site((body.get("site_name") or "").strip(),
                                              lat, lon, heading, phash, self._threshold())
                match = {"site_id": site["id"], "same_spot": False, "confidence": 1.0,
                         "why": ("first photograph of this spot"
                                 if not all_scores else
                                 "no known site matched: " + all_scores[0]["why"]),
                         "warning": None,
                         "distance_m": None, "heading_delta_deg": None, "hash_distance": None}
                revisit = False

        # --- when was it taken -------------------------------------------
        #
        # Settled from the file's own clock before anything is written into
        # it. Do this after geotagging and the app would read back the stamp
        # it had just written and call it the camera's word.
        captured_at, when_from, day_index = self._when(body, meta, site["id"], photo_name)

        # --- stamp the fix into the file, the way a shutter does ----------
        #
        # A frame off the camera has no EXIF: the browser hands us pixels and
        # nothing else. A phone would have written the position into the file
        # at the instant the shutter fired, so we do it here, before the bytes
        # are stored. After this the photograph carries its own coordinates —
        # open it in any EXIF viewer and they are there — and the record and
        # the pixels cannot drift apart.
        #
        # A photo that arrived with its own GPS is never rewritten. The
        # camera's word beats ours.
        geotag_note = {"written": False, "why": "no photo bytes were sent"}
        if raw:
            if meta["lat"] is not None:
                geotag_note = {"written": False, "format": geotag.kind_of(raw),
                               "why": "the photo already carried its own GPS; "
                                      "stored byte for byte as the camera wrote it"}
            else:
                raw, geotag_note = geotag.geotag(
                    raw, lat, lon, taken=_parse_time(captured_at), heading=heading,
                    altitude_m=altitude, accuracy_m=accuracy,
                    focal_35mm=meta["focal_length_35mm"],
                    pixel_width=image_width, pixel_height=image_height,
                    model=("Auto shutter" if body.get("auto_shutter") else "Round camera"))
                if geotag_note.get("written") and gps_source == "device":
                    gps_source = "device, written into this file's EXIF"

        photo_sha = self.store.save_photo(raw, photo_name) if raw else None

        # What the stored file says about itself. `meta` is deliberately the
        # reading taken *before* anything was written, because that is what
        # decided the date and the position; this is what an EXIF viewer will
        # now show. Reporting the pre-write reading here would have the panel
        # say "no GPS clock in the file" about a file we had just put one in.
        stored_meta = exif.read(raw) if (raw and geotag_note.get("written")) else meta

        # --- how big is a pixel here -------------------------------------
        mm_per_px, scale_source = self._scale_for(
            site["id"], image_width, meta["focal_length_35mm"], body.get("distance_mm"))
        length_mm = round(arc_px * mm_per_px, 1) if mm_per_px else None

        confidence = detection.get("confidence")
        observation = self.store.add_observation({
            "site_id": site["id"], "captured_at": captured_at, "received_at": now_iso(),
            "lat": lat, "lon": lon, "altitude_m": altitude,
            "direction_deg": heading, "accuracy_m": accuracy, "gps_source": gps_source or "none",
            "phash": phash, "length_mm": length_mm, "arc_px": round(float(arc_px), 2),
            "span_px": round(float(span_px), 2) if span_px else None,
            "image_width": image_width, "mm_per_px": mm_per_px, "scale_source": scale_source,
            "photo_sha": photo_sha, "photo_name": photo_name,
            "label": (body.get("label") or "").strip(), "class_code": body.get("class_code"),
            "match_json": json.dumps(match),
            "day_index": day_index,
            "auto_shutter": 1 if body.get("auto_shutter") else 0,
            "detector_confidence": confidence if isinstance(confidence, (int, float)) else None,
            "geotag_written": 1 if geotag_note.get("written") else 0,
        })

        self.store.refresh_site_anchor(site["id"])
        site = self.store.get_site(site["id"])
        summary = self._site_summary(site)

        return 200, {
            "observation": observation,
            "site": summary,
            "revisit": revisit,
            "match": match,
            "position": self._position_block(lat, lon, gps_source, accuracy,
                                             altitude, heading, geotag_note),
            "timing": {"captured_at": captured_at, "source": when_from,
                       "day_index": day_index},
            "exif": dict({k: stored_meta[k] for k in ("has_exif", "make", "model", "taken_at",
                                                      "focal_length_mm", "focal_length_35mm",
                                                      "gps_time_utc", "altitude_m")},
                         written_by_raahi=bool(geotag_note.get("written"))),
            "geotag": geotag_note,
            "scale": {"mm_per_px": mm_per_px, "source": scale_source,
                      "length_mm": length_mm, "arc_px": round(float(arc_px), 2)},
            "fingerprint": phash,
            "risk": risk.assess(site, summary["growth"],
                                rain_override_mm=site.get("rain_mm_override")),
        }

    # -- when was this photograph taken ------------------------------------
    def _when(self, body, meta, site_id, filename):
        """
        Settle the date of a reading, and say which of four sources settled it.

        The photograph's own clock always wins. What this exists for is the
        other case: eighteen photographs of the same crack, one per day,
        uploaded in one sitting from a folder. Their file dates are all
        today, and eighteen readings on one day have no growth rate at all —
        the app would correctly say SAME DAY and give nothing back.

        So a day number may come with the upload, either sent by the browser
        or read out of the file name (`day03`, `day_3`, `pass_3`). The first
        one seen for a spot fixes day one; every later day number is measured
        from it. The record says so on the face of it, in `timing.source`,
        because a date the app worked out is not the same kind of fact as a
        date the camera wrote.
        """
        real = meta["taken_at"] or meta["gps_time_utc"]
        day_index = body.get("day_index")
        if not isinstance(day_index, int) or day_index <= 0:
            day_index = _day_from_name(filename)

        if real:
            return real, "the photograph's own EXIF clock", day_index

        if day_index:
            key = "day_origin:%s" % site_id
            origin_text = self.store.get_setting(key)
            origin = _parse_time(origin_text)
            if origin is None:
                origin = (datetime.now(timezone.utc)
                          - timedelta(days=day_index - 1)).replace(microsecond=0)
                self.store.set_setting(key, origin.isoformat())
            stamp = origin + timedelta(days=day_index - 1)
            return stamp.isoformat(), "day %d of the series you uploaded" % day_index, day_index

        return (body.get("captured_at") or now_iso()), "the moment it was uploaded", None

    # -- position, said in full --------------------------------------------
    @staticmethod
    def _position_block(lat, lon, source, accuracy, altitude, heading, geotag_note):
        """
        Every GPS number the app knows about this photograph, in one place.

        Decimal degrees for machines, degrees-minutes-seconds for the people
        who read survey drawings, and a map link so the claim can be checked
        against the world in one click.
        """
        return {
            "lat": lat, "lon": lon, "source": source or "none",
            "accuracy_m": accuracy, "altitude_m": altitude, "heading_deg": heading,
            "map_url": ("https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=19/%.6f/%.6f"
                        % (lat, lon, lat, lon)) if lat is not None else None,
            "text": Api._position_text(lat, lon),
            "dms": Api._position_dms(lat, lon),
            "written_into_photo": bool(geotag_note.get("written")),
            "exif_note": geotag_note.get("why"),
            "exif_tags": geotag_note.get("tags") or [],
        }

    @staticmethod
    def _position_text(lat, lon):
        if lat is None or lon is None:
            return "No position on this photo"
        ns = "N" if lat >= 0 else "S"
        ew = "E" if lon >= 0 else "W"
        return "%.6f %s, %.6f %s" % (abs(lat), ns, abs(lon), ew)

    @staticmethod
    def _position_dms(lat, lon):
        """The same fix in degrees, minutes and seconds — how EXIF stores it."""
        if lat is None or lon is None:
            return None

        def one(value, positive, negative):
            hemisphere = positive if value >= 0 else negative
            value = abs(value)
            degrees = int(value)
            minutes = int((value - degrees) * 60)
            seconds = (value - degrees - minutes / 60.0) * 3600.0
            return "%d\u00b0 %02d' %05.2f\" %s" % (degrees, minutes, seconds, hemisphere)

        return one(lat, "N", "S") + "  " + one(lon, "E", "W")

    def post_site_context(self, site_id, body):
        """
        Tell the app what kind of road this spot is on.

        Two of the three terms in the formula are about the place, not the
        crack, and this is where they are set:

            {"road_class": "urban_arterial",
             "commercial_vehicles_per_day": 1850,
             "rain_mm_override": 240,
             "road_name": "Ring Road", "ward": "Ward 14"}

        Everything is optional. What is not given keeps the class default,
        and the report says which figures were supplied and which were
        assumed — a defaulted number must never read like a surveyed one.
        """
        site = self.store.get_site(site_id)
        if not site:
            raise ApiError("No such site: %s" % site_id, 404)

        fields = {}
        road_class = body.get("road_class")
        if road_class is not None:
            key = str(road_class).strip().lower()
            if key and key not in traffic.CLASSES:
                raise ApiError("Unknown road class %r. Known: %s"
                               % (road_class, ", ".join(sorted(traffic.CLASSES))))
            fields["road_class"] = key or None

        for key, label in (("commercial_vehicles_per_day", "a vehicle count"),
                           ("rain_mm_override", "a rainfall figure")):
            if key in body:
                value = body[key]
                if value in (None, ""):
                    fields[key] = None
                elif isinstance(value, (int, float)) and value >= 0:
                    fields[key] = float(value)
                else:
                    raise ApiError("%s must be a number of at least zero." % label.capitalize())

        for key in ("road_name", "ward"):
            if key in body:
                fields[key] = (str(body[key]).strip() or None)

        if not fields:
            raise ApiError("Nothing to set. Send a road class, a vehicle count, "
                           "a rainfall figure, a road name or a ward.")

        self.store.update_site(site_id, **fields)
        summary = self._site_summary(self.store.get_site(site_id))
        return 200, {"site": summary, "risk": self._assess(summary)}

    def post_rainfall(self, body):
        """
        Hand the app a real rainfall forecast instead of the bundled normals.

        Either for one spot — {"site_id": "SITE-001", "expected_mm": 240} —
        or as a table of normals to replace the built-in one:
        {"csv_path": "imd_normals.csv"}. Real numbers always beat ours, and
        the answer says which was used.
        """
        if body.get("csv_path"):
            try:
                count = rainfall.load_csv(body["csv_path"])
            except (OSError, ValueError) as err:
                raise ApiError("Could not read that rainfall table: %s" % err)
            return 200, {"loaded": count, "table": body["csv_path"],
                         "note": "Built-in normals replaced for this session."}

        site_id = body.get("site_id")
        expected = body.get("expected_mm")
        if not site_id:
            raise ApiError("Name the spot this forecast is for, or give a csv_path.")
        if not isinstance(expected, (int, float)) or expected < 0:
            raise ApiError("expected_mm must be a number of at least zero.")
        if not self.store.get_site(site_id):
            raise ApiError("No such site: %s" % site_id, 404)
        self.store.update_site(site_id, rain_mm_override=float(expected))
        summary = self._site_summary(self.store.get_site(site_id))
        return 200, {"site": summary, "risk": self._assess(summary)}

    def post_calibration(self, body):
        """Training-side only. The person walking the road never sees this."""
        ref_mm = body.get("ref_mm")
        ref_px = body.get("ref_px")
        scope = (body.get("scope") or "global").strip() or "global"
        mm_per_px = body.get("mm_per_px")
        if mm_per_px is None:
            if not (isinstance(ref_mm, (int, float)) and ref_mm > 0
                    and isinstance(ref_px, (int, float)) and ref_px > 0):
                raise ApiError("Give either mm_per_px, or a reference length and its pixels.")
            mm_per_px = float(ref_mm) / float(ref_px)
        cal = self.store.set_calibration(scope, float(mm_per_px), body.get("image_width"),
                                         ref_mm, ref_px, body.get("note") or "")
        return 200, {"calibration": cal}

    def post_trial(self, body):
        drew, said = body.get("drew_mm"), body.get("said_mm")
        if not isinstance(drew, (int, float)) or not isinstance(said, (int, float)):
            raise ApiError("A trial needs both the ruler figure and the system figure.")
        self.store.add_trial(float(drew), float(said))
        return self.get_trials()

    def post_threshold(self, body):
        value = body.get("threshold_mm")
        if not isinstance(value, (int, float)) or value <= 0:
            raise ApiError("Threshold must be a positive number of millimetres.")
        self.store.set_setting("threshold_mm", float(value))
        for site in self.store.list_sites():
            self.store.update_site(site["id"], threshold_mm=float(value))
        return self.get_state()

    def post_detection_eval(self, body):
        """
        Score a detector's output against labelled ground truth.

        Accepts inline lists, or paths to JSON / Pascal-VOC directories so a
        real RDD2022 run can be scored without pasting megabytes into a form.
        """
        split = (body.get("split") or "").strip()
        if not split:
            raise ApiError("Name the test split. A score with no split is not a result.")

        gt = body.get("ground_truth")
        pred = body.get("predictions")
        if isinstance(gt, str):
            gt = (metrics.load_voc_xml(gt) if os.path.isdir(gt) else metrics.load_json(gt))
        if isinstance(pred, str):
            pred = metrics.load_json(pred)
        if not isinstance(gt, list) or not isinstance(pred, list):
            raise ApiError("Ground truth and predictions must each be a list, "
                           "or a path to one.")
        if not gt:
            raise ApiError("The ground truth is empty — there is nothing to score against.")

        try:
            payload = metrics.evaluate(gt, pred, split=split, model=body.get("model") or "",
                                       iou_main=float(body.get("iou", 0.5)),
                                       notes=body.get("notes") or "")
        except ValueError as err:
            raise ApiError(str(err))
        self.store.add_eval(split, body.get("model") or "", payload)
        return self.get_detection_quality()

    # -- DELETE ------------------------------------------------------------
    def delete_site(self, site_id):
        if not self.store.get_site(site_id):
            raise ApiError("No such site: %s" % site_id, 404)
        self.store.delete_site(site_id)
        return 200, {"deleted": site_id}

    def delete_observation(self, obs_id):
        obs = self.store.get_observation(obs_id)
        if not obs:
            raise ApiError("No such observation.", 404)
        self.store.delete_observation(obs_id)
        self.store.refresh_site_anchor(obs["site_id"])
        return 200, {"deleted": obs_id, "site_id": obs["site_id"]}

    def delete_trials(self):
        self.store.clear_trials()
        return self.get_trials()
