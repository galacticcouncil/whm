#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-basejump.sh <env>
#
# Runs the full basejump migration sequence in order:
#   1. basejump-proxy        — up to and including set-xcm-transactor
#   2. basejump-landing      — full migration
#   3. basejump              — full migration
#   4. basejump-proxy        — resumes from set-emitter to completion
#
# Arguments:
#   <env>   Environment name (e.g. base, fork, moonbeam). Must match an env
#           file in migrations/envs/<migration>.<env>.env
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

PK_PROXY=${PK_PROXY:?Missing PK_PROXY}
PK_LANDING=${PK_LANDING:?Missing PK_LANDING}
PK=${PK:?Missing PK}

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"

run() {
  local migration=$1
  local pk=$2
  shift 2
  npx tsx "$MIGRATIONS_DIR/run.ts" --migration "$migration" --env "$ENV" --pk "$pk" "$@"
}

echo "=== 1/4: basejump-proxy (init) ==="
run basejump-proxy "$PK_PROXY" --pause-at set-xcm-transactor

echo "=== 2/4: basejump-landing ==="
run basejump-landing "$PK_LANDING"

echo "=== 3/4: basejump ==="
run basejump "$PK"

echo "=== 4/4: basejump-proxy (resume) ==="
run basejump-proxy "$PK_PROXY"

echo "=== Done ==="
