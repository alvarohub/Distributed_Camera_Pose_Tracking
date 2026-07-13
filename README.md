# Skeleton Tracker — distributed video → skeleton system

A small distributed system for multi-camera skeleton tracking:

- **Trackers** run in the browser, one per webcam. Each grabs a camera, runs
  pose detection (MoveNet or MediaPipe) locally, and streams the results.
- A **hub** routes messages between trackers and the monitor.
- A **collector** ("monitor") is a single web page showing one tile per tracker
  with the raw video and the skeleton overlay, plus per-tracker controls.

Everything talks over WebSocket + JSON. The transport is identical whether the
pieces run on one laptop or across several machines on a LAN — only the
`collector` URL in each tracker's config changes.

```
 ┌──────────────────────────┐         ┌──────────────────────┐
 │ skeleton-tracker-computer │        │ central-collector-    │
 │  (one per camera/machine) │        │  machine              │
 │                           │  WS    │                       │
 │  browser tracker page  ───┼───────▶│  hub.py  :9000  ──────┼─▶ collector.html
 │  ?id=cam-left             │ frames │  (router + UI server) │   (grid of tiles)
 │  tracker_server.py :8080  │◀───────┼───  commands          │   :8090
 └──────────────────────────┘        └──────────────────────┘
```

## Quick start (one machine, the demo)

```bash
./start_local_demo.sh            # opens collector + cam-left + cam-right in tiled windows
./start_local_demo.sh cam-left   # one webcam? open a single tracker
```

`start_local_demo.sh` now behaves like a small supervisor: re-running it
automatically cleans up stale local-demo processes from a previous run before
starting fresh, so close/reopen cycles stay clean.

It also opens tracker pages in separate browser windows (not tabs) and arranges
them on screen so camera trackers keep running even when you focus another
window.

This creates a Python virtualenv on first run, downloads the tracker assets if
missing, starts the hub and the tracker file server, and opens the browser
tabs. Stop it with `Ctrl-C`, or click **⏻ Stop servers** in the collector UI.

> Tip: each browser tab must stay **visible** to run at full frame rate —
> browsers throttle hidden/background tabs to ~1 fps. On one machine, keep the
> tracker window and the collector window side by side. Across machines this is
> a non-issue (one visible tab each).

## Running across machines

On the **collector machine**:

```bash
cd central-collector-machine && ./start_collector.sh
```

On each **tracker machine**:

```bash
cd skeleton-tracker-computer && ./setup.sh        # once, downloads models/libs
COLLECTOR=ws://<collector-ip>:9000 ./start_trackers.sh
```

Or set `"collector": "ws://<collector-ip>:9000"` in each `trackers/<id>.json`
so the file stays authoritative without an env override.

## Repository layout

```
.
├── start_local_demo.sh          # one-machine demo (hub + tracker server + tabs)
├── venv.sh                      # shared helper: creates .venv, exports $PY
├── requirements.txt             # Python deps (websockets)
├── ARCHITECTURE.md              # original design notes / rationale
│
├── central-collector-machine/   # the MONITOR side
│   ├── hub.py                   # WS router :9000 + serves collector UI :8090
│   ├── collector.html/.js/.css  # the monitor UI (grid of tracker tiles)
│   └── start_collector.sh       # launch the hub + open the UI
│
└── skeleton-tracker-computer/   # the CAMERA side (one per machine)
    ├── index.html / app.js      # the browser tracker (pose detection + stream)
    ├── style.css
    ├── tracker_server.py        # serves the page + persists trackers/<id>.json
    ├── start_trackers.sh        # serve + open tracker tabs
    ├── setup.sh                 # one-time download of TF.js/MoveNet/MediaPipe
    ├── trackers/                # per-tracker config files (see example.json)
    ├── lib/ model/ model-mediapipe/   # downloaded assets (gitignored if large)
    └── README.md
```

### What each script does

| Script                | Where     | Purpose                                                                                           |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| `start_local_demo.sh` | root      | All-in-one demo on one machine: hub + tracker server + browser tabs. Accepts tracker ids as args. |
| `venv.sh`             | root      | Sourced by the others. Ensures `.venv` exists with deps, exports `$PY`.                           |
| `start_collector.sh`  | collector | Runs `hub.py` and opens the collector UI. Use on the monitor machine.                             |
| `setup.sh`            | tracker   | One-time download of TF.js, MoveNet, and MediaPipe assets for offline use.                        |
| `start_trackers.sh`   | tracker   | Runs `tracker_server.py` and opens tracker tabs. `COLLECTOR=ws://… ` overrides the hub URL.       |

## Per-tracker configuration

Each tracker reads `skeleton-tracker-computer/trackers/<id>.json`, selected by
the `?id=` in the URL. See `trackers/example.json` for a documented template.
Fields are grouped into **camera**, **processing**, and **communication**:

- `camera` — label substring (preferred, stable), exact deviceId, or numeric index
- `resolution` — `{ width, height }`
- `model` — `movenet` or `mediapipe`
- `confidence`, `mirror`, `calibration` (reserved)
- `collector` — hub WebSocket URL
- `streamSkeleton`, `streamRaw` — what gets sent to the collector

Config precedence: built-in defaults < config file < URL params < live commands
from the collector. The collector can push runtime changes, **💾 Save defaults**
(writes the file via `tracker_server.py`), or **↺ Reset** (reloads the file).

The canonical message shapes (skeleton frame, command, ack, status) are
documented in [ARCHITECTURE.md](ARCHITECTURE.md).
