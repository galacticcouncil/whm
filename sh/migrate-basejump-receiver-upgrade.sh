#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump-receiver-upgrade.sh <env> [runner flags...]
#
# Deploy the current BasejumpReceiver implementation on Hydration for a live receiver proxy.
# The upgrade itself (upgradeToAndCall) is owner-gated and the owner is the Hydration TC, so the
# step records the calldata for governance rather than sending it.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK_HYDRATION  Hydration deployer (0x...), needs an EVMAccounts.ContractDeployer slot
#
# Example:
#   PK_HYDRATION=0x... ./sh/migrate-basejump-receiver-upgrade.sh prod

ENV=${1:?Usage: migrate-basejump-receiver-upgrade.sh <env (prod|fork)>}
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
  PK_HYDRATION=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
fi

PK_HYDRATION=${PK_HYDRATION:?Missing PK_HYDRATION}

export PK_HYDRATION

# The action deploys contracts/out, so build it from this checkout first.
(cd "$ROOT_DIR/contracts" && forge build)

"$TSX" "$RUNNER" --migration basejump-receiver-upgrade --env "$ENV" "$@"
