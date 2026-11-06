import { fromSeq, opt, optNum, req, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the existing
 * queue and missed-VAA cursors, and the worker then rescans from FROM_SEQUENCE. Overridable only so
 * a second deployment can run beside the live one.
 */
export const APP_NAME = opt("APP_NAME", "hydration-ntt-relayer");

export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");

/** Total attempts per VAA before the engine gives up. */
export const RETRIES = 8;

/** Cold-start floor per origin chain; ignored once a safeSequence exists in Redis. */
export const FROM_SEQUENCE = {
  [WORMHOLE.ethereum]: fromSeq("ethereum"),
  [WORMHOLE.base]: fromSeq("base"),
  [WORMHOLE.solana]: fromSeq("solana"),
  [WORMHOLE.sui]: fromSeq("sui"),
  [WORMHOLE.near]: fromSeq("near"),
};

/**
 * The `ntt-base` process's namespace. LOAD-BEARING like `APP_NAME`, and distinct from it: a shared
 * name would put both processes on one queue and one set of missed-VAA cursors.
 */
export const APP_NAME_BASE = opt("APP_NAME_NTT_BASE", "ntt-base-relayer");

export const RPC_BASE = rpc("base", "https://mainnet.base.org");

/**
 * Cold-start floor for the Hydration emitters `ntt-base` subscribes to, from `FROM_SEQ_HYDRATION`,
 * which is REQUIRED here (no `0` fallback): the EURC transceiver was busy long before this process,
 * and on chain 73 an unfloored missed-VAA walk never terminates (see the README). A function, so
 * the `ntt` app, which imports this module, never reads it.
 *
 * @throws When unset, or not an integer.
 */
export function fromSequenceFromHydration() {
  const raw = req("FROM_SEQ_HYDRATION").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`FROM_SEQ_HYDRATION is not a sequence number: ${raw}`);
  return { [WORMHOLE.hydration]: BigInt(raw) };
}

/**
 * How old a Hydration -> Base VAA must be before `ntt-base` acts on it, from the VAA's own
 * timestamp (the Hydration block time the guardians sign). `ntt-base` is a backstop: the user's
 * claim or the Wormhole Executor normally delivers first, and acting earlier would race them and
 * make their transaction revert. Measured on the 30 transfers up to sequence 324: automated
 * deliveries at 57-101 s, self-claims at 107-141 s, one at 615 s (Wormholescan, 2026-11-07). 15 min
 * clears all of them.
 * `NTT_BASE_GRACE_SECONDS` overrides it. A VAA under the grace period is thrown back to the engine,
 * whose backoff runs at about +2, +6, +14 and +30 min, so at 900 s the first real attempt comes about
 * 30 min after the transfer (4 of the 50 runs spent waiting).
 */
export const GRACE_SECONDS = optNum("NTT_BASE_GRACE_SECONDS", 15 * 60);

/**
 * `ntt-base`'s retry policy. Unlike `RETRIES` above it carries a backoff: without one the engine
 * retries at once and 8 attempts are spent in seconds (see `apps/psm/config.ts`), so a Base RPC
 * outage would park a transfer in the failed set. min(2^attempt * 1 min, 30 min), attempt from 1:
 * 2, 4, 8, 16, 30, 30, ... min, so 50 attempts is about 23 hours. The last one alerts. A job past
 * that stays deliverable by hand — `receiveMessage` is permissionless.
 */
export const RETRIES_BASE = 50;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;
