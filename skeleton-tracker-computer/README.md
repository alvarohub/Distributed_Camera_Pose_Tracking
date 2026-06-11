# Skeleton Tracker Computer (the camera side)

Runs one browser **tracker** per webcam. Each tracker grabs a camera, runs pose
detection locally (MoveNet 17-pt 2D, or MediaPipe BlazePose 33-pt 3D), draws the
result on its own canvas, and streams skeleton frames (and optionally raw JPEG
frames) to the collector hub over WebSocket.

## Contents

| File | Purpose |
|---|---|
| `index.html`, `app.js`, `style.css` | The browser tracker UI + pose inference + streaming |
| `tracker_server.py` | Static file server (+ `POST /api/save-config` to persist `trackers/<id>.json`) |
| `setup.sh` | One-time download of TF.js, MoveNet, and MediaPipe assets (offline-capable) |
| `start_trackers.sh` | Serve the page and open tracker tabs |
| `trackers/` | Per-tracker config files; `example.json` is a documented template |
| `lib/`, `model/`, `model-mediapipe/` | Downloaded runtime + model assets |

## Run

```bash
./setup.sh            # once: download libraries + models
./start_trackers.sh   # serve on :8080 and open tracker tabs (cam-left, cam-right)
```

Point trackers at a remote hub:

```bash
COLLECTOR=ws://192.168.1.50:9000 ./start_trackers.sh
```

…or set `"collector"` in each `trackers/<id>.json` (the file stays authoritative).

Open a specific tracker directly: `http://localhost:8080/?id=cam-left`.

## Per-tracker config

Selected by the `?id=` URL parameter → `trackers/<id>.json`. Grouped into
**camera** / **processing** / **communication**; see `trackers/example.json` for
the full field documentation.

`camera` accepts a **label substring** (preferred — stable across replugs), an
exact `deviceId`, or a numeric index. If it doesn't match, the tracker falls
back to the first camera and warns in the console.

Precedence: defaults < config file < URL params < live collector commands. The
collector can apply runtime changes, **save** them back to the file (via
`tracker_server.py`), or **reset** to the saved file.

## Streaming flags

- `streamSkeleton` — send computed keypoints to the collector
- `streamRaw` — send throttled raw JPEG frames (so the collector can show video
  behind the skeleton)

Both are toggleable live from the collector (per-tile **Skel** / **Raw**), and
persisted with **Save defaults**.

## Notes

- Keep the tracker tab **visible** for full frame rate; browsers throttle hidden
  tabs to ~1 fps. The detect loop still runs while hidden, just slowly.
- Logging to disk (NDJSON) is stubbed (`start_logging` / `stop_logging` ack but
  don't yet write files). The recommended format is NDJSON as the raw log, with
  CSV as a derived export.

Machine-to-machine design notes: [../ARCHITECTURE.md](../ARCHITECTURE.md).
