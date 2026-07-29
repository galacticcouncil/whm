/**
 * Protocol-owned MRL amounts to rescue from Hydration's Moonbeam sovereign account
 * (0x7369626CF2070000000000000000000000000000) via the Wormhole TokenBridge — same mechanism
 * as the $110 trial (probes/exitAssets.ts + payloads.ts), only sized to the protocol's share.
 *
 * NO Hydration-side action: the physical bridged ERC20s sit in the SA regardless of whether the
 * protocol holds them on Hydration as raw balance, aToken, or pool share. We transfer the SA's
 * tokens directly; user assets stay in the SA backing their own representations.
 *
 * Amounts = "Total owned" from garden wiki/note-mrl-protocol-ownership (block 13,358,098, 2026-07-28).
 * ⚠️ These are display-rounded snapshot figures and DRIFT DAILY. RE-DERIVE to full precision at a
 * fresh pinned block before submission, and apply the safety haircut below on the tight-ownership
 * assets so the atomic batchAll can never overshoot the SA's physical balance and revert.
 *
 * Governor tiers (Moonbeam WH chain 16, $1M/24h notional, $100k big-transfer bypass):
 *   big  (≥$100k, bypasses cap): PRIME, WBTC, EURC, USDT, USDC, SOL
 *   small (<$100k, shared daily): WETH, SUI, jitoSOL, sUSDS, DAI  (Σ ≈ $262k)
 */
import type { ExitAsset } from "./exitAssets";

// protocol-owned tokens per asset (human units) — see note-mrl-protocol-ownership §2 "Total owned"
export const PROTOCOL_OWNED: Record<string, number> = {
  PRIME:   2_703_091,   // big  ~$2.84M  (690 direct + 2,413,246 aPRIME + 289,155 via 2-Pool-PRIME)
  WBTC:    10.57,       // big  ~$673k   (5.57 direct + 5.00 aWBTC)   — 83.4% of supply, tight
  EURC:    222_603,     // big  ~$254k   (mostly via 45.96% of 2-Pool-HEURC, aEURC-backed)
  USDT:    194_234,     // big  ~$194k   (via 3-Pool-MRL) — 97.1% of supply, TIGHTEST
  USDC:    154_351,     // big  ~$155k   (via 3-Pool-MRL) — 83.4% of supply, tight
  SOL:     1_668.0,     // big  ~$124k
  WETH:    44.4,        // small ~$85k   (via ~100% of 2-Pool-WETH) — 74.2% of supply
  SUI:     109_461,     // small ~$76k   (via 57.26% Omnipool protocol shares)
  jitoSOL: 609.8,       // small ~$58k
  sUSDS:   34_507,      // small ~$38k — re-derived @13,358,797 (Ben's 38,557 was stale); ACTIVELY DRAINING ~3k/hr, re-derive at submit
  DAI:     294,         // small ~$0.3k  (8% of a near-dead 3,665-token supply)
};

/**
 * Raw native-decimal amount for one asset, floored to Wormhole's 8-dp normalization (dust below
 * 8dp is trimmed and would strand). Optional haircut (bps) shaves the tight assets to guarantee the
 * SA physical balance covers it — apply before real submission.
 */
export function rescueRaw(a: ExitAsset, haircutBps = 0): bigint {
  const owned = PROTOCOL_OWNED[a.sym];
  if (owned === undefined) throw new Error(`no protocol-owned amount for ${a.sym}`);
  return rawFromHuman(a, owned * (1 - haircutBps / 10_000));
}

/** human token amount → raw native-decimal, floored to Wormhole 8-dp normalization (8dp-aligned). */
export function rawFromHuman(a: ExitAsset, human: number): bigint {
  const at8dp = BigInt(Math.floor(human * 1e8));
  return a.decimals >= 8 ? at8dp * 10n ** BigInt(a.decimals - 8) : at8dp / 10n ** BigInt(8 - a.decimals);
}

/**
 * Split plan: each listed large asset becomes 2 legs — an "immediate" leg <$100k that clears NOW
 * against the shared $1M/24h daily budget ("has to pass"), and the big remainder that rides the
 * Governor enqueue/bypass ~24h ("can get stuck", races the Moonbeam sunset). Value below = the
 * immediate leg in human tokens; remainder = protocol-owned − immediate.
 *   PRIME/WBTC/EURC (≥$200k): remainder stays ≥$100k ⇒ bypasses the cap.
 *   USDT/USDC/SOL ($100–200k): remainder is <$100k ⇒ also budget-path, queues if budget is spent.
 * Sizing goal: ~$250k of TRUE TAIL headroom — i.e. Σ of EVERY budget-touching transfer ≤ ~$630k
 * under the ~$879k free. Achieved by keeping every remainder ≥$100k so it BYPASSES (no budget draw):
 * the only budget draw is then the 11 immediate legs + native smalls ≈ $628k. USDC/SOL immediate
 * legs are kept small precisely so their remainders clear $100k and bypass (no budget-queue legs).
 * Native smalls (WETH/SUI/jitoSOL/sUSDS/DAI ≈ $257k) are single immediate transfers (already <$100k).
 */
export const IMMEDIATE_LEG: Record<string, number> = {
  PRIME: 73_000, // ~$76.7k · remainder ~2,630,077 (~$2.76m, bypass)
  WBTC:  1.21,   // ~$77.1k · remainder ~9.36 (~$596k, bypass)
  EURC:  67_000, // ~$76.5k · remainder ~155,603 (~$178k, bypass)
  USDT:  77_000, // ~$77.1k · remainder ~117,234 (~$117k, bypass)
  USDC:  50_000, // ~$50.1k · remainder ~104,351 (~$105k, bypass — small leg keeps remainder >$100k)
  SOL:   180,    // ~$13.4k · remainder ~1,488 (~$111k, bypass — SOL volatile, re-verify >$100k at submit)
};
