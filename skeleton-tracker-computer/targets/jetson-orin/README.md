# Jetson Orin target study workspace

This folder is for evaluating a Jetson-specific tracker deployment path before
we implement project runtime changes.

## First boot helper

Before running upstream scripts on a fresh device, use:

- [JetsonFirstBoot.md](JetsonFirstBoot.md)

## Local upstream clone

Upstream reference repository is cloned locally at:

- upstream/jetson-examples

The clone is intentionally ignored by git in this repository.

## What was studied (first pass)

From upstream `reComputer/scripts/ultralytics-yolo`:

- `run.sh` auto-selects Docker image by L4T version and launches a container.
- workflow is interactive container + Web UI server + `/results` HTTP endpoint.
- startup path is server-oriented, not process-per-camera tracker oriented.
- this is very useful for immediate Jetson bring-up and performance checks.

## Complexity estimate for your goals

### Goal A: test quickly on hardware

Low complexity.

- follow upstream one-click path and validate camera/model performance.
- use their Web UI and `/results` endpoint to inspect pose keypoints.

### Goal B: add local skeleton logging to upstream server path

Medium complexity.

- likely feasible by adding a logger module in their service process.
- can expose start/stop logging through an extra HTTP API method.

### Goal C: match this repo's tracker protocol and launcher style

Medium to high complexity.

- requires adapter or new process that emits this project's WS JSON messages.
- cleaner long-term solution is a native Jetson tracker script in this repo.

## Recommended immediate plan

1. keep testing upstream on hardware as-is for deployment confidence.
2. inspect `/results` payload shape against our collector schema.
3. decide whether short-term logger should live on Jetson or collector.
4. reconvene before coding integration changes.
