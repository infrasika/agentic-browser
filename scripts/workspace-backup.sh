#!/usr/bin/env bash
# Offline backup/restore for the official image-based Compose installation.
set -euo pipefail
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() { printf 'Usage:\n  bash workspace-backup.sh backup CONTROLLER_ID NEW_BACKUP_DIRECTORY\n  bash workspace-backup.sh restore BACKUP_DIRECTORY NEW_VOLUME_NAME\nRun backup from the installation directory after stopping its controller.\nRestore creates a new volume; it never starts services or overwrites a volume.\n'; }
if [ "${1:-}" = --help ]; then usage; exit; fi
[ "$#" -eq 3 ] || { usage >&2; exit 1; }
operation="$1"; source="$2"; target="$3"
helper=(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --cpus 1 --pids-limit 64)
valid_image() { [[ "$1" =~ ^ghcr\.io/infrasika/agentic-browser-controller@sha256:[a-f0-9]{64}$ ]]; }
unused_volume() { [ -z "$(docker ps -q --filter "volume=$1")" ] || fail 'Stop every controller and browser using this volume before backing up.'; }
case "$operation" in
  backup)
    [ -f compose.yaml ] && [ -f .env ] || fail 'Run backup from the installation containing compose.yaml and .env.'
    controller="$(docker compose ps -a -q controller)"
    [ -n "$controller" ] && [ "$controller" = "$source" ] || fail 'The controller must belong to this Compose installation.'
    [ "$(docker inspect --format '{{.State.Running}}' "$controller")" = false ] || fail 'Stop the controller before backing up.'
    image="$(docker inspect --format '{{.Config.Image}}' "$controller")"
    valid_image "$image" || fail 'Backup requires an official controller image pinned by digest.'
    [ "$(docker compose config --images)" = "$image" ] || fail 'Compose image differs from the stopped controller. Back up before editing upgrade settings.'
    configured_runtime="$(docker compose config --format json | "${helper[@]}" -i --user 1000:1000 "$image" node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).services.controller.environment.BROWSER_RUNTIME_IMAGE))')"
    running_runtime="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$controller" | sed -n 's/^BROWSER_RUNTIME_IMAGE=//p')"
    [ "$configured_runtime" = "$running_runtime" ] || fail 'Compose runtime image differs from the stopped controller. Back up before editing upgrade settings.'
    [[ "$configured_runtime" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || fail 'Pin the runtime image by digest before creating a reproducible backup.'
    volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "$controller")"
    [ -n "$volume" ] || fail 'The controller has no named data volume.'
    unused_volume "$volume"
    # A partial directory is deliberately retained on failure, without COMPLETE.
    # mkdir refuses existing backups instead of silently replacing private data.
    mkdir -- "$target"
    cp -- compose.yaml .env "$target/"
    printf '%s\n' "$image" > "$target/controller-image.txt"
    printf '%s\n' "$configured_runtime" > "$target/runtime-image.txt"
    printf '%s\n' "$volume" > "$target/source-volume.txt"
    "${helper[@]}" --user 1000:1000 --mount "type=volume,src=$volume,dst=/data,readonly" \
      "$image" tar --create --gzip --file - --directory /data . > "$target/data.tar.gz"
    "${helper[@]}" -i --user 1000:1000 "$image" sha256sum < "$target/data.tar.gz" > "$target/data.sha256"
    unused_volume "$volume"
    chmod 600 "$target/compose.yaml" "$target/.env" "$target/data.tar.gz"
    touch "$target/COMPLETE"
    printf 'Backup complete: %s\nThe archive and .env contain private data. Keep this directory private.\n' "$target"
    ;;
  restore)
    [[ "$target" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || fail 'Use a valid new Docker volume name.'
    for file in COMPLETE compose.yaml .env controller-image.txt runtime-image.txt data.tar.gz data.sha256; do
      [ -f "$source/$file" ] && [ ! -L "$source/$file" ] || fail "Missing or unsafe backup file: $file"
    done
    image="$(cat "$source/controller-image.txt")"
    valid_image "$image" || fail 'Backup controller image must be an official digest-pinned image.'
    runtime="$(cat "$source/runtime-image.txt")"
    [[ "$runtime" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || fail 'Backup runtime image must be pinned by digest.'
    expected="$(cat "$source/data.sha256")"
    [[ "$expected" =~ ^[a-f0-9]{64}[[:space:]]+-[[:space:]]*$ ]] || fail 'Invalid archive checksum record.'
    actual="$("${helper[@]}" -i --user 1000:1000 "$image" sha256sum < "$source/data.tar.gz")"
    [ "$actual" = "$expected" ] || fail 'Archive checksum mismatch; no restore volume was created.'
    volumes="$(docker volume ls --format '{{.Name}}')"
    while IFS= read -r name; do [ "$name" != "$target" ] || fail 'Restore requires a new volume; the requested volume already exists.'; done <<< "$volumes"
    docker pull "$runtime" >/dev/null
    marker="restore-$(date +%s)-$$-$RANDOM"
    docker volume create --label "dev.agentic-browser.restore=$marker" "$target" >/dev/null
    [ "$(docker volume inspect --format '{{index .Labels "dev.agentic-browser.restore"}}' "$target")" = "$marker" ] || fail 'The volume was created by another process; refusing to modify it.'
    # Only initialize this new volume as root. Archive extraction runs as the
    # controller UID, without a Docker socket, network, or writable rootfs.
    "${helper[@]}" --user 0:0 --cap-add CHOWN --mount "type=volume,src=$target,dst=/restore" "$image" chown 1000:1000 /restore
    "${helper[@]}" -i --user 1000:1000 --mount "type=volume,src=$target,dst=/restore" \
      "$image" tar --extract --gzip --file - --directory /restore --no-same-owner --same-permissions < "$source/data.tar.gz"
    printf 'Restored into new volume: %s\nStart the backed-up images/configuration against this volume only after stopping the original workspace.\n' "$target"
    ;;
  *) usage >&2; exit 1 ;;
esac
