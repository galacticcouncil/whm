#!/usr/bin/env bash
set -euo pipefail

RPC=https://mainnet.base.org
CHAIN_ID=8453

echo "🔱 Forking base..."
echo "RPC: $RPC"
echo "Chain ID: $CHAIN_ID"
echo

anvil \
  --fork-url $RPC \
  --chain-id $CHAIN_ID