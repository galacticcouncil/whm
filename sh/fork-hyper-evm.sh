#!/usr/bin/env bash
set -euo pipefail

RPC=https://rpc.hyperliquid.xyz/evm
CHAIN_ID=999
PORT=8552

echo "🔱 Forking HyperEVM..."
echo "RPC: $RPC"
echo "Chain ID: $CHAIN_ID"
echo

anvil \
  --fork-url $RPC \
  --chain-id $CHAIN_ID \
  --port $PORT
