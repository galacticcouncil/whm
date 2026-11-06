import { fromSeq, opt, rpc } from "../../config";
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
 * Cold-start floor for the Hydration emitters `ntt-base` subscribes to. Set `FROM_SEQ_HYDRATION`
 * before the namespace's first run: the EURC transceiver was busy long before this process, and on
 * chain 73 an unfloored missed-VAA walk never terminates (see the README).
 */
export const FROM_SEQUENCE_FROM_HYDRATION = { [WORMHOLE.hydration]: fromSeq("hydration") };

/**
 * `ntt-base`'s retry policy. Unlike `RETRIES` above it carries a backoff: without one the engine
 * retries at once and 8 attempts are spent in seconds (see `apps/psm/config.ts`), so a Base RPC
 * outage would park a transfer in the failed set. min(2^attempt * 1 min, 30 min): 50 attempts is
 * about 23.5 hours. A job past that stays deliverable by hand — `receiveMessage` is permissionless.
 */
export const RETRIES_BASE = 50;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;
