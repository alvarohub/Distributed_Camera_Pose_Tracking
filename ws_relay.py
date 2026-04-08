#!/usr/bin/env python3
"""
ws_relay.py — Tiny WebSocket relay server.
The tracker (app.js) sends pose data; all connected viewers receive it.
"""
import asyncio
import websockets

VIEWERS = set()
TRACKER = None

async def handler(ws):
    global TRACKER
    try:
        async for message in ws:
            # First client that sends data is the tracker; the rest are viewers
            if TRACKER is None or TRACKER == ws:
                TRACKER = ws
                # Relay to all viewers
                dead = set()
                for v in VIEWERS:
                    try:
                        await v.send(message)
                    except websockets.ConnectionClosed:
                        dead.add(v)
                VIEWERS -= dead
            else:
                VIEWERS.add(ws)
    except websockets.ConnectionClosed:
        pass
    finally:
        VIEWERS.discard(ws)
        if ws == TRACKER:
            TRACKER = None

async def on_connect(ws):
    global TRACKER
    # If tracker is already connected, this is a viewer
    if TRACKER is not None and ws != TRACKER:
        VIEWERS.add(ws)
    await handler(ws)

async def main():
    print("▸ WebSocket relay on ws://localhost:8765")
    async with websockets.serve(on_connect, "0.0.0.0", 8765):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
