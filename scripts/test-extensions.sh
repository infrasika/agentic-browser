#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_root="$PWD"
task_image="${AGENTIC_TEST_IMAGE:-agentic-browser:zkpass-prototype}"
task_name="agentic-browser-extension-test-$$"
mkdir -p output/runtime/screenshots
task_screenshots="$(mktemp -d)"
# Only synthetic test screenshots go here. The runner UID may differ from the
# image's node UID; never change permissions on the checkout or real profiles.
chmod 0777 "$task_screenshots"
cleanup() {
  docker rm -f "$task_name" >/dev/null 2>&1 || true
  cp -R "$task_screenshots/." output/runtime/screenshots/ || true
  rm -rf "$task_screenshots"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# No Docker socket, host network or user profiles are mounted into this test.
docker run --rm --init --name "$task_name" \
  --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=768m \
  --tmpfs /home/node:rw,nosuid,nodev,uid=1000,gid=1000,size=64m \
  --shm-size=512m --memory=2g --cpus=2 --pids-limit=512 \
  --cap-drop=ALL --security-opt no-new-privileges \
  --security-opt "seccomp=$task_root/runtime/chrome-seccomp.json" \
  --mount "type=bind,src=$task_screenshots,dst=/app/output/playwright" \
  "$task_image" node --import tsx --test test/extensions.integration.ts \
  2>&1 | tee output/runtime/extensions-test.log
