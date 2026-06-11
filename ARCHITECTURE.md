# Architecture

> Status: this design has been implemented. The tracker/hub/collector split
> described below is live in `skeleton-tracker-computer/` and
> `central-collector-machine/`. See the top-level `README.md` for how to run it.
> This document is kept as the design rationale and message-format reference.

## Recommendation

Keep the current MediaPipe/JavaScript tracker for pose inference.
Do not rewrite the detector yet.
Add a small bridge service on the skeleton tracker computer that sits between the browser tracker and the remote collector.

This keeps the fast part of the system unchanged and puts all networking, control, and machine-to-machine communication in one replaceable layer.

## Machines

### skeleton-tracker-computer

Responsibilities:

- Own one or more cameras.
- Run one tracker worker per camera.
- Produce normalized skeleton frames.
- Expose control and status endpoints.
- Forward outgoing skeleton data to the collector.

Current implementation in this repo:

- Browser tracker UI and pose inference in `skeleton-tracker-computer/`.
- Frames are streamed directly to the hub (`central-collector-machine/hub.py`)
  over WebSocket; no separate per-machine relay is needed.

### central-collector-machine

Responsibilities:

- Send commands to one or more tracker machines.
- Receive skeleton frames from one or more cameras.
- Run a local display bridge for the collector-side viewer.
- Route data to OSC clients, recorders, visualizers, or other applications.
- Monitor machine health and connection state.

## Recommended Runtime Split

### 1. Tracker worker

Keep this in JavaScript for now.
Use the existing browser app as the tracker worker.
For multi-camera support later, run one worker per camera with a stable `camera_id`.

### 2. Tracker bridge

Evolve the current relay into a small bridge service.
This service should run on the skeleton tracker computer and handle:

- WebSocket connections from local tracker workers.
- Command/control messages from the collector.
- Outbound skeleton streaming.
- Status, heartbeat, and camera inventory.
- Optional OSC translation.

This bridge is the correct place to add machine IDs, camera IDs, timestamps, routing rules, and rate limiting.

### 3. Collector runtime

Implement the collector as a separate process in `central-collector-machine/`.
It should:

- Connect to one or more tracker bridges.
- Send control commands.
- Subscribe to skeleton streams.
- Feed a local browser viewer with skeleton-only frames.
- Re-broadcast or transform data as OSC if needed.

### 4. Collector display bridge

Do not render in Python unless there is no alternative.
Keep rendering in the browser.

The collector machine should run a small bridge process that does one of these two jobs:

- Preferred: receive normalized JSON frames over WebSocket from the tracker bridge and forward them to a local browser viewer.
- Optional: receive OSC packets and translate them into the same normalized JSON frames for the local browser viewer.

This means the collector-side visualization stays in JavaScript and canvas, which is much less fragile than desktop Python graphics.
The collector UI (`central-collector-machine/collector.html`) implements this rendering path: skeleton overlay on top of the raw video, per tracker tile.

## Transport Recommendation

### Internal transport on the tracker machine

Use WebSocket with JSON between:

- browser tracker worker
- tracker bridge

Reason:

- the browser already speaks WebSocket cleanly
- this avoids forcing OSC into the browser layer
- commands and state sync are easier over a reliable bidirectional channel

### Machine-to-machine transport

Use WebSocket first.
Add OSC as an adapter at the collector side or bridge side.

Reason:

- command/control needs reliable request/response semantics
- structured status messages are easier in JSON
- OSC is excellent for downstream integration with Max, TouchDesigner, SuperCollider, Unreal, or custom media systems
- OSC alone is weaker for versioned control APIs and acknowledgements

Recommended split:

- WebSocket for control, status, and skeleton frames between machines
- OSC/UDP as an optional outward-facing adapter for applications that expect OSC

If you want the collector to send commands via OSC, that is fine.
The bridge should translate OSC commands into the same internal command objects used by the WebSocket path.
I would still keep the canonical internal protocol JSON-based.

If you later decide that the collector must speak OSC only, keep the bridge and let it translate WebSocket JSON to OSC packets.
That preserves the browser tracker unchanged.

## Message Shape

Suggested frame envelope:

```json
{
  "type": "skeleton_frame",
  "tracker_id": "tracker-01",
  "camera_id": "cam-01",
  "frame_id": 1842,
  "ts_unix_ms": 1760000000123,
  "model": "mediapipe",
  "resolution": { "width": 640, "height": 480 },
  "people": [
    {
      "id": 0,
      "keypoints": [{ "x": 321.4, "y": 118.2, "z": -0.08, "score": 0.99 }]
    }
  ]
}
```

Suggested command envelope:

```json
{
  "type": "command",
  "request_id": "req-0001",
  "target": {
    "tracker_id": "tracker-01",
    "camera_id": "cam-01"
  },
  "command": "set_model",
  "args": {
    "model": "mediapipe"
  }
}
```

Suggested command acknowledgement:

```json
{
  "type": "ack",
  "request_id": "req-0001",
  "ok": true,
  "ts_unix_ms": 1760000000456,
  "details": {
    "state": "logging"
  }
}
```

Suggested status envelope:

```json
{
  "type": "status",
  "tracker_id": "tracker-01",
  "uptime_s": 123.4,
  "cameras": [
    {
      "camera_id": "cam-01",
      "state": "running",
      "fps": 28,
      "model": "mediapipe"
    }
  ]
}
```

## Command Set To Start With

Good first commands:

- `ping`
- `get_status`
- `list_cameras`
- `start_camera`
- `stop_camera`
- `set_model`
- `set_confidence`
- `start_logging`
- `stop_logging`
- `start_streaming`
- `stop_streaming`
- `subscribe_skeleton`
- `unsubscribe_skeleton`

For your current use case, the two most important commands are:

- `start_logging`: create a new log file on the skeleton tracker machine and begin writing frames to disk.
- `start_streaming`: start forwarding live skeleton frames to the collector for display and testing.

I would also define the corresponding stop commands immediately so sessions close cleanly.

Suggested `start_logging` arguments:

```json
{
  "command": "start_logging",
  "args": {
    "session_label": "test-001",
    "format": "ndjson",
    "camera_id": "cam-01"
  }
}
```

Suggested `start_streaming` arguments:

```json
{
  "command": "start_streaming",
  "args": {
    "camera_id": "cam-01",
    "destination": "collector",
    "transport": "ws"
  }
}
```

## Logging Recommendation

Use newline-delimited JSON as the primary on-disk format.
This is usually called NDJSON or JSONL.

I would not use CSV as the primary logging format for the raw capture.
The reasons are:

- the number of tracked people can vary frame by frame
- each person has many landmarks
- MediaPipe data is naturally hierarchical
- appending and recovering partial sessions is much safer with one JSON object per line

This gives you one file per logging session, one record per line, and a format that is still easy to convert later to CSV or a larger JSON document.

### Why NDJSON is the better primary log

- The first line can cleanly store the logging start time and session metadata.
- Every later line can be a timestamped frame record.
- Person 1, person 2, and so on remain explicit inside `people[]`.
- You can later export a tabular CSV without losing the original structure.

### Recommended log file structure

First line:

```json
{
  "type": "log_start",
  "log_version": 1,
  "tracker_id": "tracker-01",
  "camera_id": "cam-01",
  "started_at_iso": "2026-05-24T14:03:11.235Z",
  "started_at_unix_ms": 1760000000123,
  "model": "mediapipe",
  "landmark_count": 33
}
```

Each following line:

```json
{
  "type": "frame",
  "frame_id": 1842,
  "ts_unix_ms": 1760000000456,
  "t_rel_ms": 333,
  "people": [
    {
      "id": 0,
      "keypoints": [
        { "x": 321.4, "y": 118.2, "z": -0.08, "score": 0.99 }
      ]
    }
  ]
}
```

This satisfies your requirement that the first row contain the start logging time and that every later row carry a timestamp.

### CSV recommendation

CSV is still useful, but as a derived export rather than the master recording.

If you want CSV for analysis, the best export shape is not one very wide row per frame.
The better export is a long table with one row per frame, per person, per landmark:

```text
ts_unix_ms,t_rel_ms,frame_id,person_id,landmark_index,landmark_name,x,y,z,score
```

That format is easy to filter, pivot, and aggregate later.

## Streaming Recommendation

For live display on the collector, stream normalized JSON frames.
That is the simplest path because the existing viewer already consumes JSON-like frame objects.

If you also need OSC in the collector pipeline, then do this:

- tracker bridge emits canonical frame objects
- OSC adapter translates canonical frames to OSC if needed
- collector-side reverse bridge translates OSC back into canonical frame objects for the browser viewer

That keeps the viewer format stable even if the transport varies.

## Multi-Camera Scaling

When you move beyond one camera:

- keep one `camera_id` per physical camera
- keep one tracker worker per camera for isolation
- let the bridge multiplex all frames into one outbound stream
- include `tracker_id` and `camera_id` in every message
- let the collector subscribe per machine, per camera, or all cameras

This avoids coupling camera lifecycle to the collector UI.

## Why This Is Better Than A Rewrite

Rewriting the tracker in Python or another runtime would increase risk without solving the main architectural need.
The main need is a control and transport boundary.
The bridge gives you that boundary while keeping the current detector working.

## Next Step

Once you define the command list, the next implementation step should be replacing the current relay with a real bridge service that supports:

- local tracker registration
- remote collector commands
- structured frame forwarding
- acknowledgements
- heartbeat and reconnect logic
