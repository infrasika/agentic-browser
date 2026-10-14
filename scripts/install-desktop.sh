#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  echo "This installer requires Ubuntu/Debian Linux." >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) task_arch=amd64 ;;
  aarch64|arm64) task_arch=arm64 ;;
  *) echo "Chrome requires x86_64 or ARM64 Linux." >&2; exit 1 ;;
esac
task_sudo=()
if [[ "$(id -u)" != 0 ]]; then task_sudo=(sudo); fi
"${task_sudo[@]}" apt-get update
"${task_sudo[@]}" apt-get install -y --no-install-recommends xvfb xauth x11vnc openbox curl ca-certificates util-linux
task_dir="$(mktemp -d)"
trap 'rm -rf "$task_dir"' EXIT
curl --fail --location --show-error "https://dl.google.com/linux/direct/google-chrome-stable_current_${task_arch}.deb" -o "$task_dir/google-chrome.deb"
"${task_sudo[@]}" apt-get install -y "$task_dir/google-chrome.deb"
echo 'Desktop dependencies installed. Set BROWSER_MODE=desktop in .env and restart the service.'
