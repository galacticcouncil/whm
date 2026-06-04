#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-oracle-relay-ethereum.sh <env>
#
# Run the oracle-relay-ethereum merged migration (Ethereum OracleEmitter + Moonbeam dispatcher
# + transactor + wiring + ownership renunciations) in one shot.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars:
#   PK_EMITTER  Ethereum deployer (0x...)
#   PK_RELAY    Moonbeam deployer (0x...)

ENV=${1:?Usage: migrate-oracle-relay-ethereum.sh <env (prod|fork)>}

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
  PK_RELAY=$PK
fi

PK_EMITTER=${PK_EMITTER:?Missing PK_EMITTER (Ethereum EVM private key)}
PK_RELAY=${PK_RELAY:?Missing PK_RELAY (Moonbeam EVM private key)}

export PK_EMITTER PK_RELAY

"$TSX" "$RUNNER" --migration oracle-relay-ethereum --env "$ENV"
