#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-oracle-relay.sh <env>
#
# Runs the oracle-relay migration:
#   1. oracle-relay  — deploy and configure Moonbeam oracle relay stack
#                      (XcmTransactor + MessageDispatcher + wiring)
#
# Arguments:
#   <env>   Environment name (e.g. fork, moon). Must match an env
#           file in migrations/envs/oracle-relay.<env>.env
#
# Required environment variables:
#   PK   Private key for the oracle-relay deployer (Moonbeam)
#
# Example:
#   PK=0x... ./migrate-oracle-relay.sh moon

ENV=${1:?Usage: migrate-oracle-relay.sh <env>}

PK=${PK:?Missing PK}

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"

run() {
  local migration=$1
  local pk=$2
  shift 2
  npx tsx "$MIGRATIONS_DIR/run.ts" --migration "$migration" --env "$ENV" --pk "$pk" "$@"
}

echo "=== 1/1: oracle-relay ==="
run oracle-relay "$PK"

echo "=== Done ==="
