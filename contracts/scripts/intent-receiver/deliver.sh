#!/usr/bin/env bash
# Deliver a stuck intent order by hand. Set the two Wormhole sequences below — the NTT settlement
# (from the transceiver) and its forwarding instruction (from the emitter), both on Hydration
# (chain 73). They pair on the NTT manager sequence, which the preflight prints.
set -euo pipefail

: "${PK:?set PK to the Ethereum signing key, 0x-prefixed}"

RECEIVER=0x2173F6ecE25768e7EFc5199f70f8783d88Ba63c8
TRANSCEIVER=0000000000000000000000008acce9ca511d5d7213f8c3f813b8916087cd00ae
EMITTER=00000000000000000000000098f1ebc9dcc8ab7ba54d83c98500e9e313f793f2
SETTLEMENT_SEQ=${SETTLEMENT_SEQ:-32}      # per order
INSTRUCTION_SEQ=${INSTRUCTION_SEQ:-9}     # per order
QUOTER_URL=${QUOTER_URL:-https://quoter-intent.play.hydration.cloud}
MARGIN_BPS=${MARGIN_BPS:-0}               # 0 = the modelled cost, no headroom

api() { curl -sS -m 30 "https://api.wormholescan.io/api/v1/vaas/73/$1/$2" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["vaa"])'; }

quote() { curl -sS -m 30 "$QUOTER_URL/relay-fee?chain=ethereum&marginBps=$MARGIN_BPS" \
          | python3 -c 'import json,sys; print(json.load(sys.stdin)["feeRequested"])'; }

# The order's own maxRelayFee, read from the instruction rather than hand-maintained. Its payload is
# abi.encode(sequence, depositAddress, amount, maxRelayFee) and sits at the end of the VAA, so the
# ceiling is the last 32 bytes.
ceiling() { python3 -c 'import base64,sys; print(int.from_bytes(base64.b64decode(sys.argv[1])[-32:],"big"))' "$1"; }

echo "fetching VAAs..."
NTT_VAA=$(api "$TRANSCEIVER" "$SETTLEMENT_SEQ")
INSTRUCTION_VAA=$(api "$EMITTER" "$INSTRUCTION_SEQ")
echo "  settlement  ${#NTT_VAA} chars"
echo "  instruction ${#INSTRUCTION_VAA} chars"

CEILING=$(ceiling "$INSTRUCTION_VAA")
echo "  ceiling     $CEILING wei"

# What the delivery actually costs, rather than the ceiling. FEE_REQUESTED overrides; without it a
# dead quoter stops the script rather than silently falling back to claiming the maximum.
if [[ -n "${FEE_REQUESTED:-}" ]]; then
  FEE=$FEE_REQUESTED
  echo "fee: $FEE (FEE_REQUESTED override)"
else
  echo "quoting relay fee..."
  FEE=$(quote) || { echo "quoter unreachable — set FEE_REQUESTED to deliver anyway" >&2; exit 1; }
  echo "  quoted $FEE wei (marginBps=$MARGIN_BPS)"
fi

# processOrder reverts FeeExceedsCeiling above maxRelayFee, so clamp rather than fail on-chain. The
# shortfall is real money out of the caller's pocket — an order whose ceiling was sized when gas was
# cheaper can only be unstuck at a loss, so say so rather than swallow it.
if (( FEE > CEILING )); then
  echo "  ⚠ ceiling is $CEILING — delivering at a loss of $((FEE - CEILING)) wei" >&2
  FEE=$CEILING
fi

cd "$(git rev-parse --show-toplevel)/contracts"
cp -f .env.ethereum .env

npx tsx scripts/intent-receiver/processOrder.ts \
  --pk "$PK" \
  --address "$RECEIVER" \
  --nttVaa "$NTT_VAA" \
  --instructionVaa "$INSTRUCTION_VAA" \
  --feeRequested "$FEE"

