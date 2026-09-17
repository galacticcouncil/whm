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

echo "=== Hydration Managed Oracles ==="
echo ""
check "PRIME"   "0x6e3E9403Cf486af5f2cE0A6b3d7a23ee0e6BC84e"
check "SOL"     "0xf832dc4268Ac29C9C0B16De1784382BEee801Fb8"
check "JitoSOL" "0xFcEd56d89A63120e7bE512224CE3d08373cF6CeE"
check "wstETH"  "0x35bEe05585c74462c9C40473B2E744537424C9FD"
check "apyUsd"  "0x6a738A5B191FC7D68477C6e6480726bAAfB944Bd"

echo ""
echo "=== Hydration Checked Oracles ==="
echo ""
check "PRIME"   "0x09221057Cf7E75953D199FB319E606972A6A82Cd"
check "JitoSOL" "0x64b7BbAC63E5aDcA0ec35C4AEBf9937Fc1d79C1D"
check "wstETH"  "0xBE6B91cCb5b41e68426Dcb584830A360093c2775"