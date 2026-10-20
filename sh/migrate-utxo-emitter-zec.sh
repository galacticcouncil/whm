#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-utxo-emitter-zec.sh <env> [runner flags...]
#
# Run the utxo-emitter-zec migration — deploy the Hydration ZecUtxoEmitter, wire it to the ZEC and
# NEAR NTT managers, set its fee and hand it to the Technical Committee.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK      Hydration deployer (0x...) — needs an EVMAccounts.ContractDeployer slot
#
# Build the contracts first:
#   pnpm --filter @whm/contracts build
#
# Example:
#   PK=0x... ./sh/migrate-utxo-emitter-zec.sh fork

ENV=${1:?Usage: migrate-utxo-emitter-zec.sh <env (prod|fork)>}
shift

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
  # Default anvil dev account #0
  PK=${PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
fi

PK=${PK:?Missing PK}

export PK

"$TSX" "$RUNNER" --migration utxo-emitter-zec --env "$ENV" "$@"
