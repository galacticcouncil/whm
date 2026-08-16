#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump-base-ntt.sh <env> [runner flags...]
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK  deployer (0x...)

ENV=${1:?Usage: migrate-basejump-base-ntt.sh <env (prod|fork)>}
shift

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
fi

PK=${PK:?Missing PK}
export PK

"$TSX" "$RUNNER" --migration basejump-base-ntt --env "$ENV" "$@"
