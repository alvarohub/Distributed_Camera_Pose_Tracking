# Pose Estimation Models

This project can run several pose estimators from the browser tracker. They do
not have the same speed/accuracy tradeoff, and the runtime path matters as much
as the model name.

## Current browser models

| Config value | Runtime path                               | Output                                   | Expected role                                   |
| ------------ | ------------------------------------------ | ---------------------------------------- | ----------------------------------------------- |
| `movenet`    | TensorFlow.js MoveNet MultiPose Lightning  | 17 COCO-style 2D keypoints, multi-person | Fast default for browser trackers               |
| `mediapipe`  | MediaPipe Pose Landmarker, GPU delegate    | 33 landmarks, 3D-ish world landmarks     | Richer body model, useful when 33 points matter |
| `yolov8`     | YOLOv8n Pose ONNX through ONNX Runtime Web | 17 COCO-style 2D keypoints, multi-person | Detector-style YOLO comparison / experiments    |
| `yolo11`     | YOLO11n Pose ONNX through ONNX Runtime Web | 17 COCO-style 2D keypoints, multi-person | Newer YOLO comparison / experiments             |

## Why YOLO can be much slower here

Seeing something like MoveNet at about 50 fps and YOLO at about 5 fps is
plausible in this repository. The comparison is not just model family versus
model family; it is also runtime versus runtime.

MoveNet is loaded through the TensorFlow.js pose-detection package as
`MULTIPOSE_LIGHTNING`. It is designed for real-time browser pose estimation and
can use the browser's optimized TensorFlow.js backend.

The YOLO models are currently loaded as ONNX models through ONNX Runtime Web.
The tracker forces the ONNX execution provider to `wasm` and sets WASM threads
to `1`, so YOLO is effectively running on a single CPU-side WebAssembly path.
That is very different from running YOLO natively with CUDA, Metal, CoreML,
TensorRT, or another accelerated backend.

YOLO also runs at a fixed 640 x 640 input size in the browser tracker. Each
frame is copied into an offscreen canvas, converted into a float tensor, run
through ONNX, decoded, filtered, and non-max-suppressed in JavaScript. That
pre/postprocessing overhead is part of the measured frame rate.

So in this browser setup, YOLO being an order of magnitude slower than MoveNet
is not surprising. YOLO can be fast in the right native/GPU deployment, but this
browser ONNX/WASM path is not the fastest YOLO path.

## Practical recommendation

Use `movenet` as the default for live browser trackers when frame rate matters.
It is the best fit for the current web tracker.

Use `mediapipe` when the 33-point body model or approximate 3D landmark output
is more important than maximum frame rate.

Use `yolov8` or `yolo11` when you specifically want to compare YOLO pose, test
detector-style behavior, or run the same model family that may later be used in
a native/headless pipeline.

For installation-style YOLO tracking, prefer the Python headless YOLO tracker.
That path can use the native Ultralytics/OpenCV stack and has a better chance of
using hardware acceleration than the browser ONNX/WASM path.

## Possible YOLO speed knobs

These are future tuning options, not all currently exposed in the UI:

- Lower the YOLO input size below 640 x 640, with some accuracy loss.
- Reduce `YOLO_MAX_POSES` if only one or two people are expected.
- Run YOLO every N frames and track/interpolate between YOLO frames.
- Try ONNX Runtime WebGPU/WebGL if the target browser and model support it.
- Enable threaded WASM when the browser page is served with the required cross-origin isolation headers.
- Move YOLO inference to the headless Python runner for native acceleration.

## Naming note

If someone says "MobileNet" in this project, they may mean either the older
PoseNet/MobileNet-style family or simply the fast browser model. The actual
fast default in this codebase is `movenet`, not MobileNet.
