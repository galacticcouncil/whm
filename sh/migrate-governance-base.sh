#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-governance-base.sh <env>
#
# Deploy the Base GovernanceExecutor for the shared Hydration GovernanceDispatcher.
# Set GOVERNANCE_DISPATCHER_HYDRATION in the migration env file before running.
#
# Required env vars:
#   PK_BASE  Base deployer (0x...)

ENV=${1:?Usage: migrate-governance-base.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  PK_BASE=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
fi

PK_BASE=${PK_BASE:?Missing PK_BASE (Base EVM private key)}
export PK_BASE

"$TSX" "$RUNNER" --migration governance-base --env "$ENV"
