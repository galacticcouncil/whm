import { fromSeq, opt, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the existing
 * queue and missed-VAA cursors, and the worker then rescans from FROM_SEQUENCE. Overridable only so
 * a second deployment can run beside the live one.
 */
export const APP_NAME = opt("APP_NAME", "near-ntt-relayer");

/** Read-only: the source tx receipt the account is found in. */
export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");

/** rpc.mainnet.near.org is deprecated and throttles; fastnear is the free default. */
export const RPC_NEAR = rpc("near", "https://free.rpc.fastnear.com");

/** Cold-start floor; ignored once a safeSequence exists in Redis. */
export const FROM_SEQUENCE = { [WORMHOLE.hydration]: fromSeq("hydration") };

/** Total attempts per VAA before the engine gives up. */
export const RETRIES = 8;
