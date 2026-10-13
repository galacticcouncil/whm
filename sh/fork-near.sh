#!/usr/bin/env bash
set -euo pipefail

# Spawn a local NEAR sandbox set up for near-ntt: the mainnet Wormhole core (booted on a dev
# guardian) and the mainnet wrap.near code, plus alice.test.near with 10 wNEAR.
#
# RPC: http://127.0.0.1:3030
# Home: crates/near/.sandbox (reset on every run)
#
# Requires the near-sandbox binary — set NEAR_SANDBOX_BIN, or run `pnpm test:sandbox` in
# crates/near once (near-workspaces downloads it).

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/crates/near/scripts/ntt-manager/runSandbox.ts"

echo "🔱 Forking near..."
echo "RPC: http://127.0.0.1:3030"
echo

"$TSX" "$RUNNER"
