#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump-base.sh <env>
#
# Run the basejump-base merged migration (Hydration landing + Moonbeam proxy + Base basejump
# + wiring + ownership renunciations) in one shot.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK_LANDING  Hydration deployer (0x...)
#   PK_PROXY    Moonbeam deployer (0x...)
#   PK          Base deployer (0x...)
#
# Example:
#   PK=0x... PK_PROXY=0x... PK_LANDING=0x... ./sh/migrate-basejump-base.sh prod

ENV=${1:?Usage: migrate-basejump-base.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load root .env if present (for PK overrides etc.)
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

PK_LANDING=${PK_LANDING:?Missing PK_LANDING}
PK_PROXY=${PK_PROXY:?Missing PK_PROXY}
PK=${PK:?Missing PK}

export PK_LANDING PK_PROXY PK

npx tsx "$ROOT_DIR/migrations/run.ts" --migration basejump-base --env "$ENV"
