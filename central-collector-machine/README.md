# Central Collector Machine (the monitor side)

Runs the **hub** and serves the **collector** UI — the single page that monitors
every connected tracker.

## Contents

| File | Purpose |
|---|---|
| `hub.py` | WebSocket router on `:9000` **and** static server for the UI on `:8090` |
| `collector.html`, `collector.js`, `collector.css` | The monitor UI: a grid with one tile per tracker |
| `start_collector.sh` | Launch the hub and open the UI |

## Run

```bash
./start_collector.sh
```

Then point trackers at `ws://<this-machine>:9000`.

- Hub WebSocket router: `ws://localhost:9000`
- Collector UI: `http://localhost:8090/collector.html`

## What the hub does

Clients declare a role in their first `hello` message:

- **tracker** → everything it emits (skeleton/video frames, status, ack, hello/bye)
  is broadcast to all collectors.
- **collector** → `command` messages are routed to a single tracker by
  `target.tracker_id` (or broadcast to all trackers when `target` is null).

The hub is transport-only: it forwards new message types (e.g. `config`)
without needing changes.

## Collector UI

Each tile shows the raw video with the skeleton overlay, plus controls:

- **Model**, **Conf** — change detection settings live
- **Skel**, **Raw** — toggle what the tracker streams (`start/stop_skeleton`,
  `start/stop_video`)
- **Log** — start/stop logging (stubbed on the tracker for now)
- **💾 Save defaults** / **↺ Reset** — persist or reload the tracker's config file

Top bar:

- **Raw video** / **Skeleton** — global *display* toggles (local only; they do
  not stop the trackers from streaming — the per-tile **Skel**/**Raw** do that)
- **Log all** / **Stop all** — broadcast logging commands
- **⏻ Stop servers** — stop the hub + tracker servers without a terminal
  (honored only over localhost; when launched via `start_local_demo.sh` it stops
  the whole demo)

Design notes and message envelopes: [../ARCHITECTURE.md](../ARCHITECTURE.md).
