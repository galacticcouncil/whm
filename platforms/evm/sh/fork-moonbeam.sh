#!/usr/bin/env bash
set -euo pipefail

RPC=https://rpc.api.moonbeam.network
CHAIN_ID=1284
PORT=8545

echo "🔱 Forking moonbean..."
echo "RPC: $RPC"
echo "Chain ID: $CHAIN_ID"
echo

anvil \
  --fork-url $RPC \
  --chain-id $CHAIN_ID \
  --port $PORT