#!/usr/bin/env bash
set -euo pipefail

RPC=https://ethereum-rpc.publicnode.com
CHAIN_ID=1
PORT=8550

echo "🔱 Forking ethereum..."
echo "RPC: $RPC"
echo "Chain ID: $CHAIN_ID"
echo

anvil \
  --fork-url $RPC \
  --chain-id $CHAIN_ID \
  --port $PORT
