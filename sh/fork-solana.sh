#!/usr/bin/env bash
set -euo pipefail

# Spawn a local solana-test-validator with mainnet accounts cloned for the
# oracle-emitter integration (Wormhole core + shim, Scope oracle, Jito stake pool).
#
# RPC: http://127.0.0.1:8898
# Ledger: crates/solana/.anchor/test-ledger
#
# Requires `solana-test-validator` on PATH (Solana CLI).

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT_DIR/node_modules/.bin/tsx"
RUNNER="$ROOT_DIR/crates/solana/scripts/oracle-emitter/runValidator.ts"

echo "🔱 Forking solana..."
echo "RPC: http://127.0.0.1:8898"
echo

cd "$ROOT_DIR/crates/solana"
mkdir -p .anchor/test-ledger
"$TSX" "$RUNNER"
