import { fromSeq, opt, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the existing
 * queue and missed-VAA cursors, and the worker then rescans from FROM_SEQUENCE. Overridable only so
 * a second deployment can run beside the live one.
 */
export const APP_NAME = opt("APP_NAME", "intent-v2-relayer");

export const RPC_ETHEREUM = rpc("ethereum", "https://eth.llamarpc.com");

/**
 * Cold-start floor; ignored once a safeSequence exists in Redis.
 *
 * The transceiver is the WETH rail's, so everything it published before the dispatcher existed is a
 * plain transfer or a v1 settlement — work whose only outcome is "skip". Set FROM_SEQ_HYDRATION to
 * its sequence at the dispatcher's deploy before the namespace's first run.
 */
export const FROM_SEQUENCE = { [WORMHOLE.hydration]: fromSeq("hydration") };

/**
 * Retry an order that is not deliverable yet or not payable yet — rate-limit queued, gas above the
 * order's maxRelayFee. Backoff is min(2^attempt * base, max): 2, 4, … 64 min, then 70 min a time,
 * about eight hours in all.
 *
 * No age cap, unlike v1: the ETH has to reach the order's NEAR account even after its price has
 * expired, since that is where the next order buys it or the refund returns it from. Undelivered, it
 * sits on Ethereum until someone processes it by hand.
 */
export const RETRIES = 12;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 70 * 60_000;
