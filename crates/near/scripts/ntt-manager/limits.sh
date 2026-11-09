#!/usr/bin/env bash
# The 24h NTT rate limits on the NEAR hub contracts — ntt-zec / ntt-near.hydration-whm.near — set
# through the DAO that owns them. One proposal per token carries both calls, so the two limits
# change together or not at all.
#
# Usage:  ./limits.sh status  <zec|near>
#         ./limits.sh propose <zec|near> <outbound> <inbound> <signer>
#         ./limits.sh vote    <proposal-id> <signer>
#
# Amounts are whole tokens, decimals allowed:
#   outbound  NEAR -> Hydration           set_outbound_limit
#   inbound   Hydration (73) -> NEAR      set_inbound_limit(73)
#
# The Hydration side is hydration-ntt's, raised to match:
#   Hydration inbound(15) == NEAR outbound, Hydration outbound == NEAR inbound(73).
#
# Needs near-cli-rs (`near`), signs with a Ledger over USB; prints what it submits and asks first.
# NEAR_RPC overrides the RPC the views read; LEDGER_HD_PATH the Ledger key's path.
#
# Example:
#   crates/near/scripts/ntt-manager/limits.sh status zec
#   crates/near/scripts/ntt-manager/limits.sh propose zec 50 50 palo-gc.near
#   crates/near/scripts/ntt-manager/limits.sh vote 12 palo-gc.near

set -euo pipefail

DAO=hydration.sputnik-dao.near
CHAIN_HYDRATION=73
NEAR_RPC="${NEAR_RPC:-https://rpc.mainnet.near.org}"
# Each action is a single storage write; the vote that passes runs both.
ACTION_GAS=20000000000000
PROPOSE_GAS='100.0 Tgas'
VOTE_GAS='150.0 Tgas'

usage() {
  sed -n '6,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# Token config: contract, decimals, symbol.
token() {
  case "$1" in
    zec) ACCOUNT=ntt-zec.hydration-whm.near; DECIMALS=8; SYM=ZEC ;;
    near) ACCOUNT=ntt-near.hydration-whm.near; DECIMALS=24; SYM=NEAR ;;
    *) echo "ERROR: unknown token '$1' — zec or near" >&2; exit 1 ;;
  esac
}

# A view call's JSON result.
view() {
  local args; args=$(printf '%s' "${3:-{\}}" | base64 | tr -d '\n')
  curl -sf "$NEAR_RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args\"}}" |
    python3 -c 'import json,sys; r=json.load(sys.stdin); r=r.get("result") or sys.exit("view failed: "+json.dumps(r.get("error"))); print(bytes(r["result"]).decode())'
}

# Whole tokens -> raw integer, exact; refuses anything finer than the token's decimals.
raw() {
  python3 - "$1" "$2" <<'PY'
import sys
from decimal import Decimal, InvalidOperation
try:
    v = Decimal(sys.argv[1])
except InvalidOperation:
    sys.exit(f"ERROR: not an amount: {sys.argv[1]}")
r = v * (Decimal(10) ** int(sys.argv[2]))
if v <= 0 or r != r.to_integral_value():
    sys.exit(f"ERROR: {sys.argv[1]} is not a positive amount at {sys.argv[2]} decimals")
print(int(r))
PY
}

# Raw integer -> whole tokens, for display.
whole() {
  python3 -c 'import sys; from decimal import Decimal; print(format(Decimal(sys.argv[1]).scaleb(-int(sys.argv[2])).normalize(), "f"))' "$1" "$2"
}

confirm() {
  read -r -p "$1 [y/N] " a
  [ "$a" = y ] || [ "$a" = Y ] || { echo "aborted"; exit 1; }
}

# The near-cli-rs signing tail: Ledger over USB, then send.
ledger() {
  if [ -n "${LEDGER_HD_PATH:-}" ]; then
    echo sign-with-ledger --seed-phrase-hd-path "$LEDGER_HD_PATH" usb send
  else
    echo sign-with-ledger usb send
  fi
}

cmd_status() {
  token "${1:?$(usage)}"
  local out in
  out=$(view "$ACCOUNT" outbound_capacity | tr -d '"')
  in=$(view "$ACCOUNT" inbound_capacity "{\"chain_id\":$CHAIN_HYDRATION}" | tr -d '"')
  echo "$ACCOUNT ($SYM, ${DECIMALS}dp)"
  echo "  owner                  $(view "$ACCOUNT" owner)"
  echo "  pending owner          $(view "$ACCOUNT" pending_owner)"
  echo "  paused                 $(view "$ACCOUNT" is_paused)"
  echo "  outbound capacity      $(whole "$out" "$DECIMALS") $SYM   (refills to the limit over 24h)"
  echo "  inbound(73) capacity   $(whole "$in" "$DECIMALS") $SYM"
}

cmd_propose() {
  [ $# -eq 4 ] || usage
  token "$1"
  local signer=$4 out in owner
  out=$(raw "$2" "$DECIMALS")
  in=$(raw "$3" "$DECIMALS")

  owner=$(view "$ACCOUNT" owner | tr -d '"')
  [ "$owner" = "$DAO" ] || { echo "ERROR: $ACCOUNT is owned by $owner, not $DAO"; exit 1; }

  local args
  args=$(python3 - "$ACCOUNT" "$SYM" "$2" "$3" "$out" "$in" "$CHAIN_HYDRATION" "$ACTION_GAS" <<'PY'
import base64, json, sys
account, sym, out_h, in_h, out_raw, in_raw, chain, gas = sys.argv[1:]
b64 = lambda o: base64.b64encode(json.dumps(o, separators=(",", ":")).encode()).decode()
# Both setters are owner-only and assert exactly 1 yocto.
action = lambda method, args: {"method_name": method, "args": b64(args), "deposit": "1", "gas": gas}
print(json.dumps({"proposal": {
    "description": f"{account}: {sym} NTT limits - outbound {out_h} {sym}, inbound from Hydration ({chain}) {in_h} {sym} per 24h",
    "kind": {"FunctionCall": {"receiver_id": account, "actions": [
        action("set_outbound_limit", {"limit": out_raw}),
        action("set_inbound_limit", {"chain_id": int(chain), "limit": in_raw}),
    ]}},
}}, separators=(",", ":")))
PY
)

  cmd_status "$1"
  echo
  echo "Proposal to $DAO, signed by $signer:"
  echo "  $ACCOUNT.set_outbound_limit($out)   $2 $SYM"
  echo "  $ACCOUNT.set_inbound_limit($CHAIN_HYDRATION, $in)   $3 $SYM"
  echo "  args: $args"
  echo
  echo "Hydration must match (hydration-ntt): inbound(15) = $2 $SYM, outbound = $3 $SYM"
  confirm "Submit the proposal?"

  # shellcheck disable=SC2046
  near contract call-function as-transaction "$DAO" add_proposal json-args "$args" \
    prepaid-gas "$PROPOSE_GAS" attached-deposit '0 NEAR' \
    sign-as "$signer" network-config mainnet $(ledger)

  local next; next=$(view "$DAO" get_last_proposal_id)
  echo
  echo "Proposal id: $((next - 1)) — each council member approves it with:"
  echo "  crates/near/scripts/ntt-manager/limits.sh vote $((next - 1)) <signer>"
}

cmd_vote() {
  [ $# -eq 2 ] || usage
  local id=$1 signer=$2 proposal args
  proposal=$(view "$DAO" get_proposal "{\"id\":$id}")
  # The vote restates the proposal's kind; the DAO refuses one that differs from what is stored.
  args=$(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(json.dumps({"id":int(sys.argv[2]),"action":"VoteApprove","proposal":p["kind"]},separators=(",",":")))' "$proposal" "$id")

  echo "Proposal $id:"
  python3 -c '
import base64, json, sys
p = json.loads(sys.argv[1])
fc = p["kind"].get("FunctionCall", {})
print("  status      ", p["status"])
print("  description ", p["description"])
for a in fc.get("actions", []):
    print("  call        ", fc["receiver_id"] + "." + a["method_name"], base64.b64decode(a["args"]).decode())
print("  votes       ", json.dumps(p.get("votes", {})))' "$proposal"
  confirm "Approve it as $signer?"

  # shellcheck disable=SC2046
  near contract call-function as-transaction "$DAO" act_proposal json-args "$args" \
    prepaid-gas "$VOTE_GAS" attached-deposit '0 NEAR' \
    sign-as "$signer" network-config mainnet $(ledger)
}

case "${1:-}" in
  status|propose|vote) "cmd_$1" "${@:2}" ;;
  *) usage ;;
esac
