#!/usr/bin/env bash
set -uo pipefail # no -e: one dead RPC must not kill the whole report

# Usage: print-agents.sh [--discover]
#
# Prints every off-chain agent's bot wallet with its balance and runway, from the known bots in
# sh/agents.json (seconds). --discover rebuilds that file from the last 24h of chain activity
# (~1 min): who triggers each agent's operations, how often, and at what cost. It also runs when
# the file does not exist yet. Re-discover after a key rotation or a cadence change.
#
# Agent actions are permissionless (anyone may send() or receiveMessage()), so the bot is not "a
# caller" but the dominant one: discovery samples each agent's recent direct calls and reports the
# most frequent sender with its share (e.g. 10/10). Keys are never read — signers come from chain
# activity only.
#
# Targets mirror the agents' own routes; keep them in step:
#   agents/broadcaster/src/apps/*/routes.ts   (+ Solana: oracle-emitter program id)
#   agents/relayer/src/apps/*/routes.ts

RPC_HYDRATION="https://rpc.kril.hydration.cloud"
RPC_ETHEREUM="https://ethereum-rpc.publicnode.com"
RPC_ROBINHOOD="https://rpc.mainnet.chain.robinhood.com"
RPC_SOLANA="https://api.mainnet-beta.solana.com"

SAMPLE=10                   # direct calls sampled per agent (sender share + cost per tx); ≤5× txs examined
LOOKBACK_SEC=$((24 * 3600)) # every live bot acts at least daily

# ─── Agents (discovery) ──────────────────────────────────────────

# Every Hydration-side NTT WormholeTransceiver (hydration-ntt ops/tokens/*/deployment.json). Inbound
# redeems call receiveMessage on these directly; the ntt relayer covers the ones in
# agents/relayer/src/apps/ntt/routes.ts — the rest are delivered by others for now, and show up here
# the moment our relayer takes them over.
NTT_TRANSCEIVERS=(
  0xe8660ca48f6f4d98bc48db7dd07c1a8e555801ea # DAI      ← Ethereum
  0x9a8a1ab288f6749ce5626dee1b5d59441bdc187f # WBTC     ← Ethereum
  0x8acce9ca511d5d7213f8c3f813b8916087cd00ae # WETH     ← Ethereum, Robinhood
  0x0d7488b39aa64468a709ec3b3d354defe539ed97 # USDC     ← Ethereum
  0xd2a16b736f32df7c0de72838837656fe0f85ac0f # USDT     ← Ethereum
  0x68ecadd7934d4fcfeabafb209c95d379b96400cb # sUSDS    ← Ethereum
  0x2e84fac378d67dc2e11026fb4919e80263a87375 # EURC     ← Base
  0x2f04acf249091425d51e67eea3c3161cce283202 # SOL      ← Solana
  0xf38d9c3ba6999dc331b32b416083fd7e02d17b04 # jitoSOL  ← Solana
  0x4e7b1e55d2354d4dc6abd876096dc201de0541d1 # PRIME    ← Solana
  0xa224d6f4e0e276b34d91bfe6c3a5fe6838322af7 # SUI      ← Sui
  0xe74f52d5816174d070dc7dc0ef8cc80dd6efc160 # HYPE     ← HyperEVM   (not in relayer routes)
  0x9faf16e590352b61ab5542af2560d54fc62e97aa # SPY      ← Robinhood  (not in relayer routes)
  0xdde268d8b89834f6ef213002651d0586ced646b9 # HDX      ← Robinhood  (locking; not in relayer routes)
  0xe1d75c3c712bc61ebe892312f3455a67ec5d4799 # HOLLAR   ← Robinhood  (locking; not in relayer routes)
)

# Hydration OracleReceivers the oracle relayer delivers into, one per source.
ORACLE_RECEIVERS=(
  0x582e2fac5af62dc024396b5e7f549c72273a69c3 # Solana
  0x6913770466fed4dbc24337cd7f1ae92af4321083 # Ethereum
  0x3b6e3469d8e64e306f235838e0fdf7b4d60a39ce # Robinhood
)

join() { local IFS=,; echo "$*"; }

# service/app|chain|targets — the contracts each agent calls directly.
AGENTS=(
  "broadcaster/oracle-ethereum|ethereum|0xfbf682642a6a28760e717b637f12d014bd5db4b9"   # OracleEmitter
  "broadcaster/oracle-robinhood|robinhood|0x9fbd9f16ce7fa17097e91cc36dc1b7b47adca9de" # OracleEmitter
  "broadcaster/oracle-hydration|hydration|0x3f5cc44141a52529323f9be42dbb98fda7c1d066" # OracleEmitter
  "relayer/ntt|hydration|$(join "${NTT_TRANSCEIVERS[@]}")"
  "relayer/oracle|hydration|$(join "${ORACLE_RECEIVERS[@]}")"
  "relayer/oracle-robinhood|robinhood|0x060f1ef6bb1c7ab31d2bbc3d2ae47e590952b958" # OracleReceiver
  "relayer/intent|ethereum|0x2173f6ece25768e7efc5199f70f8783d88ba63c8"            # IntentReceiver
  "relayer/basejump|hydration|0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a"         # BasejumpReceiver
)
SOLANA_AGENT="broadcaster/oracle-solana"
SOLANA_PROGRAM="2knjvgqZKtU3nV1r9RaLshS9JYWMerZ1ysSFcDyTVsdn" # oracle-emitter

STORE="$(cd "$(dirname "$0")" && pwd)/agents.json" # known bots, written by --discover

# ─── Helpers ─────────────────────────────────────────────────────

chain_rpc() {
  case $1 in
    hydration) echo "$RPC_HYDRATION" ;;
    ethereum) echo "$RPC_ETHEREUM" ;;
    robinhood) echo "$RPC_ROBINHOOD" ;;
  esac
}

# eth_getLogs window each RPC answers inside its query timeout
chain_chunk() {
  case $1 in
    robinhood) echo 100000 ;; # its cap; ~0.1s blocks, so 24h is ~9 calls
    *) echo 10000 ;;
  esac
}

chain_unit() {
  case $1 in
    hydration) echo "WETH" ;;
    solana) echo "SOL" ;;
    *) echo "ETH" ;;
  esac
}

ago() {
  local s=$(($(date +%s) - $1))
  if ((s < 3600)); then echo "$((s / 60))m ago"; elif ((s < 172800)); then echo "$((s / 3600))h ago"; else echo "$((s / 86400))d ago"; fi
}

sol_rpc() {
  curl -s "$RPC_SOLANA" -H 'content-type: application/json' -d "$1"
}

balance_of() { # chain wallet -> decimal balance
  if [ "$1" = "solana" ]; then
    local lamports
    lamports=$(sol_rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$2\"]}" | jq -r '.result.value')
    awk -v l="$lamports" 'BEGIN { printf "%.6f", l / 1e9 }'
  else
    cast balance --ether "$2" --rpc-url "$(chain_rpc "$1")" 2>/dev/null || echo "?"
  fi
}

# base units -> display units (wei 1e18, lamports 1e9)
human() { # chain amount
  local d=1e18
  [ "$1" = "solana" ] && d=1e9
  awk -v a="$2" -v d="$d" 'BEGIN {if (a == "-" || a == "") print "-"; else printf "%.8f", a / d}'
}

# rows "chain|wallet|agent" with >1 agent per (chain, wallet): one key, one nonce
shared_check() {
  local shared
  shared=$(printf '%s\n' "$@" | awk -F'|' '{k=$1"|"tolower($2); a[k]=a[k] ? a[k]", "$3 : $3; c[k]++} END {for (k in c) if (c[k] > 1) {split(k, p, "|"); print "  " p[1] " " p[2] " — " a[k]}}')
  echo ""
  if [ -n "$shared" ]; then
    echo "WARN shared signer on one chain (nonce contention):"
    echo "$shared"
  else
    echo "OK no signer shared by two agents on one chain"
  fi
}

# ─── Report ──────────────────────────────────────────────────────

# report: per agent from the store, then per wallet with live balance and runway.
report() {
  local measured_at
  measured_at=$(jq -r '.[0].discoveredAt' "$STORE")
  echo "=== Agent bots (sh/agents.json, discovered $(ago $((measured_at / 1000)))) ==="
  echo ""
  printf "  %-28s %-10s %-44s %-7s %-7s %-12s %s\n" "AGENT" "CHAIN" "BOT" "SHARE" "TX/24H" "COST/TX" "BURN/24H"
  jq -r '.[] | "\(.agent)|\(.chain)|\(.bot)|\(.share)|\(.tx24h)|\(.costPerTx)|\(.burn24h)"' "$STORE" |
    while IFS='|' read -r agent chain bot share tx24 avg burn; do
      printf "  %-28s %-10s %-44s %-7s %-7s %-12s %s\n" "$agent" "$chain" "$bot" "$share" "$tx24" "$(human "$chain" "$avg")" "$(human "$chain" "$burn")"
    done

  echo ""
  printf "  %-10s %-44s %-14s %-12s %-9s %s\n" "CHAIN" "WALLET" "BALANCE" "BURN/24H" "RUNWAY" "AGENTS"
  jq -r 'map(select(.bot != "-")) | group_by(.chain + .bot)[] |
    "\(.[0].chain)|\(.[0].bot)|\(map(.burn24h | tonumber) | add)|\(map(.agent) | join(", "))"' "$STORE" |
    while IFS='|' read -r chain wallet burn agents; do
      local bal burn_h runway
      bal=$(balance_of "$chain" "$wallet")
      burn_h=$(human "$chain" "$burn")
      runway=$(awk -v bal="$bal" -v burn="$burn_h" 'BEGIN {if (burn > 0) printf "%.1fd", bal / burn; else print "-"}')
      printf "  %-10s %-44s %-14s %-12s %-9s %s\n" "$chain" "$wallet" "$(printf '%.8f' "$bal") $(chain_unit "$chain")" "$burn_h" "$runway" "$agents"
    done

  shared_check $(jq -r '.[] | select(.bot != "-") | "\(.chain)|\(.bot)|\(.agent)"' "$STORE")
}

# ─── Discovery ───────────────────────────────────────────────────

# scan_chain <chain> <out>: every log from the chain's targets in the last 24h, one call per chunk.
# Writes "address block txIndex" lines.
scan_chain() {
  local chain=$1 out=$2 rpc chunk head head_ts probe probe_ts min_block targets_json
  rpc=$(chain_rpc "$chain")
  chunk=$(chain_chunk "$chain")
  targets_json=$(printf '%s\n' "${AGENTS[@]}" | awk -F'|' -v c="$chain" '$2 == c {print $3}' | tr ',' '\n' | sed 's/.*/"&"/' | paste -sd, -)

  head=$(cast block-number --rpc-url "$rpc" 2>/dev/null) || return
  head_ts=$(cast block "$head" -f timestamp --rpc-url "$rpc" 2>/dev/null)
  probe=$((head > chunk ? head - chunk : 0))
  probe_ts=$(cast block "$probe" -f timestamp --rpc-url "$rpc" 2>/dev/null)
  # 24h in blocks, from this chain's measured block time
  min_block=$((head - LOOKBACK_SEC * (head - probe) / (head_ts - probe_ts + 1)))
  ((min_block < 0)) && min_block=0

  local to=$head from
  while ((to >= min_block)); do
    from=$((to - chunk + 1))
    ((from < min_block)) && from=$min_block
    local logs
    if ! logs=$(cast rpc eth_getLogs "$(printf '{"fromBlock":"0x%x","toBlock":"0x%x","address":[%s]}' "$from" "$to" "$targets_json")" --rpc-url "$rpc" 2>&1); then
      echo "  WARN $chain logs $from-$to failed: ${logs:0:120}" >&2
      logs="[]"
    fi
    echo "$logs" | jq -r '.[] | "\(.address) \(.blockNumber) \(.transactionIndex)"' 2>/dev/null |
      while read -r a b i; do echo "$(echo "$a" | tr 'A-F' 'a-f') $((16#${b#0x})) $i"; done >>"$out"
    to=$((from - 1))
  done
}

# evm_agent <agent> <chain> <targets> <logs> <out>
# All 24h txs to the targets; samples the newest SAMPLE for the dominant direct caller and its cost.
# Writes "agent|chain|bot|share|tx24h|costPerTx|burn24h|lastTs".
evm_agent() {
  local agent=$1 chain=$2 targets=$3 logs=$4 out=$5 rpc
  rpc=$(chain_rpc "$chain")
  local targets_lc refs total
  targets_lc=$(echo "$targets" | tr ',' '\n')
  refs=$(grep -F -f <(echo "$targets_lc") "$logs" 2>/dev/null | awk '{print $2, $3}' | sort -u | sort -rn -k1,1)
  total=$(echo -n "$refs" | grep -c . || true)

  local calls="" seen=0 n=0
  while read -r b i; do
    [ -z "$b" ] && continue
    # SAMPLE direct calls, but look past users' indirect traffic on shared contracts (bounded)
    ((n >= SAMPLE || seen >= SAMPLE * 5)) && break
    seen=$((seen + 1))
    local tx txfrom txto hash cost
    tx=$(cast rpc eth_getTransactionByBlockNumberAndIndex "$(printf '0x%x' "$b")" "$i" --rpc-url "$rpc" 2>/dev/null) || continue
    txfrom=$(echo "$tx" | jq -r '.from' | tr 'A-F' 'a-f')
    txto=$(echo "$tx" | jq -r '.to // ""' | tr 'A-F' 'a-f')
    grep -qx "$txto" <<<"$targets_lc" || continue # direct calls only
    hash=$(echo "$tx" | jq -r '.hash')
    # the hash as this RPC reports it (Hydration nodes disagree on hashes)
    cost=$(cast rpc eth_getTransactionReceipt "$hash" --rpc-url "$rpc" 2>/dev/null |
      jq -r 'if . == null then "" else "\(.gasUsed) \(.effectiveGasPrice)" end' 2>/dev/null |
      while read -r g p; do [ -n "$g" ] && echo $((g * p)); done)
    calls+="$txfrom $b ${cost:-}"$'\n'
    n=$((n + 1))
  done <<<"$refs"

  if ((n == 0)); then
    echo "$agent|$chain|-|0/$seen|0|-|0|0" >"$out"
    return
  fi

  local top bot hits last_block last_ts avg tx24 burn
  top=$(echo -n "$calls" | awk '{print $1}' | sort | uniq -c | sort -rn | head -1)
  hits=$(echo "$top" | awk '{print $1}')
  bot=$(echo "$top" | awk '{print $2}')
  last_block=$(echo -n "$calls" | awk -v b="$bot" '$1 == b {print $2}' | sort -rn | head -1)
  last_ts=$(cast block "$last_block" -f timestamp --rpc-url "$rpc" 2>/dev/null)
  avg=$(echo -n "$calls" | awk -v b="$bot" '$1 == b && $3 != "" {s += $3; c++} END {if (c) printf "%.0f", s / c}')
  # 24h txs to the targets, scaled by the bot's share of the sampled ones
  tx24=$(awk -v t="$total" -v h="$hits" -v s="$seen" 'BEGIN {printf "%.0f", t * h / s}')
  burn=$(awk -v n="$tx24" -v a="${avg:-0}" 'BEGIN {printf "%.0f", n * a}')
  echo "$agent|$chain|$bot|$hits/$seen|$tx24|${avg:--}|$burn|$last_ts" >"$out"
}

# solana_agent <out>: fee payer of the program's last-24h transactions, with fees from tx meta.
solana_agent() {
  local out=$1 since sigs total
  since=$(($(date +%s) - LOOKBACK_SEC))
  sigs=$(sol_rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"$SOLANA_PROGRAM\",{\"limit\":1000}]}" |
    jq -r --argjson s "$since" '.result[] | select(.err == null and .blockTime >= $s) | "\(.signature) \(.blockTime)"' 2>/dev/null)
  total=$(echo -n "$sigs" | grep -c . || true)

  local payers="" n=0
  while read -r sig bt; do
    [ -z "$sig" ] && continue
    ((n >= SAMPLE)) && break
    local row
    row=$(sol_rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",\"params\":[\"$sig\",{\"encoding\":\"json\",\"maxSupportedTransactionVersion\":0}]}" |
      jq -r '"\(.result.transaction.message.accountKeys[0] // "") \(.result.meta.fee // 0)"' 2>/dev/null)
    [ -z "${row%% *}" ] && continue
    payers+="${row%% *} $bt ${row##* }"$'\n'
    n=$((n + 1))
  done <<<"$sigs"

  if ((n == 0)); then
    echo "$SOLANA_AGENT|solana|-|0/0|0|-|0|0" >"$out"
    return
  fi

  local top bot hits last_ts avg tx24 burn
  top=$(echo -n "$payers" | awk '{print $1}' | sort | uniq -c | sort -rn | head -1)
  hits=$(echo "$top" | awk '{print $1}')
  bot=$(echo "$top" | awk '{print $2}')
  last_ts=$(echo -n "$payers" | awk -v b="$bot" '$1 == b {print $2}' | sort -rn | head -1)
  avg=$(echo -n "$payers" | awk -v b="$bot" '$1 == b {s += $3; c++} END {printf "%.0f", s / c}')
  tx24=$(awk -v t="$total" -v h="$hits" -v s="$n" 'BEGIN {printf "%.0f", t * h / s}')
  burn=$(awk -v n="$tx24" -v a="$avg" 'BEGIN {printf "%.0f", n * a}')
  echo "$SOLANA_AGENT|solana|$bot|$hits/$n|$tx24|$avg|$burn|$last_ts" >"$out"
}

discover() {
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  echo "=== Discovering agent bots (dominant direct caller, last 24h) ==="

  # one log scan per chain, all chains at once
  for chain in hydration ethereum robinhood; do
    : >"$tmp/$chain.logs"
    scan_chain "$chain" "$tmp/$chain.logs" &
  done
  solana_agent "$tmp/agent.solana" &
  wait

  # per-agent sampling, all agents at once
  local k=0
  for row in "${AGENTS[@]}"; do
    IFS='|' read -r agent chain targets <<<"$row"
    evm_agent "$agent" "$chain" "$targets" "$tmp/$chain.logs" "$tmp/agent.$k" &
    k=$((k + 1))
  done
  wait

  # store: one object per agent; timestamps are unix ms
  local now_ms f
  now_ms=$(($(date +%s) * 1000))
  for f in "$tmp/agent.solana" $(ls "$tmp"/agent.[0-9]* | sort -t. -k2 -n); do cat "$f"; echo; done |
    jq -R -s --argjson now "$now_ms" '[split("\n")[] | select(length > 0) | split("|") |
      {agent: .[0], chain: .[1], bot: .[2], share: .[3], tx24h: (.[4] | tonumber),
       costPerTx: .[5], burn24h: .[6], lastActionAt: ((.[7] | tonumber) * 1000), discoveredAt: $now}]' >"$STORE"
  echo "  wrote $STORE"
  echo ""
}

# ─── Report ──────────────────────────────────────────────────────

if [ "${1:-}" = "--discover" ] || [ ! -s "$STORE" ]; then discover; fi
report
