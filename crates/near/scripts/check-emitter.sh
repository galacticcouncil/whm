#!/usr/bin/env bash
# Live check that the guardians sign a message from a NEAR emitter other than the Portal token bridge
# (docs/near-ntt/verify.md §3). Uses a plain account — `publish_message` only requires the caller to
# be a registered emitter — so no contract is deployed. The VAA it produces (chain 15, emitter
# sha256(<account>)) is accepted by nothing.
#
# Usage:  ./check-emitter.sh <account>            register, publish, wait for the VAA
#         ./check-emitter.sh <account> --poll     only wait (after a previous run)
#
# Needs near-cli-rs (`near`) with <account>'s key in the keychain. Cost: ~0.002 NEAR + gas.
# SIGN overrides how near-cli-rs signs (default sign-with-keychain; e.g. sign-with-legacy-keychain).

set -euo pipefail

ACCOUNT="${1:?usage: check-emitter.sh <account> [--poll]}"
MODE="${2:-}"
CORE="contract.wormhole_crypto.near"
SIGN="${SIGN:-sign-with-keychain}"
TIMEOUT="${TIMEOUT:-600}"

EMITTER="$(printf '%s' "$ACCOUNT" | shasum -a 256 | cut -d' ' -f1)"
DATA="$(printf 'whm near-ntt emitter check' | xxd -p | tr -d '\n')"

echo "account  $ACCOUNT"
echo "emitter  $EMITTER  (sha256 of the account)"

call() {
  local method="$1" args="$2" deposit="$3"
  near contract call-function as-transaction "$CORE" "$method" json-args "$args" \
    prepaid-gas '30.0 Tgas' attached-deposit "$deposit" \
    sign-as "$ACCOUNT" network-config mainnet "$SIGN" send
}

if [[ "$MODE" != "--poll" ]]; then
  echo "── register_emitter"
  # Panics AlreadyRegistered on a re-run; that is fine.
  call register_emitter "{\"emitter\":\"$ACCOUNT\"}" '0.01 NEAR' || echo "(already registered?)"

  echo "── publish_message"
  call publish_message "{\"data\":\"$DATA\",\"nonce\":0}" '0 NEAR'
fi

# Finds our payload among the emitter's VAAs and decodes the header the guardians signed.
FIND_VAA='
import base64, json, sys
want = sys.argv[1]
try:
    vaas = json.load(sys.stdin).get("data") or []
except ValueError:
    sys.exit(1)
for v in vaas:
    raw = base64.b64decode(v["vaa"])
    sigs = raw[5]
    body = raw[6 + 66 * sigs:]
    chain = int.from_bytes(body[8:10], "big")
    seq = int.from_bytes(body[42:50], "big")
    payload = body[51:].hex()
    if payload == want:
        print("✅ signed:", v["id"])
        print("   guardian set", int.from_bytes(raw[1:5], "big"), "·", sigs, "signatures ·",
              "chain", chain, "· sequence", seq, "·", v.get("timestamp"))
        sys.exit(0)
sys.exit(1)
'

echo "── waiting for a guardian-signed VAA (up to ${TIMEOUT}s)"
deadline=$(( $(date +%s) + TIMEOUT ))
while (( $(date +%s) < deadline )); do
  response="$(curl -s -m 20 "https://api.wormholescan.io/api/v1/vaas/15/$EMITTER?page=0&pageSize=5" || true)"
  if python3 -c "$FIND_VAA" "$DATA" <<<"$response"; then
    exit 0
  fi
  sleep 15
done
echo "no VAA after ${TIMEOUT}s — re-run with --poll to keep waiting" >&2
exit 1
