#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump-base.sh <env> [runner flags...]
#
# Run the basejump-base merged migration — the direct Base -> Hydration corridor
# (Base source + NTT settlement wiring, then the Hydration receiver) in one shot.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK            Base deployer (0x...)
#   PK_HYDRATION  Hydration deployer (0x...), needs an EVMAccounts.ContractDeployer slot
#
# Example:
#   PK=0x... PK_HYDRATION=0x... ./sh/migrate-basejump-base.sh prod

ENV=${1:?Usage: migrate-basejump-base.sh <env (prod|fork)>}
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
  PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK_HYDRATION=$PK
fi

PK=${PK:?Missing PK}
PK_HYDRATION=${PK_HYDRATION:?Missing PK_HYDRATION}

export PK PK_HYDRATION

"$TSX" "$RUNNER" --migration basejump-base --env "$ENV" "$@"
