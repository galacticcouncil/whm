#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-insta-bridge.sh <env>
#
# Runs the full insta-bridge migration sequence in order:
#   1. insta-bridge-proxy  — up to and including set-xcm-transactor
#   2. insta-transfer      — full migration
#   3. insta-bridge        — full migration
#   4. insta-bridge-proxy  — resumes from set-emitter to completion
#
# Arguments:
#   <env>   Environment name (e.g. base, fork, moonbeam). Must match an env
#           file in migrations/envs/<migration>.<env>.env
#
# Required environment variables:
#   PK_IPROXY       Private key for the insta-bridge-proxy deployer (Moonbeam)
#   PK_ITRANSFER    Private key for the insta-transfer deployer (Hydration)
#   PK_IBRIDGE      Private key for the insta-bridge deployer (<env> chain e.g. Base)
#
# Example:
#   PK_PROXY=0x... PK_ITRANSFER=0x... PK_IBRIDGE=0x... \
#     ./migrate-insta-bridge.sh base

ENV=${1:?Usage: migrate-insta-bridge.sh <env>}

PK_IPROXY=${PK_IPROXY:?Missing PK_IPROXY}
PK_ITRANSFER=${PK_ITRANSFER:?Missing PK_ITRANSFER}
PK_IBRIDGE=${PK_IBRIDGE:?Missing PK_IBRIDGE}

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"

run() {
  local migration=$1
  local pk=$2
  shift 2
  npx tsx "$MIGRATIONS_DIR/run.ts" --migration "$migration" --env "$ENV" --pk "$pk" "$@"
}

echo "=== 1/4: insta-bridge-proxy (up to set-xcm-transactor) ==="
run insta-bridge-proxy "$PK_IPROXY" --to set-xcm-transactor

echo "=== 2/4: insta-transfer ==="
run insta-transfer "$PK_ITRANSFER"

echo "=== 3/4: insta-bridge ==="
run insta-bridge "$PK_IBRIDGE"

echo "=== 4/4: insta-bridge-proxy (resume from set-emitter) ==="
run insta-bridge-proxy "$PK_IPROXY"

echo "=== Done ==="
