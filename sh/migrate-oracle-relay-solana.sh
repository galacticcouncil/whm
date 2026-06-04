#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-oracle-relay-solana.sh <env>
#
# Run the oracle-relay-solana merged migration (Solana emitter program + Moonbeam dispatcher
# + transactor + wiring + ownership renunciations) in one shot.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars:
#   PK_EMITTER  Solana deployer (BS58-encoded secret key)
#   PK_RELAY    Moonbeam deployer (0x...)

ENV=${1:?Usage: migrate-oracle-relay-solana.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

PK_EMITTER=${PK_EMITTER:?Missing PK_EMITTER (BS58-encoded Solana keypair)}
PK_RELAY=${PK_RELAY:?Missing PK_RELAY (Moonbeam EVM private key)}

export PK_EMITTER PK_RELAY

npx tsx "$ROOT_DIR/migrations/run.ts" --migration oracle-relay-solana --env "$ENV"
