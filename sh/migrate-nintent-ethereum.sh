#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-nintent-ethereum.sh <env>
#
# Deploy the Hydration-side IntentEmitter (WTT) + authorize its XCM operator.
#   Hydration : IntentEmitterWtt (UUPS proxy)
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK        Hydration deployer (0x...)
#
# Example:
#   PK=0x... ./sh/migrate-nintent-ethereum.sh fork

ENV=${1:?Usage: migrate-nintent-ethereum.sh <env (prod|fork)>}

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
  # Default anvil dev account #0 on every fork
  ANVIL_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK=${PK:-$ANVIL_PK}
fi

PK=${PK:?Missing PK}

export PK

"$TSX" "$RUNNER" --migration nintent-ethereum --env "$ENV"
