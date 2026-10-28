import { fromSeq, onOff, opt, optWhole, req, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespaces. LOAD-BEARING — every Redis key derives from them, and the two processes must
 * not share one: a shared name puts both on one queue and one set of missed-VAA cursors.
 */
export const APP_NAME_HYDRATION = opt("APP_NAME_PSM_HYDRATION", "psm-hydration-relayer");
export const APP_NAME_BASE = opt("APP_NAME_PSM_BASE", "psm-base-relayer");

export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");

/** psm-base's RPC, required: no public default serves the `eth_getLogs` its vault watcher needs. */
export function rpcBase(): string {
  return req("RPC_BASE");
}

/**
 * The psm services' alert sink, required: the keepers' and watchers' alerts go nowhere else, so a
 * missing or placeholder URL stops the start instead of leaving every alert in the log.
 */
export function psmWebhook(): string {
  const value = req("DISCORD_WEBHOOK_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DISCORD_WEBHOOK_URL is not a URL");
  }
  if (url.protocol !== "https:") throw new Error(`DISCORD_WEBHOOK_URL must be https, got ${url.protocol}`);
  return value;
}

/**
 * Some failures here are transient by design, and the contracts keep the VAA replayable through
 * them: the vault refuses to send back a redemption that landed above its fee limit while claims
 * are paused (`ClaimsPaused`) and expects the delivery to land once they resume
 * (`docs/psm/spec.md`, "A redemption carries its own fee limit"); neither receiver takes a message
 * before its emitter is bound (a VAA from the real emitter meets `NotAuthorizedEmitter` first,
 * because the emitter check runs before `_processMessage` and the mapping is still empty;
 * `EmitterNotSet` is for a VAA that carries a zero emitter). So the budget spans an incident, as
 * basejump's does, not a blip.
 *
 * It takes both numbers. Without a backoff the engine adds no delay between attempts —
 * relayer-engine's `redis-storage` gives a job BullMQ's custom backoff only when `retryBackoffOptions`
 * is set, and a BullMQ job without one is retried at once — so ntt's and oracle's 8 attempts are
 * spent in seconds. Here the backoff is min(2^attempt * base, max), attempt from 1: 2, 4, 8, 16, 30,
 * 30, … min — 250 attempts is 5.1 days. A job that exhausts it parks in `failed` and nothing
 * re-queues it, a restart included (the spy does not replay, the missed-VAA worker counts the
 * sequence as seen, and BullMQ ignores an add for a job id that exists); the VAA stays deliverable
 * on chain, so recovery is a manual `receiveMessage` of the same bytes, which anyone may send.
 */
export const RETRIES = 250;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;

/**
 * Cold-start floor per source chain — missed-VAA cursors are keyed by (source chain, source
 * emitter), not by destination, so each constant is named for the source chain it is a floor
 * FOR, matching the env var it reads (`fromSeq("base")` reads `FROM_SEQ_BASE`), not for the
 * destination process that happens to consume it. A destination-keyed name here would be an
 * operator trap: the process serving Hydration as a destination consumes the floor for Base as a
 * SOURCE, so naming that constant after the destination points an operator setting `FROM_SEQ_BASE`
 * at the right env var but the wrong mental model of what it configures.
 *
 * The default floor is zero, and zero does not reach sequence 0: the missed-VAA worker's look-ahead
 * only considers sequences above the floor, and a later scan only the gaps between sequences it has
 * seen (relayer-engine 0.3.2, `missedVaasV3/check.js`). An emitter's first message is therefore
 * delivered only if the process was already running and subscribed when it was published, so both
 * processes go live before the vault's deposits open: every message either emitter sends follows a
 * deposit.
 */
export const FROM_SEQUENCE_FROM_BASE = { [WORMHOLE.base]: fromSeq("base") };
export const FROM_SEQUENCE_FROM_HYDRATION = { [WORMHOLE.hydration]: fromSeq("hydration") };

// ─── Keepers and watchers ─────────────────────────────────────────

/**
 * Whether the keepers send. Off stops this wallet's `drain` and `flushPendingMint` only: both are
 * permissionless, so anyone else can still send them, and the watchers keep alerting either way.
 * The incident lever for payouts and mints is the on-chain pause.
 */
export const KEEPER_ENABLED = onOff("PSM_KEEPER", "on");

/** First pending-mint id the flush keeper reads. Ids are never reused, so a floor saves the walk. */
export const FLUSH_FROM_ID = optWhole("PSM_FLUSH_FROM_ID", 0n);

/** How long each keeper and watcher waits between looks at chain state. */
export const KEEPER_INTERVAL_MS = 60_000;

/** Entries one `drain` may settle: about 60k gas plus 260k per entry paid out of Aave. */
export const DRAIN_MAX_ENTRIES = 10n;

/**
 * A drain's gas limit is at least enough for every entry it may settle: an entry that becomes
 * payable between the estimate and inclusion is settled too, and would run a tight limit out. Gas
 * left over is not charged.
 */
export const DRAIN_GAS_BASE = 100_000n;
export const DRAIN_GAS_PER_ENTRY = 350_000n;

/** New pending-mint ids read per tick, already-read ids re-swept per tick, and flushes per tick. */
export const FLUSH_SCAN_BATCH = 100n;
export const FLUSH_SWEEP_BATCH = 20n;
export const FLUSH_MAX_PER_TICK = 5;

/** An unchanged alert repeats at most this often. */
export const ALERT_REPEAT_MS = 60 * 60_000;

/** A keeper transaction unmined for this long means the wallet's nonce lane may be stuck. */
export const KEEPER_TX_STUCK_MS = 10 * 60_000;

/** A head held by the reserve's liquidity this long is reported. */
export const LIQUIDITY_STALL_MS = 60 * 60_000;

/**
 * USDC in flight between the chains this long with no delivery landing is reported. The slowest
 * honest message, a vault cancel or a returned redemption published at Base finality, lands in
 * about 20 minutes.
 */
export const BOOKS_STALL_MS = 60 * 60_000;

/** A delivery still failing at this attempt is reported: about half an hour into the backoff. */
export const EARLY_WARNING_ATTEMPT = 5;

/**
 * Vault logs: how far back the watcher looks at startup (`PSM_LOG_LOOKBACK_BLOCKS`, about 4 hours;
 * raise it to restart over a longer outage), how many blocks per query (`PSM_LOG_CHUNK_BLOCKS`,
 * lower for a provider that caps the range), how far each pass re-reads behind the last (for an
 * RPC that answered a range short), and how deep.
 */
export const LOG_LOOKBACK_BLOCKS = optWhole("PSM_LOG_LOOKBACK_BLOCKS", 7_200n);
export const LOG_CHUNK_BLOCKS = optWhole("PSM_LOG_CHUNK_BLOCKS", 1_000n, 1n);
export const LOG_OVERLAP_BLOCKS = 60n;
export const LOG_CONFIRMATIONS = 3n;

/** Reserve below liabilities by more than this, in USDC units, is reported. aUSDC rounds by a unit. */
export const RESERVE_TOLERANCE = 10n;

/**
 * Gas margin on every PSM transaction. Both contracts write `block.timestamp` into storage (the
 * vault's `headSince`, the rate limiters' `lastUpdate`), so an estimate taken in the block that last
 * wrote it prices the write as unchanged and comes in about 2.8k short of the next block.
 */
export const GAS_MARGIN_BPS = 2_000n;
