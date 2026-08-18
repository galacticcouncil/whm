#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-oracle-relay-solana.sh <env>
#
# Run the oracle-relay-solana merged migration (Solana emitter program + Hydration OracleReceiver
# + wiring + ownership renunciation) in one shot.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars:
#   PK_EMITTER   Solana deployer (BS58-encoded secret key)
#   PK_RECEIVER  Hydration deployer (0x...)

ENV=${1:?Usage: migrate-oracle-relay-solana.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  PK_EMITTER=$("$TSX" "$ROOT_DIR/crates/solana/scripts/getForkKey.ts")
  PK_RECEIVER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
fi

PK_EMITTER=${PK_EMITTER:?Missing PK_EMITTER (BS58-encoded Solana keypair)}
PK_RECEIVER=${PK_RECEIVER:?Missing PK_RECEIVER (Hydration EVM private key)}

export PK_EMITTER PK_RECEIVER

"$TSX" "$RUNNER" --migration oracle-relay-solana --env "$ENV"
