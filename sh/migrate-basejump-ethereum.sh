#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump-ethereum.sh <env>
#
# Run the basejump-ethereum merged migration (Moonbeam proxy + transactor + Ethereum basejump
# + wiring + ownership renunciations) in one shot. Reuses the existing basejump-base Hydration
# landing; authorizing it for this corridor is a Hydration TC governance action (see the env file).
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK_PROXY    Moonbeam deployer (0x...)
#   PK          Ethereum deployer (0x...)
#
# Example:
#   PK=0x... PK_PROXY=0x... ./sh/migrate-basejump-ethereum.sh prod

ENV=${1:?Usage: migrate-basejump-ethereum.sh <env (prod|fork)>}

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
  PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK_PROXY=$PK
fi

PK_PROXY=${PK_PROXY:?Missing PK_PROXY}
PK=${PK:?Missing PK}

export PK_PROXY PK

"$TSX" "$RUNNER" --migration basejump-ethereum --env "$ENV"
