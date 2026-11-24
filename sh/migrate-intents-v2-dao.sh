#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-intents-v2-dao.sh <env>
#
# Hand intents v2 over to governance, once the canary has passed:
#   Ethereum  : IntentForwarder  → the Technical Committee Safe
#   Hydration : IntentDispatcher → the Emergency Admin
#   NEAR      : IntentRouter     → proposed to the DAO, the account's keys deleted, the DAO accepts
#
# The last step stops until the DAO has accepted — re-run to finish.
#
# Requires:
#   PK           — Hydration deployer, the dispatcher's owner
#   PK_ETHEREUM  — Ethereum deployer, the forwarder's owner
#   PK_NEAR      — NEAR deployer for NEAR_ACCOUNT, `ed25519:…`, the router's owner

ENV=${1:?Usage: migrate-intents-v2-dao.sh <env (prod|fork)>}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [ "$ENV" = "fork" ]; then
  # Default anvil dev account #0 on the EVM forks; NEAR has no fork and needs its own key.
  ANVIL_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  PK=${PK:-$ANVIL_PK}
  PK_ETHEREUM=${PK_ETHEREUM:-$ANVIL_PK}
fi

PK=${PK:?Missing PK}
PK_ETHEREUM=${PK_ETHEREUM:?Missing PK_ETHEREUM}
PK_NEAR=${PK_NEAR:?Missing PK_NEAR}

export PK PK_ETHEREUM PK_NEAR

# ROUTER_WASM in the env file is relative to the repo root.
cd "$ROOT_DIR"
"$TSX" "$RUNNER" --migration intents-v2-dao --env "$ENV"
