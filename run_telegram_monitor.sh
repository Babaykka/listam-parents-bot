#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE="/Users/hrach/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
NODE_MODULES="/Users/hrach/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"

if [ ! -x "$NODE" ]; then
  echo "Bundled Node.js was not found at: $NODE" >&2
  echo "Install Node.js and Playwright, then run scripts/telegram_listam_monitor.js with NODE_PATH set." >&2
  exit 1
fi

NODE_PATH="$NODE_MODULES" "$NODE" "$ROOT_DIR/src/app.js" "$@"
