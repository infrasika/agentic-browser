#!/usr/bin/env bash
# Use published, immutable images with the existing private-volume deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
release_file="${AB_RELEASE_FILE:-deploy/release.env}"
if [ ! -f "$release_file" ]; then
  printf 'Missing release pins: %s. Obtain deploy/release.env from a published release.\n' "$release_file" >&2
  exit 1
fi
controller_ref='' runtime_ref=''
while IFS='=' read -r release_key release_value || [ -n "$release_key" ]; do
  case "$release_key" in
    ''|'#'*) continue ;;
    AB_CONTROLLER_IMAGE) controller_ref="$release_value" ;;
    AB_RUNTIME_IMAGE) runtime_ref="$release_value" ;;
    *) printf 'Unsupported release pin: %s\n' "$release_key" >&2; exit 1 ;;
  esac
done < "$release_file"
for release_ref in "$controller_ref" "$runtime_ref"; do
  if [[ ! "$release_ref" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]; then
    printf 'Release images must use a GHCR sha256 digest, not a mutable tag.\n' >&2; exit 1
  fi
done
export AB_CONTROLLER_IMAGE="$controller_ref" AB_RUNTIME_IMAGE="$runtime_ref"
case "${1:-}" in
  pull|pull-client)
    docker pull "$AB_CONTROLLER_IMAGE"
    if [ "$1" = pull ]; then docker pull "$AB_RUNTIME_IMAGE"; fi
    exit
    ;;
  doctor)
    shift
    set -- exec -T controller node --import tsx src/doctor.ts "$@"
    ;;
  member)
    shift
    # Keep Compose's interactive terminal for the hidden password prompt.
    set -- exec controller node --import tsx src/members-cli.ts "$@"
    ;;
  mcp)
    shift
    set -- exec -T -e AGENT_BROWSER_TOKEN -e AGENT_BROWSER_URL -e AGENT_BROWSER_VIEW_URL \
      controller node --import tsx src/mcp.ts "$@"
    ;;
  mcp-remote)
    : "${AGENT_BROWSER_URL:?Set the private service URL reachable from this client container}"
    : "${AGENT_BROWSER_TOKEN:?Set your personal Agent credential}"
    # The same published image provides a client without any server permissions.
    # No host paths, private data volume, or Docker socket are mounted.
    exec docker run --rm -i --init --read-only --cap-drop ALL \
      --security-opt no-new-privileges --user 1000:1000 \
      --memory 256m --cpus 0.5 --pids-limit 64 \
      --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
      -e AGENT_BROWSER_TOKEN -e AGENT_BROWSER_URL -e AGENT_BROWSER_VIEW_URL \
      --entrypoint node "$AB_CONTROLLER_IMAGE" --import tsx src/mcp.ts
    ;;
esac
if [ "${AB_COMPOSE_VARIANT:-}" = public ]; then
  exec bash scripts/public-demo.sh "$@"
fi
exec bash scripts/compose.sh "$@"
