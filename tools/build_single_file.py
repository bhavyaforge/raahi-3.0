#!/usr/bin/env python3
"""
Rebuild raahi.py — the one-file copy — from the modular source.

    python3 tools/build_single_file.py

raahi.py carries the backend modules, the web pages and the demo photo
writer as base64 blobs, so the whole app is one file somebody can mail,
drag onto a Desktop and run. That file says at the top "generated from the
modular source; edit that, not this" — this is the script that makes the
statement true.

It rewrites only the blob dictionaries. The server plumbing and the command
line inside raahi.py are edited by hand, in raahi.py itself, because they
are that file's own code and have no counterpart in the source tree. If you
add a backend module or a web file, add its name to MODULES or WEB below.

Run it after any change under raahi_backend/, web/ or tools/make_demo_photos.py.
`--check` verifies the blobs are current without writing, which is what the
self-test uses to catch a raahi.py that has quietly gone stale.
"""

import argparse
import base64
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET = os.path.join(ROOT, "raahi.py")

# Order matters: each module is executed as it is embedded, so anything a
# module imports at the top must already be in place. api imports all of them.
MODULES = ["exif", "geotag", "geo", "rainfall", "traffic", "risk",
           "metrics", "growth", "store", "api"]
WEB = ["index.html", "styles.css", "app.js", "hero.js"]
DEMO = os.path.join(HERE, "make_demo_photos.py")


def encode(path):
    with open(path, "rb") as fh:
        return base64.b64encode(fh.read()).decode("ascii")


def build_blocks():
    modules = ",\n".join(
        '    "%s": "%s"' % (name, encode(os.path.join(ROOT, "raahi_backend", name + ".py")))
        for name in MODULES)
    web = ",\n".join(
        '    "%s": "%s"' % (name, encode(os.path.join(ROOT, "web", name)))
        for name in WEB)
    return ("_MODULES = {\n%s,\n}" % modules,
            "_WEB = {\n%s,\n}" % web,
            '_DEMO = "%s"' % encode(DEMO))


def replace_block(text, pattern, replacement, label):
    new, count = re.subn(pattern, lambda m: replacement, text, count=1, flags=re.S | re.M)
    if count != 1:
        raise SystemExit("Could not find the %s block in raahi.py — has its shape changed?"
                         % label)
    return new


def main():
    parser = argparse.ArgumentParser(description="Rebuild raahi.py from the modular source.")
    parser.add_argument("--check", action="store_true",
                        help="report whether raahi.py is current; write nothing")
    args = parser.parse_args()

    with open(TARGET, encoding="utf-8") as fh:
        current = fh.read()

    modules, web, demo = build_blocks()
    rebuilt = current
    rebuilt = replace_block(rebuilt, r"^_MODULES = \{.*?^\}", modules, "_MODULES")
    rebuilt = replace_block(rebuilt, r"^_WEB = \{.*?^\}", web, "_WEB")
    rebuilt = replace_block(rebuilt, r'^_DEMO = "[^"]*"', demo, "_DEMO")

    if rebuilt == current:
        print("  raahi.py is already current.")
        return 0
    if args.check:
        print("  raahi.py is STALE — run: python3 tools/build_single_file.py")
        return 1

    with open(TARGET, "w", encoding="utf-8") as fh:
        fh.write(rebuilt)
    print("  raahi.py rebuilt — %d backend modules, %d web files, the demo writer."
          % (len(MODULES), len(WEB)))
    print("  %.0f KB" % (os.path.getsize(TARGET) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
