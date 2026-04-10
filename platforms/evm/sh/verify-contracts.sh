#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-contracts.sh
#
# Verifies all deployed contracts on Base, Moonbeam, and Hydration.
#
# Required environment variables:
#   ETHERSCAN_KEY  — API key from https://etherscan.io/myapikey (V2 unified key)

ETHERSCAN_KEY=${ETHERSCAN_KEY:?Missing ETHERSCAN_KEY}

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS_DIR="$SCRIPT_DIR/contracts"
PROXY_SOL="lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"

BASE_RPC="https://mainnet.base.org"
MOON_RPC="https://rpc.api.moonbeam.network"
HYDRA_RPC="https://rpc.hydradx.cloud"

# Etherscan V2 unified API
V2_API="https://api.etherscan.io/v2/api"

cd "$CONTRACTS_DIR"

is_verified() {
  local chainid=$1 address=$2
  local resp
  resp=$(curl -sf "${V2_API}?chainid=${chainid}&module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_KEY}" 2>/dev/null || echo '{"status":"0"}')
  local result
  result=$(echo "$resp" | jq -r '.status')
  [ "$result" = "1" ]
}

verify() {
  local label=$1 chainid=$2 chain=$3 address=$4 contract=$5 rpc=$6
  shift 6

  echo "--- $label ($address) ---"

  if is_verified "$chainid" "$address"; then
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

# Helper: encode ERC1967Proxy constructor args
# ERC1967Proxy(address implementation, bytes memory _data)
proxy_args() {
  local impl=$1 init_calldata=$2
  cast abi-encode "constructor(address,bytes)" "$impl" "$init_calldata"
}

# ─── BASE (chainid 8453) ──────────────────────────────────────

echo "=== BASE ==="

# Basejump impl (no constructor args)
verify "Basejump impl" \
  8453 base 0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  src/Basejump.sol:Basejump \
  "$BASE_RPC"

# Basejump proxy: initialize(wormhole, tokenBridge)
BASEJUMP_BASE_PROXY_ARGS=$(proxy_args \
  0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  "$(cast calldata 'initialize(address,address)' \
    0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6 \
    0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627)")

verify "Basejump proxy" \
  8453 base 0xf5b9334e44f800382cb47fc19669401d694e529b \
  "$PROXY_SOL" \
  "$BASE_RPC" \
  --constructor-args "$BASEJUMP_BASE_PROXY_ARGS"

# ─── MOONBEAM (chainid 1284) ──────────────────────────────────

echo "=== MOONBEAM ==="

# BasejumpProxy impl (no constructor args)
verify "BasejumpProxy impl" \
  1284 moonbeam 0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  src/BasejumpProxy.sol:BasejumpProxy \
  "$MOON_RPC"

# BasejumpProxy proxy: initialize(wormhole, tokenBridge)
BASEJUMP_MOON_PROXY_ARGS=$(proxy_args \
  0xedece54767182abc1b04fe699a96cf7e97a3ccf2 \
  "$(cast calldata 'initialize(address,address)' \
    0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3 \
    0xB1731c586ca89a23809861c6103F0b96B3F57D92)")

verify "BasejumpProxy proxy" \
  1284 moonbeam 0xf5b9334e44f800382cb47fc19669401d694e529b \
  "$PROXY_SOL" \
  "$MOON_RPC" \
  --constructor-args "$BASEJUMP_MOON_PROXY_ARGS"

# XcmTransactor impl: constructor(destParaId, sourceParaId, evmPalletIdx, evmCallIdx, feeAsset)
XCM_TRANSACTOR_ARGS=$(cast abi-encode \
  "constructor(uint32,uint32,uint8,uint8,address)" \
  2034 2004 90 1 0xFFFfFfff345Dc44DDAE98Df024Eb494321E73FcC)

verify "XcmTransactor impl" \
  1284 moonbeam 0x96501ea4984d3ecd028146a628af1a6a929b2a17 \
  src/XcmTransactor.sol:XcmTransactor \
  "$MOON_RPC" \
  --constructor-args "$XCM_TRANSACTOR_ARGS"

# XcmTransactor proxy: initialize()
XCM_TRANSACTOR_PROXY_ARGS=$(proxy_args \
  0x96501ea4984d3ecd028146a628af1a6a929b2a17 \
  "$(cast calldata 'initialize()')")

verify "XcmTransactor proxy" \
  1284 moonbeam 0xdd11a22a428fd884a9f2feb3028cba541fc4ab87 \
  "$PROXY_SOL" \
  "$MOON_RPC" \
  --constructor-args "$XCM_TRANSACTOR_PROXY_ARGS"

# ─── HYDRATION ─────────────────────────────────────────────────

echo "=== HYDRATION (Subscan) ==="
echo ""
echo "Sourcify does not support Hydration (chain 222222)."
echo "Generating Standard JSON Input files for manual upload at:"
echo "  https://hydration.subscan.io/verify_contract"
echo ""

VERIFY_DIR="$SCRIPT_DIR/verify-hydration"
mkdir -p "$VERIFY_DIR"

echo "--- BasejumpLanding impl (0x4ea0d58ab1551b5794bca0d2327dbedc85bae31f) ---"
forge verify-contract 0x4ea0d58ab1551b5794bca0d2327dbedc85bae31f \
  src/BasejumpLanding.sol:BasejumpLanding \
  --show-standard-json-input > "$VERIFY_DIR/BasejumpLanding-impl.json"
echo "  → $VERIFY_DIR/BasejumpLanding-impl.json"
echo ""

echo "--- BasejumpLanding proxy (0x70e9b12c3b19cb5f0e59984a5866278ab69df976) ---"
forge verify-contract 0x70e9b12c3b19cb5f0e59984a5866278ab69df976 \
  "$PROXY_SOL" \
  --show-standard-json-input > "$VERIFY_DIR/BasejumpLanding-proxy.json"
echo "  → $VERIFY_DIR/BasejumpLanding-proxy.json"
echo ""
echo "Upload these files at https://hydration.subscan.io/verify_contract"
echo "Select compiler type: Solidity (Standard-JSON-Input), version: v0.8.34"
echo ""

echo "=== Done ==="
