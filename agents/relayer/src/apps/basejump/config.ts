import { fromSeq, opt, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the existing
 * queue and missed-VAA cursors, and the worker then rescans from FROM_SEQUENCE. Overridable only so
 * a second deployment can run beside the live one.
 */
export const APP_NAME = opt("APP_NAME", "basejump-relayer");

export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");

/**
 * Cold-start floor; ignored once a safeSequence exists in Redis. The emitter counts fast-path
 * messages alone, from zero, so nothing below the floor is ever a payout to skip.
 */
export const FROM_SEQUENCE = { [WORMHOLE.ethereum]: fromSeq("ethereum") };

/**
 * Failures are transient by construction — a shortfall queues, a receiver the TC has not upgraded
 * or armed yet reverts — so the budget spans a governance window. A job that exhausts it parks in
 * `failed` and nothing replays it. Backoff is min(2^attempt * base, max), attempt from 1:
 * 2, 4, 8, 16, 30, 30, … min — 250 attempts is about five days.
 */
export const RETRIES = 250;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;
