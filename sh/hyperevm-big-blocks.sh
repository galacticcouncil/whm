#!/usr/bin/env bash
set -euo pipefail

# Usage: hyperevm-big-blocks.sh <on|off>
#
# Toggle HyperEVM big blocks (30M gas, ~1 min) for the PK_HYPEREVM deployer via the
# HyperCore `evmUserModify` action. Large deploys (GovernanceExecutor impl ~4.8M gas)
# don't fit a small 2M block. Turn on before the deploy, off after. The deployer needs
# a HyperCore account (any prior HyperCore balance/activity).
#
# Required env vars:
#   PK_HYPEREVM  HyperEVM deployer (0x...)

MODE=${1:?Usage: hyperevm-big-blocks.sh <on|off>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

PK_HYPEREVM=${PK_HYPEREVM:?Missing PK_HYPEREVM (HyperEVM private key)}
export PK_HYPEREVM

node "$ROOT_DIR/scripts/hyperevm/set-big-blocks.mjs" "$MODE"
