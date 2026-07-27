#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

export PI_CODING_AGENT_DIR="$REPO_ROOT/.dev/pi-agent"

mkdir -p "$PI_CODING_AGENT_DIR"

exec "$REPO_ROOT/references/pi/pi-test.sh" \
	-e "$REPO_ROOT/src/index.ts" \
	"$@"
