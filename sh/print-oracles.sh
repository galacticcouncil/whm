#!/usr/bin/env bash
set -euo pipefail

RPC="https://rpc.hydradx.cloud/evm"

check() {
  local name=$1 addr=$2

  local result
  result=$(cast call -r "$RPC" "$addr" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)')

  # Strip Foundry formatting like "102962134 [1.029e8]" → "102962134"
  local round price updated
  round=$(echo "$result" | sed -n '1p' | awk '{print $1}')
  price=$(echo "$result" | sed -n '2p' | awk '{print $1}')
  updated=$(echo "$result" | sed -n '4p' | awk '{print $1}')

  local ts_human
  ts_human=$(TZ=UTC date -r "$updated" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || TZ=UTC date -d "@$updated" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || echo "$updated")

  printf "%-10s  price: %-12s  updated: %s  round: %s\n" \
    "$name" "$price" "$ts_human" "$round"
}

echo "=== Hydration Oracles ==="
echo ""
check "PRIME"   "0x82022F77ae239Ad99bB1F2aC0d8DaFF6Cc976a07"
check "SOL"     "0x3928A0C729819B3999006D9fd0eB8e2562006384"
check "JitoSOL" "0x58469121FeD2F06183e7cF741a1219b6A20923eE"
