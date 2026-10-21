#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-governance-hydration.sh <env>
#
# Deploy the shared GovernanceDispatcher on Hydration. Its proxy address is copied into each
# destination governance migration's GOVERNANCE_DISPATCHER_HYDRATION setting.
#
# Required env vars:
#   PK_HYDRATION  Hydration deployer (0x...), with an EVMAccounts.ContractDeployer slot

ENV=${1:?Usage: migrate-governance-hydration.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  PK_HYDRATION=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
fi

PK_HYDRATION=${PK_HYDRATION:?Missing PK_HYDRATION (Hydration EVM private key)}
export PK_HYDRATION

"$TSX" "$RUNNER" --migration governance-hydration --env "$ENV"

if [ "$ENV" = "prod" ]; then
  node "$ROOT_DIR/scripts/governance/verify-neckwork.mjs"
fi
