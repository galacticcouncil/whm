#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-oracle-relay-solana.sh <env>
#
# Runs the oracle-relay-solana migration:
#   1. oracle-relay-solana  — deploy and configure Moonbeam oracle relay stack
#                      (XcmTransactor + OracleDispatcher + wiring)
#
# Arguments:
#   <env>   Environment name (e.g. fork, moonbeam). Must match an env
#           file in migrations/envs/oracle-relay.<env>.env
#
# Required environment variables:
#   PK   Private key for the oracle-relay deployer (Moonbeam)
#
# Example:
#   PK=0x... ./migrate-oracle-relay-solana.sh moonbeam

ENV=${1:?Usage: migrate-oracle-relay-solana.sh <env>}

PK=${PK:?Missing PK}

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"

run() {
  local migration=$1
  local pk=$2
  shift 2
  npx tsx "$MIGRATIONS_DIR/run.ts" --migration "$migration" --env "$ENV" --pk "$pk" "$@"
}

echo "=== 1/1: oracle-relay-solana ==="
run oracle-relay-solana "$PK"

echo "=== Done ==="
