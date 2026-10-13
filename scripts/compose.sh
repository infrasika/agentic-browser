#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Deliberately do not source shell code or inherit the host-service .env file.
config_file="${AB_COMPOSE_ENV_FILE:-.env.compose}"
if [ ! -f "$config_file" ]; then
  if [ -n "${AB_COMPOSE_ENV_FILE:-}" ]; then
    printf 'Missing AB_COMPOSE_ENV_FILE: %s\n' "$config_file" >&2; exit 1
  fi
  config_file=/dev/null
fi
if [ -n "${DOCKER_CONTEXT:-}" ] || [ -z "${DOCKER_HOST:-}" ]; then
  endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
else
  endpoint="$DOCKER_HOST"
fi
case "$endpoint" in
  unix://*) ;;
  *) printf 'Use a local Docker Unix socket context; remote SSH/TCP contexts are not supported by this deployment.\n' >&2; exit 1 ;;
esac
if [ -z "${AB_DOCKER_SOCKET:-}" ]; then
  if [ "$(uname -s)" = Darwin ]; then
    # This is Docker Desktop's daemon-side socket, not a macOS shared file.
    AB_DOCKER_SOCKET=/var/run/docker.sock
  else
    AB_DOCKER_SOCKET="${endpoint#unix://}"
  fi
fi
case "$AB_DOCKER_SOCKET" in
  /*) ;;
  *) printf 'AB_DOCKER_SOCKET must be an absolute Unix socket path.\n' >&2; exit 1 ;;
esac
case "$AB_DOCKER_SOCKET" in
  *','*|*$'\n'*) printf 'Unsupported socket path.\n' >&2; exit 1 ;;
esac
export AB_DOCKER_SOCKET
compose=(docker compose --env-file "$config_file" -f compose.yaml)
if [ -z "${AB_DOCKER_GID:-}" ]; then
  # Only the controller image receives the socket, including this short probe.
  # Read its Linux-side group; macOS host stat can report a different group.
  controller_image="$(AB_DOCKER_GID=0 "${compose[@]}" config --images)"
  AB_DOCKER_GID="$(docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 1000:1000 \
    --memory 128m --cpus 0.5 --pids-limit 32 \
    --mount "type=bind,src=$AB_DOCKER_SOCKET,dst=/var/run/docker.sock" \
    "$controller_image" stat -c %g /var/run/docker.sock)"
fi
case "$AB_DOCKER_GID" in
  ''|*[!0-9]*) printf 'Could not detect the Docker socket group.\n' >&2; exit 1 ;;
esac
export AB_DOCKER_GID
exec "${compose[@]}" "$@"
