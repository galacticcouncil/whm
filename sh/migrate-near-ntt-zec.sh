#!/usr/bin/env bash
set -euo pipefail

# Usage: migrate-near-ntt-zec.sh <env> [runner flags...]
#
# Run the near-ntt-zec migration — deploy the NEAR NTT hub contract and peer it with the Hydration
# NttManager + WormholeTransceiver. NEAR side only: the Hydration side is hydration-ntt's.
#
# Arguments:
#   <env>   Environment context: prod (NEAR has no local fork)
#
# Required env vars (set in shell or root .env):
#   PK_NEAR       NEAR deployer secret key (ed25519:...) for NEAR_ACCOUNT
#
# Example:
#   PK_NEAR=ed25519:... ./sh/migrate-near-ntt-zec.sh prod

ENV=${1:?Usage: migrate-near-ntt-zec.sh <env (prod)>}
shift

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/migrations/run.ts"

# Load root .env if present (for PK overrides etc.)
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

PK_NEAR=${PK_NEAR:?Missing PK_NEAR}

export PK_NEAR

# NTT_WASM in the env file is relative to the repo root.
cd "$ROOT_DIR"
"$TSX" "$RUNNER" --migration near-ntt-zec --env "$ENV" "$@"
