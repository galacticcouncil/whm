#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-psm-base.sh <env>
#
# Run the psm-base merged migration (Hydration facilitator + Base vault + emitter binding
# + launch parameters + admin handover) in one shot.
#
# Build first — the PSM contracts use their own Foundry profile, and the actions read artifacts
# from contracts/out-psm/:
#
#   FOUNDRY_PROFILE=psm pnpm --filter @whm/contracts build
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK_FACILITATOR  Hydration deployer (0x...)
#   PK              Base deployer (0x...)
#
# Example:
#   PK=0x... PK_FACILITATOR=0x... ./sh/migrate-psm-base.sh prod

ENV=${1:?Usage: migrate-psm-base.sh <env (prod|fork)>}

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
  PK_FACILITATOR=$PK
fi

PK_FACILITATOR=${PK_FACILITATOR:?Missing PK_FACILITATOR}
PK=${PK:?Missing PK}

export PK_FACILITATOR PK

"$TSX" "$RUNNER" --migration psm-base --env "$ENV"
