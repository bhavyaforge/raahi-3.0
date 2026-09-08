#!/usr/bin/env python3
"""
=============================================================================
  RAAHI  ·  Road Asset Health Intelligence
  Crack growth prototype  |  Team Innovators  |  SIH26198
=============================================================================

  RUN IT

      cd ~/Desktop/raahi
      python3 server.py

  The browser opens by itself at http://localhost:8000
  Stop it with Control + C.

  NOTHING TO INSTALL. Python's standard library only.

  Data lives in ./data — one SQLite file and the photos you took. Delete
  that folder to start clean; copy it to move the whole record elsewhere.
=============================================================================
"""

import json
import os
import socket
import sys
import urllib.parse
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from raahi_backend.api import Api, ApiError, MAX_PHOTO_BYTES
from raahi_backend.store import Store
from raahi_backend import rainfall

PORT = int(os.environ.get("RAAHI_PORT", "8000"))
HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
DATA_DIR = os.environ.get("RAAHI_DATA", os.path.join(HERE, "data"))

MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
    ".heic": "image/heic", ".heif": "image/heif", ".txt": "text/plain; charset=utf-8",
}

STORE = Store(DATA_DIR)
API = Api(STORE)

# A real table of rainfall normals, if somebody has put one next to the data.
# Silent when there is none: the built-in figures are the documented default.
rainfall.try_load(DATA_DIR)


class Handler(BaseHTTPRequestHandler):
    server_version = "RAAHI/2.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------
    def log_message(self, fmt, *args):
        if os.environ.get("RAAHI_QUIET"):
            return
        sys.stderr.write("  %s  %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, status, body: bytes, content_type, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, json.dumps(payload, default=str).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_PHOTO_BYTES + (1024 * 1024):
            raise ApiError("That upload is too large.", 413)
        raw = b""
        while len(raw) < length:
            chunk = self.rfile.read(min(65536, length - len(raw)))
            if not chunk:
                break
            raw += chunk
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError("Body was not valid JSON.")

    # -- static ------------------------------------------------------------
    def _serve_static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not target.startswith(WEB_DIR) or not os.path.isfile(target):
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        with open(target, "rb") as fh:
            data = fh.read()
        ext = os.path.splitext(target)[1].lower()
        self._send(200, data, MIME.get(ext, "application/octet-stream"))

    def _serve_photo(self, sha):
        path = STORE.photo_path(sha)
        if not path or not os.path.isfile(path):
            self._send(404, b"No such photo", "text/plain; charset=utf-8")
            return
        with open(path, "rb") as fh:
            data = fh.read()
        ext = os.path.splitext(path)[1].lower()
        self._send(200, data, MIME.get(ext, "image/jpeg"))

    # -- routing -----------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path.startswith("/api/"):
                status, payload = self._route_get(path)
                self._json(status, payload)
            elif path.startswith("/photo/"):
                self._serve_photo(path[len("/photo/"):])
            else:
                self._serve_static(path)
        except ApiError as err:
            self._json(err.status, {"error": err.message})
        except Exception as err:                       # never take the server down
            self._json(500, {"error": "%s: %s" % (type(err).__name__, err)})

    do_HEAD = do_GET

    def _route_get(self, path):
        parts = [p for p in path.strip("/").split("/") if p]      # ['api', ...]
        rest = parts[1:]
        query = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}

        def first(name):
            values = query.get(name)
            return values[0] if values else None

        if rest == ["state"]:
            return API.get_state()
        if rest == ["sites"]:
            return API.get_sites()
        if len(rest) == 2 and rest[0] == "sites":
            return API.get_site(rest[1])
        if rest == ["observations"]:
            return API.get_observations()
        if rest == ["schedule"]:
            return API.get_schedule()
        if rest == ["trials"]:
            return API.get_trials()
        if rest == ["calibration"]:
            return API.get_calibration()
        if rest == ["metrics", "detection"]:
            return API.get_detection_quality()
        if rest == ["risk"]:
            return API.get_risk()
        if rest == ["rainfall"]:
            return API.get_rainfall(first("lat"), first("lon"), first("days"))
        if rest == ["traffic"]:
            return API.get_traffic_classes()
        if len(rest) == 2 and rest[0] == "report":
            return API.get_report(rest[1])
        raise ApiError("Unknown endpoint: %s" % path, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            body = self._body()
            parts = [p for p in path.strip("/").split("/") if p][1:]
            if parts == ["observations"]:
                status, payload = API.post_observation(body)
            elif parts == ["calibration"]:
                status, payload = API.post_calibration(body)
            elif parts == ["trials"]:
                status, payload = API.post_trial(body)
            elif parts == ["threshold"]:
                status, payload = API.post_threshold(body)
            elif parts == ["metrics", "detection"]:
                status, payload = API.post_detection_eval(body)
            elif parts == ["rainfall"]:
                status, payload = API.post_rainfall(body)
            elif len(parts) == 3 and parts[0] == "sites" and parts[2] == "context":
                status, payload = API.post_site_context(parts[1], body)
            else:
                raise ApiError("Unknown endpoint: %s" % path, 404)
            self._json(status, payload)
        except ApiError as err:
            self._json(err.status, {"error": err.message})
        except Exception as err:
            self._json(500, {"error": "%s: %s" % (type(err).__name__, err)})

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        try:
            parts = [p for p in path.strip("/").split("/") if p][1:]
            if len(parts) == 2 and parts[0] == "sites":
                status, payload = API.delete_site(parts[1])
            elif len(parts) == 2 and parts[0] == "observations":
                status, payload = API.delete_observation(int(parts[1]))
            elif parts == ["records"]:
                status, payload = API.delete_records()
            elif parts == ["trials"]:
                status, payload = API.delete_trials()
            else:
                raise ApiError("Unknown endpoint: %s" % path, 404)
            self._json(status, payload)
        except (ApiError,) as err:
            self._json(err.status, {"error": err.message})
        except Exception as err:
            self._json(500, {"error": "%s: %s" % (type(err).__name__, err)})


def free_port(start):
    for port in range(start, start + 30):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start


def main():
    port = free_port(PORT)
    url = "http://localhost:%d" % port
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True

    print("=" * 66)
    print("  RAAHI is running at   %s" % url)
    print("  Data folder           %s" % DATA_DIR)
    print("  Training tab          %s/?training=1" % url)
    print("  Stop with Control + C")
    print("=" * 66)

    if not os.environ.get("RAAHI_NO_BROWSER"):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped. Your readings are saved in %s" % DATA_DIR)
        server.shutdown()


if __name__ == "__main__":
    main()
