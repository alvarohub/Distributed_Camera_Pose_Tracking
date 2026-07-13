#!/usr/bin/env python3
"""YOLO-only headless tracker.

Reads trackers/<id>.json, opens the configured camera with OpenCV, runs a YOLO
pose model with Ultralytics, and emits the same WebSocket JSON messages as the
browser tracker. This is intended for installations where a visible browser tab
is inconvenient.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import cv2
    import websockets
    from websockets.exceptions import ConnectionClosed
    from ultralytics import YOLO
except ImportError as exc:  # pragma: no cover - friendly startup failure
    raise SystemExit(
        "Missing headless YOLO dependencies. From the repo root run:\n"
        "  .venv/bin/python -m pip install -r requirements-headless-yolo.txt"
    ) from exc


HERE = Path(__file__).resolve().parent
TRACKERS_DIR = HERE / "trackers"
VIDEO_STREAM_FPS = 12
VIDEO_JPEG_QUALITY = 50
STATUS_INTERVAL = 1.0

KEYPOINT_NAMES = [
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
]

CONNECTIONS = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 4],
    [5, 6],
    [5, 7],
    [7, 9],
    [6, 8],
    [8, 10],
    [5, 11],
    [6, 12],
    [11, 12],
    [11, 13],
    [13, 15],
    [12, 14],
    [14, 16],
]

YOLO_WEIGHTS = {
    "yolov8": ("yolov8n-pose.onnx", "yolov8n-pose.pt"),
    "yolo11": ("yolo11n-pose.onnx", "yolo11n-pose.pt"),
}


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def camera_source(spec: Any) -> Any:
    if spec is None or spec == "":
        return 0
    if isinstance(spec, int):
        return spec
    text = str(spec)
    return int(text) if text.isdigit() else text


def model_name_from_config(config: dict[str, Any]) -> str:
    model_name = str(config.get("model") or "yolo11")
    if model_name in YOLO_WEIGHTS:
        return model_name
    print(f"⚠ headless tracker supports YOLO only; using yolo11 instead of {model_name!r}")
    return "yolo11"


def model_path(model_name: str) -> str:
    onnx_name, pt_name = YOLO_WEIGHTS[model_name]
    onnx_path = HERE / "model-yolo" / onnx_name
    if onnx_path.exists():
        return str(onnx_path)
    return pt_name


@dataclass
class TrackerState:
    tracker_id: str
    config_path: Path
    config: dict[str, Any]
    model_name: str
    model: Any
    width: int
    height: int
    confidence: float
    mirror: bool
    stream_skeleton: bool
    stream_raw: bool
    collector: str
    logging: bool = False
    fps: int = 0
    people_count: int = 0

    @classmethod
    def create(cls, tracker_id: str) -> "TrackerState":
        config_path = TRACKERS_DIR / f"{tracker_id}.json"
        if not config_path.exists():
            raise FileNotFoundError(f"missing config: {config_path}")
        config = load_json(config_path)
        resolution = config.get("resolution") or {}
        model_name = model_name_from_config(config)
        print(f"▸ [{tracker_id}] loading {model_name} from {model_path(model_name)}")
        return cls(
            tracker_id=tracker_id,
            config_path=config_path,
            config=config,
            model_name=model_name,
            model=YOLO(model_path(model_name)),
            width=int(resolution.get("width") or 640),
            height=int(resolution.get("height") or 480),
            confidence=float(config.get("confidence") or 0.3),
            mirror=bool(config.get("mirror", True)),
            stream_skeleton=bool(config.get("streamSkeleton", True)),
            stream_raw=bool(config.get("streamRaw", True)),
            collector=str(config.get("collector") or "ws://localhost:9000"),
        )

    def current_config(self) -> dict[str, Any]:
        return {
            "tracker_id": self.tracker_id,
            "camera": self.config.get("camera"),
            "resolution": {"width": self.width, "height": self.height},
            "model": self.model_name,
            "confidence": self.confidence,
            "mirror": self.mirror,
            "streamSkeleton": self.stream_skeleton,
            "streamRaw": self.stream_raw,
            "collector": self.collector,
            "calibration": self.config.get("calibration"),
        }

    def set_model(self, model_name: str) -> None:
        if model_name not in YOLO_WEIGHTS:
            raise ValueError("headless tracker supports only yolov8 or yolo11")
        if model_name == self.model_name:
            return
        print(f"▸ [{self.tracker_id}] switching model to {model_name}")
        self.model_name = model_name
        self.model = YOLO(model_path(model_name))

    def save_defaults(self) -> str:
        if self.config_path.exists():
            backup = self.config_path.with_suffix(".json.bak")
            shutil.copyfile(self.config_path, backup)
        self.config.update(self.current_config())
        self.config_path.write_text(json.dumps(self.config, indent=2) + "\n", encoding="utf-8")
        return f"trackers/{self.tracker_id}.json"

    def reset_to_defaults(self) -> None:
        self.config = load_json(self.config_path)
        self.confidence = float(self.config.get("confidence") or 0.3)
        self.mirror = bool(self.config.get("mirror", True))
        self.stream_skeleton = bool(self.config.get("streamSkeleton", True))
        self.stream_raw = bool(self.config.get("streamRaw", True))
        self.collector = str(self.config.get("collector") or self.collector)
        self.set_model(model_name_from_config(self.config))


def open_capture(state: TrackerState):
    cap = cv2.VideoCapture(camera_source(state.config.get("camera")))
    if not cap.isOpened():
        raise RuntimeError(f"could not open camera {state.config.get('camera')!r}")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, state.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, state.height)
    return cap


def poses_from_result(result: Any) -> list[dict[str, Any]]:
    if result.keypoints is None or result.keypoints.xy is None:
        return []
    xy = result.keypoints.xy.cpu().numpy()
    conf = result.keypoints.conf.cpu().numpy() if result.keypoints.conf is not None else None
    poses = []
    for person_idx, points in enumerate(xy):
        keypoints = []
        for keypoint_idx, point in enumerate(points):
            score = float(conf[person_idx][keypoint_idx]) if conf is not None else 1.0
            keypoints.append(
                {
                    "x": round(float(point[0]), 1),
                    "y": round(float(point[1]), 1),
                    "z": 0,
                    "score": round(score, 3),
                }
            )
        poses.append({"id": person_idx, "keypoints": keypoints})
    return poses


def jpeg_data_uri(frame) -> str:
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), VIDEO_JPEG_QUALITY])
    if not ok:
        return ""
    b64 = base64.b64encode(buf).decode("ascii")
    return "data:image/jpeg;base64," + b64


async def send_json(ws, payload: dict[str, Any]) -> None:
    await ws.send(json.dumps(payload, separators=(",", ":")))


async def ack(ws, tracker_id: str, request_id: Any, ok: bool, details: str = "") -> None:
    await send_json(ws, {"type": "ack", "tracker_id": tracker_id, "request_id": request_id, "ok": ok, "details": details})


async def send_hello(ws, state: TrackerState) -> None:
    await send_json(
        ws,
        {
            "type": "hello",
            "role": "tracker",
            "tracker_id": state.tracker_id,
            "model": state.model_name,
            "resolution": {"width": state.width, "height": state.height},
        },
    )


async def send_config(ws, state: TrackerState, request_id: Any = None) -> None:
    await send_json(ws, {"type": "config", "tracker_id": state.tracker_id, "request_id": request_id, "config": state.current_config()})


async def send_status(ws, state: TrackerState) -> None:
    await send_json(
        ws,
        {
            "type": "status",
            "tracker_id": state.tracker_id,
            "model": state.model_name,
            "fps": state.fps,
            "people_count": state.people_count,
            "streaming": state.stream_raw,
            "streaming_skeleton": state.stream_skeleton,
            "logging": state.logging,
        },
    )


async def handle_command(ws, state: TrackerState, msg: dict[str, Any]) -> None:
    command = msg.get("command")
    args = msg.get("args") or {}
    request_id = msg.get("request_id")
    try:
        if command == "ping":
            await ack(ws, state.tracker_id, request_id, True, "pong")
        elif command == "get_status":
            await send_status(ws, state)
            await ack(ws, state.tracker_id, request_id, True)
        elif command == "get_config":
            await send_config(ws, state, request_id)
            await ack(ws, state.tracker_id, request_id, True)
        elif command == "set_confidence":
            state.confidence = float(args.get("confidence", state.confidence))
            await ack(ws, state.tracker_id, request_id, True)
        elif command == "set_model":
            state.set_model(str(args.get("model") or state.model_name))
            await send_config(ws, state, request_id)
            await ack(ws, state.tracker_id, request_id, True, f"model={state.model_name}")
        elif command == "set_config":
            partial = args.get("config") or args
            if "confidence" in partial:
                state.confidence = float(partial["confidence"])
            if "mirror" in partial:
                state.mirror = bool(partial["mirror"])
            if "streamSkeleton" in partial:
                state.stream_skeleton = bool(partial["streamSkeleton"])
            if "streamRaw" in partial:
                state.stream_raw = bool(partial["streamRaw"])
            if "model" in partial:
                state.set_model(str(partial["model"]))
            await send_config(ws, state, request_id)
            await ack(ws, state.tracker_id, request_id, True, "applied (runtime)")
        elif command == "start_skeleton":
            state.stream_skeleton = True
            await ack(ws, state.tracker_id, request_id, True)
        elif command == "stop_skeleton":
            state.stream_skeleton = False
            await ack(ws, state.tracker_id, request_id, True)
        elif command == "start_video":
            state.stream_raw = True
            await ack(ws, state.tracker_id, request_id, True)
        elif command == "stop_video":
            state.stream_raw = False
            await ack(ws, state.tracker_id, request_id, True)
        elif command == "save_defaults":
            path = state.save_defaults()
            await send_config(ws, state, request_id)
            await ack(ws, state.tracker_id, request_id, True, f"saved → {path}")
        elif command == "reset_to_defaults":
            state.reset_to_defaults()
            await send_config(ws, state, request_id)
            await ack(ws, state.tracker_id, request_id, True, "reset to saved defaults")
        elif command == "start_logging":
            state.logging = True
            await send_status(ws, state)
            await ack(ws, state.tracker_id, request_id, True, "logging started (stub)")
        elif command == "stop_logging":
            state.logging = False
            await send_status(ws, state)
            await ack(ws, state.tracker_id, request_id, True, "logging stopped")
        else:
            await ack(ws, state.tracker_id, request_id, False, f"unknown command: {command}")
    except Exception as exc:  # keep command errors visible in the collector
        await ack(ws, state.tracker_id, request_id, False, str(exc))


async def command_reader(ws, state: TrackerState) -> None:
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "command":
            await handle_command(ws, state, msg)


async def stream_loop(state: TrackerState) -> None:
    cap = open_capture(state)
    frame_id = 0
    start_time = time.time()
    last_video = 0.0
    last_status = 0.0
    fps_frames = 0
    fps_start = time.time()

    try:
        while True:
            try:
                print(f"▸ [{state.tracker_id}] connecting to {state.collector}")
                async with websockets.connect(state.collector, max_size=None) as ws:
                    await send_hello(ws, state)
                    await send_config(ws, state)
                    reader = asyncio.create_task(command_reader(ws, state))
                    print(f"▸ [{state.tracker_id}] connected")
                    try:
                        while True:
                            ok, frame = cap.read()
                            if not ok:
                                await asyncio.sleep(0.05)
                                continue
                            frame = cv2.resize(frame, (state.width, state.height))
                            if state.mirror:
                                frame = cv2.flip(frame, 1)

                            result = state.model.predict(frame, imgsz=640, conf=state.confidence, verbose=False)[0]
                            poses = poses_from_result(result)
                            state.people_count = len(poses)
                            now = time.time()

                            if state.stream_skeleton:
                                await send_json(
                                    ws,
                                    {
                                        "type": "skeleton_frame",
                                        "tracker_id": state.tracker_id,
                                        "frame_id": frame_id,
                                        "ts_unix_ms": int(now * 1000),
                                        "t": round(now - start_time, 3),
                                        "model": state.model_name,
                                        "connections": CONNECTIONS,
                                        "resolution": {"width": state.width, "height": state.height},
                                        "people": poses,
                                    },
                                )

                            if state.stream_raw and now - last_video >= 1.0 / VIDEO_STREAM_FPS:
                                last_video = now
                                await send_json(
                                    ws,
                                    {
                                        "type": "video_frame",
                                        "tracker_id": state.tracker_id,
                                        "frame_id": frame_id,
                                        "ts_unix_ms": int(now * 1000),
                                        "jpeg": jpeg_data_uri(frame),
                                    },
                                )

                            fps_frames += 1
                            if now - fps_start >= 1.0:
                                state.fps = fps_frames
                                fps_frames = 0
                                fps_start = now

                            if now - last_status >= STATUS_INTERVAL:
                                last_status = now
                                await send_status(ws, state)

                            frame_id += 1
                            if reader.done():
                                await reader
                    finally:
                        reader.cancel()
            except (ConnectionClosed, OSError) as exc:
                print(f"⚠ [{state.tracker_id}] disconnected: {exc}; retrying")
                await asyncio.sleep(2)
    finally:
        cap.release()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one YOLO headless skeleton tracker")
    parser.add_argument("--id", required=True, help="tracker id, matching trackers/<id>.json")
    args = parser.parse_args()
    state = TrackerState.create(args.id)
    asyncio.run(stream_loop(state))


if __name__ == "__main__":
    main()