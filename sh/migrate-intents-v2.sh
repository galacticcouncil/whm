#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-intents-v2.sh <env>
#
# Deploy intents v2 on all three chains and wire them to each other.
#   Hydration : IntentDispatcher (UUPS proxy) + NTT manager, forwarder, feeds, minimum
#   Ethereum  : IntentForwarder  (UUPS proxy) + dispatcher pin, relayer
#   NEAR      : IntentRouter — create, deploy and init in one transaction, emitter = the dispatcher
#
# A full run stops at 011 while ETHEREUM_TC_SAFE is empty — run the canary, fill it in, run again.
#
# Requires:
#   PK           — Hydration deployer (EVMAccounts.ContractDeployer)
#   PK_ETHEREUM  — Ethereum deployer
#   PK_NEAR      — NEAR deployer for NEAR_ACCOUNT, `ed25519:…`

ENV=${1:?Usage: migrate-intents-v2.sh <env (prod|fork)>}

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

"$TSX" "$RUNNER" --migration intents-v2 --env "$ENV"
