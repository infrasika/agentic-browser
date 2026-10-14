#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
controller_image="${AB_CONTROLLER_IMAGE:-agentic-browser:controller-preview}"
runtime_image="${AB_RUNTIME_IMAGE:-agentic-browser:zkpass-prototype}"
# Both images use the builder's native architecture; release CI uses native runners.
docker build -f runtime/controller.Dockerfile -t "$controller_image" .
mkdir -p output/runtime/packages
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --cpus 1 --pids-limit 64 --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD/output/runtime/packages,dst=/app/output/runtime/packages" \
  "$controller_image" python3 scripts/fetch-runtime-assets.py
docker build -f runtime/Dockerfile -t "$runtime_image" .
