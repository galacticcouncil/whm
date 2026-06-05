#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-nintent-ethereum.sh <env>
#
# Deploy the IntentEmitter (NEAR Intents) UUPS proxy on Hydration.
#
# Arguments:
#   <env>   Environment context: prod | fork
#
# Required env vars (set in shell or root .env):
#   PK_EMITTER  Hydration deployer (0x...)
#
# Example:
#   PK_EMITTER=0x... ./sh/migrate-nintent-ethereum.sh fork

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
  # Default anvil dev account #0
  PK_EMITTER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
fi

if [ "$ENV" = "lark" ]; then
  # Lark deployer account: 0x222222ff7Be76052e023Ec1a306fCca8F9659D80
  PK_EMITTER=0x42d8d953e4f9246093a33e9ca6daa078501012f784adfe4bbed57918ff13be14
fi

PK_EMITTER=${PK_EMITTER:?Missing PK_EMITTER}

export PK_EMITTER

"$TSX" "$RUNNER" --migration nintent-ethereum --env "$ENV"
