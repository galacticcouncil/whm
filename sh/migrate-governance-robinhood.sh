#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-governance-robinhood.sh <env>
#
# Deploy the shared GovernanceDispatcher on Hydration and the first GovernanceExecutor on
# Robinhood. Both ERC-1967 proxies are initialized atomically and have no deployer authority.
#
# Required env vars:
#   PK_HYDRATION  Hydration deployer (0x...)
#   PK_ROBINHOOD  Robinhood deployer (0x...)

ENV=${1:?Usage: migrate-governance-robinhood.sh <env (prod|fork)>}

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
  PK_HYDRATION=$PK
  PK_ROBINHOOD=$PK
fi

PK_HYDRATION=${PK_HYDRATION:?Missing PK_HYDRATION (Hydration EVM private key)}
PK_ROBINHOOD=${PK_ROBINHOOD:?Missing PK_ROBINHOOD (Robinhood EVM private key)}

export PK_HYDRATION PK_ROBINHOOD

"$TSX" "$RUNNER" --migration governance-robinhood --env "$ENV"
