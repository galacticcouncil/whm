#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-emitter.sh <env>
#
# Runs the emitter migration:
#   1. emitter — deploy message-emitter program, initialize config,
#                register asset price feeds and pool feeds
#
# Arguments:
#   <env>   Environment name (e.g. fork, prod). Must match an env
#           file in migrations/envs/<env>/emitter.env
#
# Required environment variables:
#   PK   Private key for the deployer (BS58-encoded)
#
# Example:
#   PK=your_bs58_private_key ./sh/migrate-emitter.sh prod

ENV=${1:?Usage: migrate-emitter.sh <env>}

PK=${PK:?Missing PK}

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"

run() {
  local migration=$1
  local pk=$2
  shift 2
  npx tsx "$MIGRATIONS_DIR/run.ts" --migration "$migration" --env "$ENV" --pk "$pk" "$@"
}

echo "=== 1/1: emitter ==="
run emitter "$PK"

echo "=== Done ==="
