#!/usr/bin/env python3
"""
hub.py — Central collector hub.

A WebSocket router that sits between skeleton trackers and the collector UI.

Roles (declared by each client in its first "hello" message):
  - "tracker"   : one process owning one camera. Sends skeleton/video frames + status.
  - "collector" : the monitoring UI. Receives all tracker traffic, sends commands.

Routing rules:
  - tracker  -> all collectors   (skeleton_frame, video_frame, status, ack, hello/bye)
  - collector -> one tracker      (command, addressed by target.tracker_id)

It also serves the collector UI static files over HTTP so the whole collector
side is a single launch.

This is the WebSocket-first canonical transport. OSC, if ever needed, is a
downstream adapter built on top of this — not a replacement.
"""
import asyncio
import json
import os
import signal
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets

WS_PORT = 9000
HTTP_PORT = 8090
HERE = Path(__file__).resolve().parent

# ── Connection registry ───────────────────────────────────────────────────────
TRACKERS = {}        # tracker_id -> websocket
COLLECTORS = set()   # set of collector websockets
ROLE = {}            # websocket -> ("tracker", tracker_id) | ("collector", None)


async def _send_safe(ws, message):
    try:
        await ws.send(message)
        return True
    except websockets.ConnectionClosed:
        return False


async def broadcast_to_collectors(message):
    dead = set()
    for c in COLLECTORS:
        if not await _send_safe(c, message):
            dead.add(c)
    COLLECTORS.difference_update(dead)


def tracker_roster():
    """Snapshot of currently connected trackers for a freshly joined collector."""
    return {
        "type": "roster",
        "trackers": list(TRACKERS.keys()),
    }


async def handle_hello(ws, msg, raw):
    role = msg.get("role")
    if role == "tracker":
        tid = msg.get("tracker_id") or f"tracker-{id(ws) % 10000}"
        TRACKERS[tid] = ws
        ROLE[ws] = ("tracker", tid)
        print(f"▸ tracker connected: {tid}")
        # Tell every collector a tracker joined (forward the hello verbatim)
        await broadcast_to_collectors(raw)
    elif role == "collector":
        COLLECTORS.add(ws)
        ROLE[ws] = ("collector", None)
        print("▸ collector connected")
        # Send the new collector the current roster so it can build tiles
        await _send_safe(ws, json.dumps(tracker_roster()))
    else:
        print(f"⚠ hello with unknown role: {role!r}")


async def route_from_tracker(raw):
    # Everything a tracker emits goes to all collectors.
    await broadcast_to_collectors(raw)


async def route_from_collector(msg, raw):
    # Collector commands are addressed to a single tracker.
    target = (msg.get("target") or {}).get("tracker_id")
    if target and target in TRACKERS:
        await _send_safe(TRACKERS[target], raw)
    elif target is None:
        # No target = broadcast command to all trackers.
        for ws in list(TRACKERS.values()):
            await _send_safe(ws, raw)
    else:
        print(f"⚠ command for unknown tracker: {target!r}")


def _is_loopback(ws):
    """True if the peer connected over localhost (127.0.0.1 / ::1)."""
    addr = getattr(ws, "remote_address", None)
    host = addr[0] if addr else None
    return host in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


async def shutdown_servers():
    """Stop the demo from the collector UI — no terminal needed.

    Only honored over loopback (see caller). When the demo launcher set
    HUB_KILL_PROCESS_GROUP=1, the hub, the tracker file server and the launch
    script all share one process group, so a single SIGTERM to that group stops
    everything. Standalone (env var unset) the hub only stops itself, so we
    never accidentally signal an interactive shell's process group.
    """
    print("\n▸ Shutdown requested from collector UI — stopping servers.")
    await broadcast_to_collectors(json.dumps({"type": "server_shutdown"}))
    await asyncio.sleep(0.3)  # let the notice reach the UI before we die
    if os.environ.get("HUB_KILL_PROCESS_GROUP") == "1":
        try:
            os.killpg(os.getpgid(0), signal.SIGTERM)
            return
        except OSError:
            pass
    os._exit(0)


async def on_connect(ws):
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")
            if mtype == "hello":
                await handle_hello(ws, msg, raw)
                continue

            if mtype == "shutdown":
                # Stop-servers button in the collector UI. Loopback only.
                if _is_loopback(ws):
                    await shutdown_servers()
                else:
                    print("⚠ ignored remote shutdown request")
                continue

            role = ROLE.get(ws, (None, None))[0]
            if role == "tracker":
                await route_from_tracker(raw)
            elif role == "collector":
                await route_from_collector(msg, raw)
            # messages before a hello are ignored
    except websockets.ConnectionClosed:
        pass
    finally:
        await cleanup(ws)


async def cleanup(ws):
    role, tid = ROLE.pop(ws, (None, None))
    if role == "tracker":
        if TRACKERS.get(tid) is ws:
            del TRACKERS[tid]
        print(f"▸ tracker disconnected: {tid}")
        await broadcast_to_collectors(
            json.dumps({"type": "bye", "tracker_id": tid})
        )
    elif role == "collector":
        COLLECTORS.discard(ws)
        print("▸ collector disconnected")


def start_http_server():
    handler = partial(SimpleHTTPRequestHandler, directory=str(HERE))
    httpd = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), handler)
    print(f"▸ Collector UI on http://localhost:{HTTP_PORT}/collector.html")
    httpd.serve_forever()


async def main():
    threading.Thread(target=start_http_server, daemon=True).start()
    print(f"▸ Hub WebSocket on ws://localhost:{WS_PORT}")
    async with websockets.serve(on_connect, "0.0.0.0", WS_PORT, max_size=8 * 1024 * 1024):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
