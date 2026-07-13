# Jetson first boot checklist (Goal A)

Use this when powering on a Jetson Orin/reComputer for the first time to test
the upstream Seeed Ultralytics YOLO stack with minimal surprises.

## Why this exists

Upstream quickstarts are optimized for a "happy path" demo and usually assume
JetPack + Docker runtime are already healthy. This file adds practical
preflight checks before running the upstream script.

## Phase 1: baseline system checks

Run on the Jetson terminal:

```bash
echo "== OS and kernel =="
uname -a
cat /etc/os-release | sed -n '1,8p'

echo
echo "== L4T release =="
ls -l /etc/nv_tegra_release
head -n 1 /etc/nv_tegra_release
```

Expected:

- `/etc/nv_tegra_release` exists.
- L4T line is printed (for example `R35.x.x` or `R36.x.x`).

## Phase 2: Docker and NVIDIA runtime checks

Run:

```bash
echo "== Docker binary =="
command -v docker || echo "docker not found"
docker --version || true

echo
echo "== Docker service =="
sudo systemctl is-active docker
sudo systemctl status docker --no-pager -l | sed -n '1,20p'

echo
echo "== Docker info =="
docker info >/dev/null && echo "docker info ok" || echo "docker info failed (try sudo docker info)"

echo
echo "== NVIDIA runtime =="
command -v nvidia-container-runtime || echo "nvidia-container-runtime not found"
nvidia-container-runtime --version || true
docker info 2>/dev/null | grep -i '^ Runtimes' || sudo docker info | grep -i '^ Runtimes'
```

Expected:

- Docker exists and service is `active`.
- `nvidia-container-runtime` exists.
- Docker runtimes include `nvidia`.

## Phase 3: network and disk sanity

```bash
echo "== network =="
ping -c 2 github.com

echo
echo "== free space =="
df -h /
```

Expected:

- internet reachable (needed for first image pull).
- enough free storage for Docker image + models.

## Phase 4: run upstream Goal A flow

```bash
git clone --depth 1 https://github.com/Seeed-Projects/jetson-examples.git
cd jetson-examples/reComputer/scripts/ultralytics-yolo

# optional environment pre-check from upstream
bash init.sh

# main run path
bash run.sh
```

What `run.sh` does:

1. Detects L4T version.
2. Selects compatible Docker image.
3. Pulls image (first run can be long).
4. Starts/attaches the `ultralytics-yolo` container (Web UI/API may also run,
   but browser access is optional).

## Phase 5: command-line only flow (no browser installed)

If the Jetson has no browser, you can still run YOLO fully from terminal.

### 5.1 Start and attach to the upstream container

```bash
cd ~/jetson-examples/reComputer/scripts/ultralytics-yolo
bash run.sh
```

When this finishes, you should be inside the container shell.

### 5.2 Run YOLO from CLI inside the container

Use a host-mounted output path so results persist on the Jetson host:

```bash
# object detection from webcam (/dev/video0)
yolo predict model=yolo11n.pt source=0 show=False save=True \
  project=/usr/src/ultralytics/models/runs name=cli-detect

# human pose from webcam
yolo pose predict model=yolo11n-pose.pt source=0 show=False save=True \
  project=/usr/src/ultralytics/models/runs name=cli-pose
```

Outputs are saved on the host in:

```bash
~/yolo_models/runs/
```

### 5.3 Run on a local video file (host terminal)

```bash
# from Jetson host shell (not inside container)
mkdir -p ~/yolo_models/input
cp /path/to/video.mp4 ~/yolo_models/input/

# re-attach if needed
docker start ultralytics-yolo >/dev/null 2>&1 || true
docker exec -it ultralytics-yolo /bin/bash

# now inside container
yolo predict model=yolo11n.pt source=/usr/src/ultralytics/models/input/video.mp4 \
  show=False save=True project=/usr/src/ultralytics/models/runs name=cli-video
```

### 5.4 Optional: read API results without browser

If the service endpoint is running, query it from terminal:

```bash
curl -fsS http://127.0.0.1:5000/results | python3 -m json.tool | sed -n '1,80p'
```

If this fails, use the direct CLI commands above (5.2/5.3), which do not depend
on the Web UI.

## First-run notes

- Image pull can take a long time on first run.
- Model conversion/initialization can also take time.
- If the terminal appears "stuck," watch for Docker pull logs before interrupting.

## Quick failure triage

### Docker command not found

- Install Docker on the Jetson image.
- Reboot or restart shell, then retry checks.

### Docker service not active

```bash
sudo systemctl start docker
sudo systemctl enable docker
```

### NVIDIA runtime missing from Docker runtimes

- Ensure `nvidia-container-runtime` is installed.
- Configure Docker daemon with `default-runtime: nvidia`.
- Restart Docker: `sudo systemctl restart docker`.

### No L4T file

- Device may not be a Jetson image/installation.
- Verify JetPack installation and board image.

## Links

- Upstream Seeed repo: <https://github.com/Seeed-Projects/jetson-examples>
- Upstream Ultralytics-yolo docs:
  <https://github.com/Seeed-Projects/jetson-examples/blob/main/reComputer/scripts/ultralytics-yolo/README.md>
- Seeed reComputer hardware page: <https://www.seeedstudio.com/reComputer-c-1780.html>
- NVIDIA Jetson Orin page:
  <https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/>
