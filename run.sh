#!/bin/bash
# Start RAAHI. Nothing to install — Python's standard library only.
cd "$(dirname "$0")" || exit 1
echo "Starting RAAHI…"
echo "Open your browser at http://localhost:8000"
echo "Press Control + C to stop."
echo
exec python3 server.py
