#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export AB_COMPOSE_ENV_FILE="${AB_COMPOSE_ENV_FILE:-.env.public}"
export AB_COMPOSE_VARIANT=public
exec bash scripts/compose.sh "$@"
