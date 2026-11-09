#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-utxo-withdraw-zec.sh <env> [runner flags...]
#
# Run the utxo-withdraw-zec migration — deploy the Zcash UTXO withdraw contract on NEAR, hand its
# ownership to the custodian and delete its keys.
#
# Arguments:
#   <env>   Environment context: prod | testnet
#
# Required env vars (set in shell or root .env):
#   PK_NEAR       NEAR deployer secret key (ed25519:...) for NEAR_ACCOUNT
#
# Build the wasm first:
#   (cd crates/near/contracts/utxo-withdraw && cargo near build non-reproducible-wasm --no-abi)
#
# Example:
#   PK_NEAR=ed25519:... ./sh/migrate-utxo-withdraw-zec.sh testnet

ENV=${1:?Usage: migrate-utxo-withdraw-zec.sh <env (prod|testnet)>}
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

PK_NEAR=${PK_NEAR:?Missing PK_NEAR}

export PK_NEAR

# WITHDRAW_WASM in the env file is relative to the repo root.
cd "$ROOT_DIR"
"$TSX" "$RUNNER" --migration utxo-withdraw-zec --env "$ENV" "$@"
