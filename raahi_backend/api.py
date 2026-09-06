"""
The JSON API. Everything the browser cannot honestly do for itself happens
here: reading GPS out of a file's EXIF, deciding whether today's photo is
yesterday's crack, keeping the record, and scoring a detector.

Every handler returns (status_code, payload_dict).
"""

import base64
import json
import os
from datetime import datetime, timezone

from . import exif, geo, growth, metrics
from .store import now_iso

MAX_PHOTO_BYTES = 24 * 1024 * 1024
DEFAULT_THRESHOLD_MM = 150.0


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status
        self.message = message


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

    def get_schedule(self):
        """
        The ranked list, built from real readings only.

        Sorted by how little time is left, so the top row is the one a crew
        should be sent to first. Sites with no rate yet fall to the bottom
        rather than being given an invented date.
        """
        rows, reports = [], []
        for site in self.store.list_sites():
            summary = self._site_summary(site)
            report = summary["growth"]
            reports.append(report)
            remaining = report.get("days_remaining")
            rows.append({
                "site_id": site["id"], "name": site["name"],
                "lat": site["lat"], "lon": site["lon"],
                "observations": summary["observations"],
                "latest_mm": (report["latest"] or {}).get("length_mm"),
                "baseline_mm": (report["baseline"] or {}).get("length_mm"),
                "mm_per_week": report.get("mm_per_week"),
                "days_remaining": remaining,
                "lead_time_days": report.get("lead_time_days"),
                "predicted_cross_date": report.get("predicted_cross_date"),
                "verdict": report["verdict"],
                "fit_r2": report.get("fit_r2"),
            })
        order = {"SEAL NOW": 0, "SEAL SOON": 1, "MONITOR": 2, "WATCH": 3,
                 "STABLE": 4, "BASELINE ONLY": 5, "SAME DAY": 5,
                 "NO SCALE": 6, "NO DATA": 7}
        rows.sort(key=lambda r: (order.get(r["verdict"], 9),
                                 r["days_remaining"] if r["days_remaining"] is not None else 1e9))
        return 200, {"rows": rows, "lead_time": growth.lead_time_summary(reports)}

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
        if not isinstance(arc_px, (int, float)) or arc_px <= 0:
            raise ApiError("No crack measurement came with this photo.")

        # --- the photo itself, byte for byte -----------------------------
        photo_sha = None
        photo_name = body.get("filename") or ""
        meta = exif.read(b"")
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
            photo_sha = self.store.save_photo(raw, photo_name)

        # --- where was it taken ------------------------------------------
        browser = body.get("device_gps") or {}
        lat, lon = meta["lat"], meta["lon"]
        accuracy = meta["accuracy_m"]
        gps_source = "exif" if lat is not None else None
        if lat is None and isinstance(browser.get("lat"), (int, float)):
            lat, lon = float(browser["lat"]), float(browser["lon"])
            accuracy = browser.get("accuracy_m")
            gps_source = "device"
        if lat is None and isinstance((body.get("manual_gps") or {}).get("lat"), (int, float)):
            manual = body["manual_gps"]
            lat, lon = float(manual["lat"]), float(manual["lon"])
            gps_source = "manual"

        heading = meta["direction_deg"]
        if heading is None and isinstance(browser.get("heading_deg"), (int, float)):
            heading = float(browser["heading_deg"]) % 360.0

        captured_at = (meta["taken_at"] or meta["gps_time_utc"]
                       or body.get("captured_at") or now_iso())

        phash = geo.perceptual_hash(body.get("luma32") or [])

        # --- which spot is this ------------------------------------------
        candidate = {"lat": lat, "lon": lon, "direction_deg": heading, "phash": phash}
        sites = self.store.list_sites()
        radius = float(body.get("radius_m") or geo.DEFAULT_RADIUS_M)

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

        # --- how big is a pixel here -------------------------------------
        mm_per_px, scale_source = self._scale_for(
            site["id"], image_width, meta["focal_length_35mm"], body.get("distance_mm"))
        length_mm = round(arc_px * mm_per_px, 1) if mm_per_px else None

        observation = self.store.add_observation({
            "site_id": site["id"], "captured_at": captured_at, "received_at": now_iso(),
            "lat": lat, "lon": lon, "altitude_m": meta["altitude_m"],
            "direction_deg": heading, "accuracy_m": accuracy, "gps_source": gps_source or "none",
            "phash": phash, "length_mm": length_mm, "arc_px": round(float(arc_px), 2),
            "span_px": round(float(span_px), 2) if span_px else None,
            "image_width": image_width, "mm_per_px": mm_per_px, "scale_source": scale_source,
            "photo_sha": photo_sha, "photo_name": photo_name,
            "label": (body.get("label") or "").strip(), "class_code": body.get("class_code"),
            "match_json": json.dumps(match),
        })

        self.store.refresh_site_anchor(site["id"])
        site = self.store.get_site(site["id"])

        return 200, {
            "observation": observation,
            "site": self._site_summary(site),
            "revisit": revisit,
            "match": match,
            "position": {
                "lat": lat, "lon": lon, "source": gps_source or "none",
                "accuracy_m": accuracy, "altitude_m": meta["altitude_m"],
                "heading_deg": heading,
                "map_url": ("https://www.openstreetmap.org/?mlat=%.6f&mlon=%.6f#map=19/%.6f/%.6f"
                            % (lat, lon, lat, lon)) if lat is not None else None,
                "text": self._position_text(lat, lon),
            },
            "exif": {k: meta[k] for k in ("has_exif", "make", "model", "taken_at",
                                          "focal_length_mm", "focal_length_35mm",
                                          "gps_time_utc", "altitude_m")},
            "scale": {"mm_per_px": mm_per_px, "source": scale_source,
                      "length_mm": length_mm, "arc_px": round(float(arc_px), 2)},
            "fingerprint": phash,
        }

    @staticmethod
    def _position_text(lat, lon):
        if lat is None or lon is None:
            return "No position on this photo"
        ns = "N" if lat >= 0 else "S"
        ew = "E" if lon >= 0 else "W"
        return "%.6f %s, %.6f %s" % (abs(lat), ns, abs(lon), ew)

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
