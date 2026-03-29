#!/usr/bin/env bash
set -euo pipefail

RPC=https://rpc.hydradx.cloud/evm
CHAIN_ID=222222
PORT=8547

echo "🔱 Forking hydration..."
echo "RPC: $RPC"
echo "Chain ID: $CHAIN_ID"
echo

anvil \
  --fork-url $RPC \
  --chain-id $CHAIN_ID \
  --port $PORT