#!/bin/bash

echo "=== Available Cameras ==="

OS="$(uname)"
if [ "$OS" = "Darwin" ]; then
    echo "macOS detected. Found the following cameras:"
    system_profiler SPCameraDataType | grep "^    [^ ]" | sed "s/://g" | while read -r line; do
        echo "  - $line"
    done
elif [ "$OS" = "Linux" ]; then
    echo "Linux detected. Found the following video devices:"
    for dev in /dev/video*; do 
        if [ -e "$dev" ]; then
            echo "  - $dev"
        fi
    done
    
    if command -v v4l2-ctl &> /dev/null; then
        echo ""
        echo "Detailed info (v4l2-ctl):"
        v4l2-ctl --list-devices
    fi
else
    echo "Unsupported OS: $OS"
fi

echo "========================="
