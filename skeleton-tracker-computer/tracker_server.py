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
    POST /api/log/start         → starts a logging session, returns {session_id, path}
    POST /api/log/append        → appends NDJSON entries for an active session
    POST /api/log/save          → marks session complete and returns path + count
    POST /api/log/discard       → drops unsaved session and removes its temp file

Run:  python3 tracker_server.py [port]   (default 8080)
"""
import json
import re
import sys
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

HERE = Path(__file__).resolve().parent
TRACKERS_DIR = HERE / "trackers"
LOGS_DIR = HERE / "logs"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_BODY = 64 * 1024  # generous cap for a small JSON config
MAX_LOG_BATCH = 512

LOG_SESSIONS = {}
LOG_LOCK = Lock()


def _sanitize_token(text, fallback="unknown"):
    if not isinstance(text, str) or not text.strip():
        return fallback
    token = re.sub(r"[^A-Za-z0-9_-]+", "-", text.strip().lower()).strip("-")
    return token or fallback


class TrackerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > MAX_BODY:
            return None, (413, "missing or oversized body")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, (400, "invalid JSON")
        return data, None

    def _valid_tracker(self, tracker_id):
        return isinstance(tracker_id, str) and SAFE_ID.match(tracker_id)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/save-config":
            self.handle_save_config()
            return
        if path == "/api/log/start":
            self.handle_log_start()
            return
        if path == "/api/log/append":
            self.handle_log_append()
            return
        if path == "/api/log/save":
            self.handle_log_save()
            return
        if path == "/api/log/discard":
            self.handle_log_discard()
            return
        self._json(404, {"ok": False, "error": "not found"})

    def handle_save_config(self):
        data, err = self._read_json_body()
        if err:
            self._json(err[0], {"ok": False, "error": err[1]})
            return

        tracker_id = data.get("tracker_id")
        config = data.get("config")
        if not self._valid_tracker(tracker_id):
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

    def handle_log_start(self):
        data, err = self._read_json_body()
        if err:
            self._json(err[0], {"ok": False, "error": err[1]})
            return

        tracker_id = data.get("tracker_id")
        if not self._valid_tracker(tracker_id):
            self._json(400, {"ok": False, "error": "invalid tracker_id"})
            return

        camera = _sanitize_token(data.get("camera") or tracker_id, fallback="cam")
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        session_label = _sanitize_token(data.get("session_label"), fallback="session")
        filename = f"{tracker_id}_{camera}_{stamp}_{session_label}.ndjson"

        LOGS_DIR.mkdir(exist_ok=True)
        rel_path = Path("logs") / filename
        abs_path = (HERE / rel_path).resolve()
        if abs_path.parent != LOGS_DIR.resolve():
            self._json(400, {"ok": False, "error": "path traversal blocked"})
            return

        session_id = uuid.uuid4().hex
        with LOG_LOCK:
            LOG_SESSIONS[session_id] = {
                "tracker_id": tracker_id,
                "path": rel_path.as_posix(),
                "abs_path": str(abs_path),
                "entries": 0,
                "closed": False,
            }

        self._json(200, {"ok": True, "session_id": session_id, "path": rel_path.as_posix()})

    def handle_log_append(self):
        data, err = self._read_json_body()
        if err:
            self._json(err[0], {"ok": False, "error": err[1]})
            return

        tracker_id = data.get("tracker_id")
        session_id = data.get("session_id")
        entries = data.get("entries")

        if not self._valid_tracker(tracker_id):
            self._json(400, {"ok": False, "error": "invalid tracker_id"})
            return
        if not isinstance(session_id, str) or not session_id:
            self._json(400, {"ok": False, "error": "missing session_id"})
            return
        if not isinstance(entries, list) or len(entries) == 0:
            self._json(400, {"ok": False, "error": "entries must be a non-empty array"})
            return
        if len(entries) > MAX_LOG_BATCH:
            self._json(413, {"ok": False, "error": "too many entries in one append"})
            return

        with LOG_LOCK:
            session = LOG_SESSIONS.get(session_id)
            if not session:
                self._json(404, {"ok": False, "error": "unknown session_id"})
                return
            if session["tracker_id"] != tracker_id:
                self._json(403, {"ok": False, "error": "session tracker mismatch"})
                return
            if session["closed"]:
                self._json(409, {"ok": False, "error": "session already closed"})
                return
            abs_path = Path(session["abs_path"])

        lines = []
        for item in entries:
            if not isinstance(item, dict):
                continue
            lines.append(json.dumps(item, separators=(",", ":")))
        if not lines:
            self._json(400, {"ok": False, "error": "entries must contain JSON objects"})
            return

        with abs_path.open("a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

        with LOG_LOCK:
            if session_id in LOG_SESSIONS:
                LOG_SESSIONS[session_id]["entries"] += len(lines)
                count = LOG_SESSIONS[session_id]["entries"]
            else:
                count = len(lines)

        self._json(200, {"ok": True, "written": len(lines), "entries": count})

    def handle_log_save(self):
        data, err = self._read_json_body()
        if err:
            self._json(err[0], {"ok": False, "error": err[1]})
            return

        tracker_id = data.get("tracker_id")
        session_id = data.get("session_id")
        if not self._valid_tracker(tracker_id):
            self._json(400, {"ok": False, "error": "invalid tracker_id"})
            return
        if not isinstance(session_id, str) or not session_id:
            self._json(400, {"ok": False, "error": "missing session_id"})
            return

        with LOG_LOCK:
            session = LOG_SESSIONS.get(session_id)
            if not session:
                self._json(404, {"ok": False, "error": "unknown session_id"})
                return
            if session["tracker_id"] != tracker_id:
                self._json(403, {"ok": False, "error": "session tracker mismatch"})
                return
            session["closed"] = True
            rel_path = session["path"]
            entries = session["entries"]

        self._json(200, {"ok": True, "path": rel_path, "entries": entries})

    def handle_log_discard(self):
        data, err = self._read_json_body()
        if err:
            self._json(err[0], {"ok": False, "error": err[1]})
            return

        tracker_id = data.get("tracker_id")
        session_id = data.get("session_id")
        if not self._valid_tracker(tracker_id):
            self._json(400, {"ok": False, "error": "invalid tracker_id"})
            return
        if not isinstance(session_id, str) or not session_id:
            self._json(400, {"ok": False, "error": "missing session_id"})
            return

        with LOG_LOCK:
            session = LOG_SESSIONS.get(session_id)
            if not session:
                self._json(404, {"ok": False, "error": "unknown session_id"})
                return
            if session["tracker_id"] != tracker_id:
                self._json(403, {"ok": False, "error": "session tracker mismatch"})
                return
            session["closed"] = True
            rel_path = session["path"]
            abs_path = Path(session["abs_path"])
            entries = session["entries"]

        try:
            if abs_path.exists():
                abs_path.unlink()
        except OSError:
            pass

        self._json(200, {"ok": True, "path": rel_path, "entries": entries, "discarded": True})

    def log_message(self, fmt, *args):
        # Quieter logging: only show POSTs and errors, not every GET
        first = str(args[0]) if len(args) > 0 else ""
        second = str(args[1]) if len(args) > 1 else ""
        status = first if first.isdigit() else second
        is_post = "POST" in first or getattr(self, "command", "") == "POST"
        is_error = status.startswith(("4", "5"))
        if is_post or is_error:
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
