#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Compatibility entry point. New installations use AB_MODE=public in .env.
if [ -z "${AB_COMPOSE_ENV_FILE:-}" ]; then
  if [ -f .env ] && grep -Eq '^AB_MODE=' .env; then
    export AB_COMPOSE_ENV_FILE=.env
  elif [ -f .env.public ]; then
    export AB_COMPOSE_ENV_FILE=.env.public
  else
    export AB_COMPOSE_ENV_FILE=.env
  fi
fi
export AB_COMPOSE_VARIANT=public
exec bash scripts/compose.sh "$@"
