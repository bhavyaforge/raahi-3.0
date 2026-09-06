"""
Storage. SQLite plus a folder of photos — nothing to install, and the whole
record is one file your team-mate can commit, mail or delete.

    data/raahi.db        every site, observation, calibration and trial
    data/photos/<sha>    the original file, byte for byte, EXIF intact

Photos are keyed by the SHA-256 of their own bytes, so uploading the same
file twice costs nothing and a reading can always be traced back to the
exact pixels it came from.
"""

import hashlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS sites (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    lat           REAL,
    lon           REAL,
    direction_deg REAL,
    phash         TEXT,
    threshold_mm  REAL,
    created_at    TEXT NOT NULL,
    notes         TEXT
);

CREATE TABLE IF NOT EXISTS observations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    captured_at   TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    lat           REAL,
    lon           REAL,
    altitude_m    REAL,
    direction_deg REAL,
    accuracy_m    REAL,
    gps_source    TEXT,
    phash         TEXT,
    length_mm     REAL,
    arc_px        REAL,
    span_px       REAL,
    image_width   INTEGER,
    mm_per_px     REAL,
    scale_source  TEXT,
    photo_sha     TEXT,
    photo_name    TEXT,
    label         TEXT,
    class_code    TEXT,
    match_json    TEXT
);

CREATE INDEX IF NOT EXISTS obs_by_site ON observations(site_id, captured_at);

CREATE TABLE IF NOT EXISTS calibration (
    scope         TEXT PRIMARY KEY,     -- 'global', or a site id
    mm_per_px     REAL NOT NULL,
    image_width   INTEGER,
    ref_mm        REAL,
    ref_px        REAL,
    created_at    TEXT NOT NULL,
    note          TEXT
);

CREATE TABLE IF NOT EXISTS trials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    drew_mm       REAL NOT NULL,
    said_mm       REAL NOT NULL,
    error_mm      REAL NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    split         TEXT NOT NULL,
    model         TEXT,
    created_at    TEXT NOT NULL,
    payload       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL
);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, data_dir):
        self.dir = os.path.abspath(data_dir)
        self.photo_dir = os.path.join(self.dir, "photos")
        os.makedirs(self.photo_dir, exist_ok=True)
        self.path = os.path.join(self.dir, "raahi.db")
        self._lock = threading.Lock()
        self._local = threading.local()
        with self._connect() as db:
            db.executescript(SCHEMA)

    # -- plumbing ----------------------------------------------------------
    def _connect(self):
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=10)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def _rows(self, sql, args=()):
        with self._lock:
            return [dict(r) for r in self._connect().execute(sql, args).fetchall()]

    def _one(self, sql, args=()):
        rows = self._rows(sql, args)
        return rows[0] if rows else None

    def _write(self, sql, args=()):
        with self._lock:
            db = self._connect()
            cur = db.execute(sql, args)
            db.commit()
            return cur.lastrowid

    # -- photos ------------------------------------------------------------
    def save_photo(self, raw: bytes, filename: str = "") -> str:
        """Store the original bytes untouched and return their SHA-256."""
        sha = hashlib.sha256(raw).hexdigest()
        ext = os.path.splitext(filename or "")[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"):
            ext = ".jpg"
        target = os.path.join(self.photo_dir, sha + ext)
        if not os.path.exists(target):
            with open(target, "wb") as fh:
                fh.write(raw)
        return sha

    PHOTO_EXTENSIONS = (".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp")

    def photo_path(self, sha: str):
        """Locate a stored photo. Named by content hash, so this is a lookup,
        not a search — listing the folder would cost more with every photo
        ever taken."""
        if not sha or not sha.isalnum():
            return None
        for ext in self.PHOTO_EXTENSIONS:
            candidate = os.path.join(self.photo_dir, sha + ext)
            if os.path.isfile(candidate):
                return candidate
        return None

    # -- sites -------------------------------------------------------------
    def next_site_id(self):
        """
        The next unused spot id.

        Counting the rows is not good enough: delete SITE-001 and the count
        says the next one is SITE-002, which already exists. Ids are handed
        out from a high-water mark that only ever moves forward, so a
        deleted spot's id is never handed to a different spot later.
        """
        used = {row["id"] for row in self._rows("SELECT id FROM sites")}
        counter = int(self.get_setting("site_seq", 0) or 0)
        for site_id in used:
            if site_id.startswith("SITE-"):
                try:
                    counter = max(counter, int(site_id.split("-", 1)[1]))
                except ValueError:
                    pass
        while True:
            counter += 1
            candidate = "SITE-%03d" % counter
            if candidate not in used:
                self.set_setting("site_seq", counter)
                return candidate

    def create_site(self, name, lat, lon, direction_deg, phash, threshold_mm=150.0, notes=""):
        site_id = self.next_site_id()
        if not name:
            # Name it after the id it actually got, so the label on screen and
            # the id in the record never drift apart.
            number = site_id.split("-", 1)[1].lstrip("0") or site_id
            name = ("Spot %s · %.5f, %.5f" % (number, lat, lon)
                    if lat is not None else "Spot %s (no GPS)" % number)
        self._write(
            "INSERT INTO sites (id,name,lat,lon,direction_deg,phash,threshold_mm,created_at,notes)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (site_id, name, lat, lon, direction_deg, phash, threshold_mm, now_iso(), notes))
        return self.get_site(site_id)

    def get_site(self, site_id):
        return self._one("SELECT * FROM sites WHERE id=?", (site_id,))

    def list_sites(self):
        return self._rows("SELECT * FROM sites ORDER BY created_at")

    def update_site(self, site_id, **fields):
        allowed = {"name", "lat", "lon", "direction_deg", "phash", "threshold_mm", "notes"}
        sets = {k: v for k, v in fields.items() if k in allowed}
        if not sets:
            return self.get_site(site_id)
        clause = ",".join("%s=?" % k for k in sets)
        self._write("UPDATE sites SET %s WHERE id=?" % clause,
                    tuple(sets.values()) + (site_id,))
        return self.get_site(site_id)

    def delete_site(self, site_id):
        self._write("DELETE FROM observations WHERE site_id=?", (site_id,))
        self._write("DELETE FROM sites WHERE id=?", (site_id,))

    def refresh_site_anchor(self, site_id):
        """
        Re-centre a site on the average of its own fixes.

        Every extra visit shrinks the error in the recorded position, which
        is what makes tomorrow's match tighter than today's.
        """
        from . import geo
        obs = self.observations_for(site_id)
        lat, lon = geo.mean_position([(o["lat"], o["lon"]) for o in obs])
        heading = geo.circular_mean_deg([o["direction_deg"] for o in obs])
        if lat is not None:
            self.update_site(site_id, lat=lat, lon=lon,
                             **({"direction_deg": heading} if heading is not None else {}))
        return self.get_site(site_id)

    # -- observations ------------------------------------------------------
    def add_observation(self, row: dict):
        cols = ("site_id", "captured_at", "received_at", "lat", "lon", "altitude_m",
                "direction_deg", "accuracy_m", "gps_source", "phash", "length_mm",
                "arc_px", "span_px", "image_width", "mm_per_px", "scale_source",
                "photo_sha", "photo_name", "label", "class_code", "match_json")
        values = [row.get(c) for c in cols]
        obs_id = self._write(
            "INSERT INTO observations (%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
            values)
        return self.get_observation(obs_id)

    def get_observation(self, obs_id):
        return self._one("SELECT * FROM observations WHERE id=?", (obs_id,))

    def observations_for(self, site_id):
        return self._rows(
            "SELECT * FROM observations WHERE site_id=? ORDER BY captured_at, id", (site_id,))

    def all_observations(self):
        return self._rows("SELECT * FROM observations ORDER BY captured_at, id")

    def delete_observation(self, obs_id):
        self._write("DELETE FROM observations WHERE id=?", (obs_id,))

    # -- calibration -------------------------------------------------------
    def set_calibration(self, scope, mm_per_px, image_width=None,
                        ref_mm=None, ref_px=None, note=""):
        self._write(
            "INSERT INTO calibration (scope,mm_per_px,image_width,ref_mm,ref_px,created_at,note)"
            " VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(scope) DO UPDATE SET mm_per_px=excluded.mm_per_px,"
            " image_width=excluded.image_width, ref_mm=excluded.ref_mm,"
            " ref_px=excluded.ref_px, created_at=excluded.created_at, note=excluded.note",
            (scope, mm_per_px, image_width, ref_mm, ref_px, now_iso(), note))
        return self.get_calibration(scope)

    def get_calibration(self, scope="global"):
        return self._one("SELECT * FROM calibration WHERE scope=?", (scope,))

    def list_calibrations(self):
        return self._rows("SELECT * FROM calibration ORDER BY scope")

    # -- accuracy trials ---------------------------------------------------
    def add_trial(self, drew_mm, said_mm):
        self._write("INSERT INTO trials (drew_mm,said_mm,error_mm,created_at) VALUES (?,?,?,?)",
                    (drew_mm, said_mm, abs(drew_mm - said_mm), now_iso()))
        return self.list_trials()

    def list_trials(self):
        return self._rows("SELECT * FROM trials ORDER BY id")

    def clear_trials(self):
        self._write("DELETE FROM trials")

    # -- detection evaluations --------------------------------------------
    def add_eval(self, split, model, payload: dict):
        self._write("INSERT INTO evals (split,model,created_at,payload) VALUES (?,?,?,?)",
                    (split, model, now_iso(), json.dumps(payload)))
        return self.latest_eval()

    def latest_eval(self):
        row = self._one("SELECT * FROM evals ORDER BY id DESC LIMIT 1")
        if row:
            row["payload"] = json.loads(row["payload"])
        return row

    def list_evals(self):
        out = []
        for row in self._rows("SELECT * FROM evals ORDER BY id DESC"):
            row["payload"] = json.loads(row["payload"])
            out.append(row)
        return out

    # -- settings ----------------------------------------------------------
    def set_setting(self, key, value):
        self._write("INSERT INTO settings (key,value) VALUES (?,?)"
                    " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, json.dumps(value)))

    def get_setting(self, key, default=None):
        row = self._one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default
