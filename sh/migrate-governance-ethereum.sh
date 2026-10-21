#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-governance-ethereum.sh <env>
#
# Deploy the Ethereum GovernanceExecutor for the shared Hydration GovernanceDispatcher.
# Set GOVERNANCE_DISPATCHER_HYDRATION in the migration env file before running.
#
# Required env vars:
#   PK_ETHEREUM  Ethereum deployer (0x...)

ENV=${1:?Usage: migrate-governance-ethereum.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  PK_ETHEREUM=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
fi

PK_ETHEREUM=${PK_ETHEREUM:?Missing PK_ETHEREUM (Ethereum EVM private key)}
export PK_ETHEREUM

"$TSX" "$RUNNER" --migration governance-ethereum --env "$ENV"
