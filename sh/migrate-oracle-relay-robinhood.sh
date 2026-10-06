#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-oracle-relay-robinhood.sh <env>
#
# Run the oracle-relay-robinhood merged migration (Robinhood OracleEmitter + ChainlinkAdapter +
# Hydration OracleReceiver + wiring + ownership renunciation). Stops at 006-set-spy@receiver until
# SPY_ORACLE_ADDRESS is set — deploy the Hydration oracle against the receiver, then re-run.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars:
#   PK_EMITTER   Robinhood deployer (0x...)
#   PK_RECEIVER  Hydration deployer (0x...)

ENV=${1:?Usage: migrate-oracle-relay-robinhood.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK_EMITTER=$PK
  PK_RECEIVER=$PK
fi

PK_EMITTER=${PK_EMITTER:?Missing PK_EMITTER (Robinhood EVM private key)}
PK_RECEIVER=${PK_RECEIVER:?Missing PK_RECEIVER (Hydration EVM private key)}

export PK_EMITTER PK_RECEIVER

"$TSX" "$RUNNER" --migration oracle-relay-robinhood --env "$ENV"
