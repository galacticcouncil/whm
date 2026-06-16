#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-nintent-ethereum-alpha.sh <env>
#
# ALPHA: deploy + wire the Intents Moonbeam → Ethereum (2nd) leg only — no Hydration.
#   Moonbeam : BasejumpProxy
#   Ethereum : Basejump + BasejumpLandingNative + IntentRouter
# Drive it by calling BasejumpProxy.bridgeViaWormhole directly on Moonbeam.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK_PROXY  Moonbeam deployer (0x...)
#   PK        Ethereum deployer (0x...)
#
# Example:
#   PK_PROXY=0x... PK=0x... ./sh/migrate-nintent-ethereum-alpha.sh fork

ENV=${1:?Usage: migrate-nintent-ethereum.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

# Load root .env if present (for PK overrides etc.)
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  # Default anvil dev account #0 on every fork
  ANVIL_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK_PROXY=${PK_PROXY:-$ANVIL_PK}
  PK=${PK:-$ANVIL_PK}
fi

PK_PROXY=${PK_PROXY:?Missing PK_PROXY}
PK=${PK:?Missing PK}

export PK_PROXY PK

"$TSX" "$RUNNER" --migration nintent-ethereum --env "$ENV"
