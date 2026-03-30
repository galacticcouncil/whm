#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump.sh <env>
#
# Runs the full basejump migration sequence in order:
#   1. basejump-proxy        — proxy + transactor setup
#   2. basejump-landing      — hydration landing
#   3. basejump              — dest bridge + lending (if any)
#   4. basejump-proxy-setup  — per-chain wiring (emitter + landing)
#
# Arguments:
#   <env>   Environment name (e.g. base, fork, moon). Must match an env
#           file in migrations/envs/<env>/<migration>.env
#
# Required environment variables:
#   PK_PROXY       Private key for the basejump-proxy deployer (Moonbeam)
#   PK_LANDING     Private key for the basejump-landing deployer (Hydration)
#   PK             Private key for the basejump deployer (<env> chain e.g. Base)
#
# Example:
#   PK=0x... PK_LANDING=0x... PK_PROXY=0x... \
#     ./migrate-basejump.sh base

ENV=${1:?Usage: migrate-basejump.sh <env>}

if [ "$ENV" = "fork" ]; then
  PROXY_ENV="fork"
else
  PROXY_ENV="moon"
fi

PK_PROXY=${PK_PROXY:?Missing PK_PROXY}
PK_LANDING=${PK_LANDING:?Missing PK_LANDING}
PK=${PK:?Missing PK}

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"

echo "=== 1/4: basejump-proxy (init) ==="
npx tsx "$MIGRATIONS_DIR/run.ts" \
  --migration "basejump-proxy" \
  --env "$PROXY_ENV" \
  --pk "$PK_PROXY"

echo "=== 2/4: basejump-landing ==="
npx tsx "$MIGRATIONS_DIR/run.ts" \
  --migration "basejump-landing" \
  --env "$ENV" \
  --pk "$PK_LANDING"

echo "=== 3/4: basejump ==="
npx tsx "$MIGRATIONS_DIR/run.ts" \
  --migration "basejump" \
  --env "$ENV" \
  --pk "$PK"

echo "=== 4/4: basejump-proxy-setup ==="
npx tsx "$MIGRATIONS_DIR/run.ts" \
  --migration "basejump-proxy-setup" \
  --env "$ENV" \
  --pk "$PK_PROXY"

echo "=== Done ==="
