#!/usr/bin/env python3
"""
tracker_server.py — Static file server for the tracker page, plus a small
config-persistence endpoint so the collector/monitor can tell a tracker to
"save defaults" (write its current tweaked parameters to trackers/<id>.json).

Why this exists: a browser cannot write to disk on its own. The config file
lives HERE, on the tracker machine. The browser POSTs the current config to
this local server, which validates it and writes the file. Next launch, the
tracker loads the tweaked defaults.

Endpoints:
  GET  /<anything>            → static files (same as python -m http.server)
  POST /api/save-config       → body {tracker_id, config} → writes trackers/<id>.json

Run:  python3 tracker_server.py [port]   (default 8080)
"""
import json
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRACKERS_DIR = HERE / "trackers"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_BODY = 64 * 1024  # generous cap for a small JSON config


class TrackerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/save-config":
            self._json(404, {"ok": False, "error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > MAX_BODY:
            self._json(413, {"ok": False, "error": "missing or oversized body"})
            return

        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"ok": False, "error": "invalid JSON"})
            return

        tracker_id = data.get("tracker_id")
        config = data.get("config")
        if not isinstance(tracker_id, str) or not SAFE_ID.match(tracker_id):
            self._json(400, {"ok": False, "error": "invalid tracker_id"})
            return
        if not isinstance(config, dict):
            self._json(400, {"ok": False, "error": "config must be an object"})
            return

        # Resolve the target path and confirm it stays inside trackers/
        TRACKERS_DIR.mkdir(exist_ok=True)
        target = (TRACKERS_DIR / f"{tracker_id}.json").resolve()
        if target.parent != TRACKERS_DIR.resolve():
            self._json(400, {"ok": False, "error": "path traversal blocked"})
            return

        # Persist the previous version as <id>.json.bak (single-level backup)
        if target.exists():
            target.with_suffix(".json.bak").write_text(target.read_text())

        config.setdefault("tracker_id", tracker_id)
        target.write_text(json.dumps(config, indent=2) + "\n")
        print(f"▸ saved defaults → trackers/{tracker_id}.json")
        self._json(200, {"ok": True, "path": f"trackers/{tracker_id}.json"})

    def log_message(self, fmt, *args):
        # Quieter logging: only show POSTs and errors, not every GET
        if "POST" in (args[0] if args else "") or (len(args) > 1 and str(args[1]).startswith(("4", "5"))):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    httpd = ThreadingHTTPServer(("0.0.0.0", port), TrackerHandler)
    print(f"▸ Tracker server on http://localhost:{port}  (serving {HERE.name}/)")
    print("    POST /api/save-config persists trackers/<id>.json")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
