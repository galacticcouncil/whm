#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-oracle-relay.sh
#
# Verifies oracle-relay contracts on Moonbeam (XcmTransactor + MessageDispatcher).
#
# Required environment variables:
#   ETHERSCAN_KEY  — API key from https://etherscan.io/myapikey (V2 unified key)

ETHERSCAN_KEY=${ETHERSCAN_KEY:?Missing ETHERSCAN_KEY}

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS_DIR="$SCRIPT_DIR/contracts"
PROXY_SOL="dependencies/openzeppelin-contracts-5.5.0/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"

MOON_RPC="https://rpc.api.moonbeam.network"
V2_API="https://api.etherscan.io/v2/api"

SOLC_VERSION="v0.8.33+commit.64118f21"
WORMHOLE_CORE_MOON="0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3"

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
    --compiler-version "$SOLC_VERSION" \
    --watch \
    "$@" || echo "  ⚠ verification failed"
  echo ""
}

# Helper: encode ERC1967Proxy constructor args
proxy_args() {
  local impl=$1 init_calldata=$2
  cast abi-encode "constructor(address,bytes)" "$impl" "$init_calldata"
}

# ─── MOONBEAM (chainid 1284) ──────────────────────────────────

echo "=== MOONBEAM ==="

# XcmTransactor impl + proxy
XCM_TRANSACTOR_ARGS=$(cast abi-encode \
  "constructor(uint32,uint32,uint8,uint8,address)" \
  2034 2004 90 1 0xFFFfFfff345Dc44DDAE98Df024Eb494321E73FcC)

verify_etherscan "XcmTransactor impl" \
  1284 moonbeam 0x97cd0d08c376005d09afcc47fa9ce0c384fba406 \
  src/XcmTransactor.sol:XcmTransactor \
  "$MOON_RPC" \
  --constructor-args "$XCM_TRANSACTOR_ARGS"

XCM_TRANSACTOR_PROXY_ARGS=$(proxy_args \
  0x97cd0d08c376005d09afcc47fa9ce0c384fba406 \
  "$(cast calldata 'initialize()')")

verify_etherscan "XcmTransactor proxy" \
  1284 moonbeam 0xd1dc3517732c98502b5c1ba2389aca9e9016d89a \
  "$PROXY_SOL" \
  "$MOON_RPC" \
  --constructor-args "$XCM_TRANSACTOR_PROXY_ARGS"

# MessageDispatcher impl + proxy
verify_etherscan "MessageDispatcher impl" \
  1284 moonbeam 0x9e3bcae89844c3555e61eb4884d7668d9bfd4f2a \
  src/MessageDispatcher.sol:MessageDispatcher \
  "$MOON_RPC"

DISPATCHER_PROXY_ARGS=$(proxy_args \
  0x9e3bcae89844c3555e61eb4884d7668d9bfd4f2a \
  "$(cast calldata 'initialize(address)' "$WORMHOLE_CORE_MOON")")

verify_etherscan "MessageDispatcher proxy" \
  1284 moonbeam 0x32d53dc510a4cdbb4634207e0e1e64b552a1c24c \
  "$PROXY_SOL" \
  "$MOON_RPC" \
  --constructor-args "$DISPATCHER_PROXY_ARGS"

echo "=== Done ==="
