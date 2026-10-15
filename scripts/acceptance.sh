#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
acceptance_dir="output/acceptance/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$acceptance_dir"
printf 'step\tresult\tlog\n' > "$acceptance_dir/results.tsv"
run_check() {
  local name="$1"; shift
  printf 'Running %s\n' "$name"
  if "$@" > "$acceptance_dir/$name.log" 2>&1; then
    printf '%s\tPASS\t%s.log\n' "$name" "$name" >> "$acceptance_dir/results.tsv"
  else
    printf '%s\tFAIL\t%s.log\n' "$name" "$name" >> "$acceptance_dir/results.tsv"
    tail -n 60 "$acceptance_dir/$name.log"
    printf 'Acceptance stopped; evidence: %s\n' "$acceptance_dir/results.tsv"
    exit 1
  fi
}
run_check types npm run check
run_check unit npm test
run_check browser npm run test:browser
run_check desktop npm run test:desktop
run_check team npm run test:team
run_check extensions npm run test:extensions
run_check runtime npm run test:runtime
run_check controller npm run test:controller
run_check mcp-docker env AGENTIC_TEST_DOCKER=1 AGENTIC_TEST_MCP=1 npx tsx --test test/team-desktop.integration.ts
run_check demo npm run test:demo
run_check public-mcp npm run test:public-mcp
run_check reliability npm run test:reliability
printf 'All acceptance steps passed: %s\n' "$acceptance_dir/results.tsv"
