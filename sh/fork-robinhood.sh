#!/usr/bin/env bash
set -euo pipefail

RPC=https://rpc.mainnet.chain.robinhood.com
CHAIN_ID=4663
PORT=8551

echo "🔱 Forking robinhood..."
echo "RPC: $RPC"
echo "Chain ID: $CHAIN_ID"
echo

anvil \
  --fork-url $RPC \
  --chain-id $CHAIN_ID \
  --port $PORT
