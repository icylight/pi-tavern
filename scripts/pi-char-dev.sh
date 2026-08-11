#!/usr/bin/env bash
# PiTavern headless character launcher (ISSUE-014, CPU 根治).
#
# Runs a Character pi in RPC mode (no TUI — autonomous Characters do not need
# a terminal UI rendering pipeline). The character
# auto-joins an active group chat on startup and participates via the
# group-chat input pipeline; interaction happens entirely through the
# group chat (tavern_speak / tavern_whoami tools).
#
# Usage:
#   scripts/pi-char-dev.sh [--character <name|character_id>] [--group <id|name>] [--] [extra pi args...]
#
# Env (all optional):
#   PITAVERN_CHARACTER   character card name or character_id to join as
#                        (default: first available character)
#   PITAVERN_GROUP_CHAT  group chat id or name to join
#                        (default: the only active group chat, else first)
#
# Example:
#   scripts/pi-char-dev.sh --character Dev
#   PITAVERN_CHARACTER=qa scripts/pi-char-dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

CHARACTER="${PITAVERN_CHARACTER:-}"
GROUP="${PITAVERN_GROUP_CHAT:-}"
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--character)
			CHARACTER="$2"
			shift 2
			;;
		--group)
			GROUP="$2"
			shift 2
			;;
		--)
			shift
			EXTRA_ARGS+=("$@")
			break
			;;
		-*)
			EXTRA_ARGS+=("$1")
			shift
			;;
		*)
			EXTRA_ARGS+=("$1")
			shift
			;;
	esac
done

# Isolated agent dir so a headless character never touches the daily pi.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$REPO_ROOT/.dev/pi-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"

export PITAVERN_AUTO_JOIN=1
if [[ -n "$CHARACTER" ]]; then
	export PITAVERN_CHARACTER="$CHARACTER"
fi
if [[ -n "$GROUP" ]]; then
	export PITAVERN_GROUP_CHAT="$GROUP"
fi

exec "$REPO_ROOT/references/pi/pi-test.sh" \
	-e "$REPO_ROOT/src/index.ts" \
	--mode rpc \
	"${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
