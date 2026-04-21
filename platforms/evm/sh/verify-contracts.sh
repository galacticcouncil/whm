#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-contracts.sh
#
# Verifies all deployed contracts on Base, Moonbeam, and Hydration.
#
# Required environment variables:
#   ETHERSCAN_KEY  — API key from https://etherscan.io/myapikey (V2 unified key)
#   SUBSCAN_KEY    — API key from https://support.subscan.io/

ETHERSCAN_KEY=${ETHERSCAN_KEY:?Missing ETHERSCAN_KEY}
SUBSCAN_KEY=${SUBSCAN_KEY:?Missing SUBSCAN_KEY}

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS_DIR="$SCRIPT_DIR/contracts"
PROXY_SOL="lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"

BASE_RPC="https://mainnet.base.org"
MOON_RPC="https://rpc.api.moonbeam.network"
HYDRA_RPC="https://rpc.hydradx.cloud"

V2_API="https://api.etherscan.io/v2/api"
SUBSCAN_API="https://hydration.api.subscan.io/api/scan/evm/contract/verifysource"

cd "$CONTRACTS_DIR"

is_verified_etherscan() {
  local chainid=$1 address=$2
  local resp
  resp=$(curl -sf "${V2_API}?chainid=${chainid}&module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_KEY}" 2>/dev/null || echo '{"status":"0"}')
  [ "$(echo "$resp" | jq -r '.status')" = "1" ]
}

verify_etherscan() {
  local label=$1 chainid=$2 chain=$3 address=$4 contract=$5 rpc=$6
  shift 6

  echo "--- $label ($address) ---"

  if is_verified_etherscan "$chainid" "$address"; then
    echo "  ✓ already verified, skipping"
    echo ""
    return
  fi

  forge verify-contract "$address" "$contract" \
    --verifier etherscan \
    --verifier-url "${V2_API}?chainid=${chainid}" \
    --etherscan-api-key "$ETHERSCAN_KEY" \
    --rpc-url "$rpc" \
    --chain "$chain" \
    --watch \
    "$@" || echo "  ⚠ verification failed"
  echo ""
}

verify_subscan() {
  local label=$1 address=$2 contract=$3
  shift 3

  echo "--- $label ($address) ---"

  # Pipe forge JSON directly to python to avoid shell escaping issues
  local resp
  resp=$(forge verify-contract "$address" "$contract" \
    --chain 222222 --show-standard-json-input 2>/dev/null | \
    python3 -c "
import json, sys
source = json.load(sys.stdin)
payload = {
    'module': 'contract',
    'action': 'verifysourcecode',
    'contractaddress': '$address',
    'sourceCode': json.dumps(source),
    'codeformat': 'solidity-standard-json-input',
    'contractname': '$contract',
    'compilerversion': 'v0.8.34+commit.80d5c536'
}
sys.stdout.buffer.write(json.dumps(payload).encode())
" | curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $SUBSCAN_KEY" \
    -d @- \
    "$SUBSCAN_API" 2>&1)

  echo "  Response: $resp"

  local status
  status=$(echo "$resp" | jq -r '.status // .code // "unknown"' 2>/dev/null)
  local msg
  msg=$(echo "$resp" | jq -r '.result // .message // "unknown"' 2>/dev/null)

  if [ "$status" = "1" ] || echo "$msg" | grep -qi "success\|verified\|guid"; then
    echo "  ✓ submitted: $msg"
  else
    echo "  ⚠ failed ($status): $msg"
  fi
  echo ""
}

# Helper: encode ERC1967Proxy constructor args
proxy_args() {
  local impl=$1 init_calldata=$2
  cast abi-encode "constructor(address,bytes)" "$impl" "$init_calldata"
}

# ─── BASE (chainid 8453) ──────────────────────────────────────

echo "=== BASE ==="

verify_etherscan "Basejump impl" \
  8453 base 0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  src/Basejump.sol:Basejump \
  "$BASE_RPC"

BASEJUMP_BASE_PROXY_ARGS=$(proxy_args \
  0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  "$(cast calldata 'initialize(address,address)' \
    0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6 \
    0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627)")

verify_etherscan "Basejump proxy" \
  8453 base 0xf5b9334e44f800382cb47fc19669401d694e529b \
  "$PROXY_SOL" \
  "$BASE_RPC" \
  --constructor-args "$BASEJUMP_BASE_PROXY_ARGS"

# ─── MOONBEAM (chainid 1284) ──────────────────────────────────

echo "=== MOONBEAM ==="

verify_etherscan "BasejumpProxy impl" \
  1284 moonbeam 0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  src/BasejumpProxy.sol:BasejumpProxy \
  "$MOON_RPC"

BASEJUMP_MOON_PROXY_ARGS=$(proxy_args \
  0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  "$(cast calldata 'initialize(address,address)' \
    0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3 \
    0xB1731c586ca89a23809861c6103F0b96B3F57D92)")

verify_etherscan "BasejumpProxy proxy" \
  1284 moonbeam 0xf5b9334e44f800382cb47fc19669401d694e529b \
  "$PROXY_SOL" \
  "$MOON_RPC" \
  --constructor-args "$BASEJUMP_MOON_PROXY_ARGS"

XCM_TRANSACTOR_ARGS=$(cast abi-encode \
  "constructor(uint32,uint32,uint8,uint8,address)" \
  2034 2004 90 1 0xFFFfFfff345Dc44DDAE98Df024Eb494321E73FcC)

verify_etherscan "XcmTransactor impl" \
  1284 moonbeam 0x96501ea4984d3ecd028146a628af1a6a929b2a17 \
  src/XcmTransactor.sol:XcmTransactor \
  "$MOON_RPC" \
  --constructor-args "$XCM_TRANSACTOR_ARGS"

XCM_TRANSACTOR_PROXY_ARGS=$(proxy_args \
  0x96501ea4984d3ecd028146a628af1a6a929b2a17 \
  "$(cast calldata 'initialize()')")

verify_etherscan "XcmTransactor proxy" \
  1284 moonbeam 0xdd11a22a428fd884a9f2feb3028cba541fc4ab87 \
  "$PROXY_SOL" \
  "$MOON_RPC" \
  --constructor-args "$XCM_TRANSACTOR_PROXY_ARGS"

# ─── HYDRATION (Subscan — etherscan-compatible API) ────────────

echo "=== HYDRATION ==="

verify_subscan "BasejumpLanding impl" \
  0x4ea0d58ab1551b5794bca0d2327dbedc85bae31f \
  src/BasejumpLanding.sol:BasejumpLanding

LANDING_PROXY_ARGS=$(proxy_args \
  0x4ea0d58ab1551b5794bca0d2327dbedc85bae31f \
  "$(cast calldata 'initialize()')")

verify_subscan "BasejumpLanding proxy" \
  0x70e9b12c3b19cb5f0e59984a5866278ab69df976 \
  "$PROXY_SOL" \
  --constructor-args "$LANDING_PROXY_ARGS"

echo "=== Done ==="
