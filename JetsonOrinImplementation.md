# Jetson Orin implementation notes

This file tracks Jetson-specific rollout and integration details for this project.

## Target platform

- Hardware focus: Seeed reComputer / NVIDIA Jetson Orin devices.
- Workload focus: YOLO-based multi-camera tracking.
- Deployment style: one tracker process per camera.
- Typical box profile: one or more cameras (often two), each independently configured.

Reference links:

- Seeed upstream repository: <https://github.com/Seeed-Projects/jetson-examples>
- Ultralytics YOLO reComputer script docs:
  <https://github.com/Seeed-Projects/jetson-examples/blob/main/reComputer/scripts/ultralytics-yolo/README.md>
- Seeed reComputer hardware catalog: <https://www.seeedstudio.com/reComputer-c-1780.html>
- NVIDIA Jetson Orin product page:
  <https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/>
- First-boot validation checklist for Goal A:
  [skeleton-tracker-computer/targets/jetson-orin/JetsonFirstBoot.md](skeleton-tracker-computer/targets/jetson-orin/JetsonFirstBoot.md)

## Current strategy (before custom implementation)

The short-term plan is to validate the Seeed/Ultralytics stack as-is first,
because deployment confidence is the main immediate risk.

Reference implementation:
https://github.com/Seeed-Projects/jetson-examples/blob/main/reComputer/scripts/ultralytics-yolo/README.md

Goals for this initial validation phase:

- Confirm practical installation flow on the target Jetson image.
- Confirm camera bring-up and stability over long runs.
- Measure end-to-end pose throughput under expected camera settings.
- Verify whether existing API/data endpoints are sufficient for skeleton logging.

## Integration paths under evaluation

### Path A: minimal modifications to the Seeed server

Keep their HTTP server flow and add project-specific logging behavior.

Possible options:

- Add local logging start/stop through an additional HTTP method.
- Reuse any existing logging/export endpoint if already available.

Pros:

- Fastest path to first field test.
- Lowest initial engineering effort.

Tradeoffs:

- Different runtime architecture than this repository's native tracker process.
- Additional adapter logic may be needed to match collector protocol exactly.

### Path B: native Jetson tracker process in this repository

Create a Jetson-tuned tracker launcher/process inside this repository, following
the same transport protocol as existing trackers.

Candidate layout:

- skeleton-tracker-computer/targets/jetson-orin/
  - start_trackers_jetson_orin.sh
  - jetson_yolo_tracker.py
  - README.md

Pros:

- Same control surface and protocol conventions as existing tracker scripts.
- Cleaner long-term maintainability for multi-device deployments.

Tradeoffs:

- More implementation effort up front than Path A.

## Logging options

Two logging locations are currently considered:

- Jetson-local logger (toggleable on/off via API).
- Collector-side logger from received keypoints/skeleton frames.

The final choice can be hybrid: local edge logs for resiliency plus collector
logs for centralized analysis.

## Immediate next checkpoints

1. Validate Seeed deployment steps and camera operation on the target Jetson.
2. Confirm which endpoint(s) expose pose keypoints in a stable format.
3. Decide if Path A is sufficient for the two-day test window.
4. If needed, start Path B with a minimal YOLO-only tracker process + launcher.

## Scope note

MoveNet and MediaPipe are intentionally out of scope for the Jetson-specific
runtime path. Jetson path is YOLO-only unless requirements change.
